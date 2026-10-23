// Spec 0015 CI5, CI6, CI9: after key destruction commits, every process forgets that tenant's unwrapped DEKs.
//   • KeyForgetListener: in every API and worker process, `uv:keys:forget` → TenantKeyring.forget(tenantId).
//   • notifyKeysDestroyed: the destroying process forgets locally, then publishes (bounded, never throws) and
//     reports what is KNOWN: receivers (PUBLISH's count, not a confirmation) or "delivery unconfirmed", plus the
//     fallback deadline (destruction time + the shared key-cache TTL ceiling) and the restart guidance.
//   • shredTenantKeys and destroyRetired: the ONLY production paths to key destruction (`destroyTenantKeys`,
//     `destroyRetiredKey`); they notify only after the destruction committed and destroyed something (CI9).
//   • Spec 0020 D14: every destruction carries the host protocol's op, and in production runs only as that op's job.
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { adoptDestruction, destroyRetiredKey, destroyTenantKeys, KEYRING_MAX_TTL_MS, reapplyDestruction, TenantKeyring } from '@univarse/crypto';
import type { PlatformClient } from '@univarse/db';
import { APP_CONFIG, type AppConfig } from '../../config/config.js';
import { PLATFORM_DB } from '../db/db.module.js';
import { CHANNELS, InvalidationBus } from '../infra/invalidation-bus.js';

@Injectable()
export class KeyForgetListener implements OnModuleInit {
  constructor(
    private readonly bus: InvalidationBus,
    private readonly keyring: TenantKeyring,
  ) {}

  onModuleInit(): void {
    this.bus.on(CHANNELS.keysForget, (tenantId) => this.keyring.forget(tenantId));
  }
}

export interface ForgetReport {
  readonly tenantId: string;
  /** PUBLISH's count of subscriber connections that received the message, or null when delivery is unconfirmed. */
  readonly receivers: number | null;
  /** The latest moment any process can still hold the destroyed key in memory. */
  readonly fallbackDeadline: Date;
  readonly lines: readonly string[];
}

/**
 * Spec 0020 (where the database step runs): why this process may not destroy keys for `op`, or null. In production a
 * destruction runs only as the host protocol's one-shot job, which is started with that op (UNIVARSE_DESTRUCTION_OP);
 * any other path (an in-app call, a CLI run by hand) is refused before anything is read.
 */
export function destructionJobProblem(op: string, config: Pick<AppConfig, 'NODE_ENV' | 'UNIVARSE_DESTRUCTION_OP'>): string | null {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(op)) return 'the destruction op must be a UUID';
  if (config.NODE_ENV !== 'production') return null;
  if (!config.UNIVARSE_DESTRUCTION_OP) return 'in production, keys are destroyed only by the destruction job (stack:keys destroy)';
  if (config.UNIVARSE_DESTRUCTION_OP.toLowerCase() !== op.toLowerCase()) return "the op is not this destruction job's op";
  return null;
}

export class DestructionRefusedError extends Error {
  constructor(why: string) {
    super(`Key destruction refused: ${why}`);
    this.name = 'DestructionRefusedError';
  }
}

@Injectable()
export class KeyDestruction {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(PLATFORM_DB) private readonly platform: PlatformClient,
    private readonly keyring: TenantKeyring,
    private readonly bus: InvalidationBus,
  ) {}

  /** Call only after a destruction COMMITTED. Forgets locally, publishes, and reports honestly (CI6). */
  async notifyKeysDestroyed(tenantId: string, destroyedAt = new Date()): Promise<ForgetReport> {
    this.keyring.forget(tenantId);
    const r = await this.bus.publish(CHANNELS.keysForget, tenantId);
    // The SHARED ceiling every keyring enforces, not this process's TTL: a receiver may run a longer TTL than the
    // sender, up to the ceiling (owner review of #66). No deployment-wide shorter bound is established.
    const fallbackDeadline = new Date(destroyedAt.getTime() + KEYRING_MAX_TTL_MS);
    const lines = [
      r.delivered
        ? `forget published: received by ${String(r.receivers)} subscriber connection(s); this is not a confirmation that they forgot`
        : `forget NOT published (${r.reason}): delivery unconfirmed`,
      `fallback deadline: every process drops the destroyed key by ${fallbackDeadline.toISOString()} (destruction time + the ${String(KEYRING_MAX_TTL_MS / 60_000)} min ceiling on any key-cache TTL)`,
      'to forget at once: restart the API and the worker',
    ];
    return { tenantId, receivers: r.delivered ? r.receivers : null, fallbackDeadline, lines };
  }

  /**
   * E10 crypto-shredding of a whole tenant (spec 0015 CI9): destroys every live DEK, then notifies, only if the
   * destruction committed and destroyed something. A rollback throws before any notice; a no-op (including a repeat
   * of the same op) notifies nothing.
   */
  async shredTenantKeys(
    tenantId: string,
    actorId: string | null,
    reason: string,
    { op }: { op: string },
  ): Promise<{ destroyed: number; report: ForgetReport | null }> {
    this.refuseOutsideJob(op);
    const destroyed = await destroyTenantKeys(this.platform, tenantId, actorId, reason, { op });
    if (destroyed === 0) return { destroyed, report: null };
    return { destroyed, report: await this.notifyKeysDestroyed(tenantId) };
  }

  /**
   * E7 destruction of one retired version (spec 0020 D14, D15), with the configured grace period; notifies only
   * after it committed. A refusal (RetiredKeyInUseError) or a rollback throws before any notice; a repeat of the
   * same op returns `destroyed: false`.
   */
  async destroyRetired(
    tenantId: string,
    version: number,
    countValues: (version: number) => Promise<number>,
    opts: { op: string; actorId: string | null; reason: string },
  ): Promise<{ destroyed: boolean; report: ForgetReport | null }> {
    this.refuseOutsideJob(opts.op);
    const destroyed = await destroyRetiredKey(this.platform, tenantId, version, countValues, {
      ...opts,
      graceMs: this.config.RETIRED_KEY_GRACE_MS,
    });
    if (!destroyed) return { destroyed, report: null };
    return { destroyed, report: await this.notifyKeysDestroyed(tenantId) };
  }

  /**
   * Spec 0020 D8: re-applies an ACCEPTED destruction after a restore brought its keys back (no precondition: it was
   * already accepted). Notifies only when it destroyed something; production-guarded by the op like the others.
   */
  async reapply(d: {
    op: string;
    tenantId: string;
    kind: 'TENANT' | 'RETIRED';
    versions: readonly number[];
    actorId: string | null;
    reason: string;
  }): Promise<{ destroyed: number[]; recorded: boolean; activeDestroyed: boolean; report: ForgetReport | null }> {
    this.refuseOutsideJob(d.op);
    const r = await reapplyDestruction(this.platform, d);
    return { ...r, report: r.destroyed.length ? await this.notifyKeysDestroyed(d.tenantId) : null };
  }

  /** Spec 0020 (owner's review of A2): records a pre-ledger destruction at init; destroys nothing. Job-guarded. */
  async adopt(d: { op: string; tenantId: string; kind: 'TENANT' | 'RETIRED'; versions: readonly number[]; actorId: string | null; reason: string }): Promise<{ recorded: boolean }> {
    this.refuseOutsideJob(d.op);
    return adoptDestruction(this.platform, d);
  }

  private refuseOutsideJob(op: string): void {
    const why = destructionJobProblem(op, this.config);
    if (why) throw new DestructionRefusedError(why);
  }
}
