// Spec 0015 CI5, CI6, CI9: after key destruction commits, every process forgets that tenant's unwrapped DEKs.
//   • KeyForgetListener: in every API and worker process, `uv:keys:forget` → TenantKeyring.forget(tenantId).
//   • notifyKeysDestroyed: the destroying process forgets locally, then publishes (bounded, never throws) and
//     reports what is KNOWN: receivers (PUBLISH's count, not a confirmation) or "delivery unconfirmed", plus the
//     fallback deadline (destruction time + the shared key-cache TTL ceiling) and the restart guidance.
//   • shredTenantKeys: the ONLY production path to full-tenant destruction (`destroyTenantKeys`); it notifies only
//     after the destruction committed and destroyed something (CI9).
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { destroyTenantKeys, KEYRING_MAX_TTL_MS, TenantKeyring } from '@univarse/crypto';
import type { PlatformClient } from '@univarse/db';
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

@Injectable()
export class KeyDestruction {
  constructor(
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
   * destruction committed and destroyed something. A rollback throws before any notice; a no-op notifies nothing.
   */
  async shredTenantKeys(
    tenantId: string,
    actorId: string | null,
    reason: string,
  ): Promise<{ destroyed: number; report: ForgetReport | null }> {
    const destroyed = await destroyTenantKeys(this.platform, tenantId, actorId, reason);
    if (destroyed === 0) return { destroyed, report: null };
    return { destroyed, report: await this.notifyKeysDestroyed(tenantId) };
  }
}
