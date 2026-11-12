// Spec 0034 Q5, Q8: the eight steps, run by the worker for one job. Every step is idempotent on natural keys, so a step
// interrupted anywhere runs again safely; each records its own row, so a resumed job starts at the first step not done.
// The job's tenant is the only tenant any step touches: it comes from the job row, never from the queue's data, and
// every tenant-side write goes through `ShardRegistry.tx` for that tenant (invariant 1, Q14).
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ALWAYS_ON, isSettingKey, SETTINGS } from '@univarse/contracts';
import { KeyUnavailableError, openInvite, provisionTenantKey, writePlatformAudit, type KeyProvider } from '@univarse/crypto';
import { seedTenantBase, type PlatformClient } from '@univarse/db';
import { isTemplateId, nextStep, statusBeforeStep, TEMPLATES, type ProvisioningErrorCode, type ProvisioningStepKey } from '@univarse/domain';
import { APP_CONFIG, type AppConfig } from '../../config/config.js';
import { AuditWriter } from '../../shared/audit/audit-writer.js';
import { PLATFORM_DB, ShardRegistry } from '../../shared/db/db.module.js';
import { Outbox } from '../../shared/outbox/outbox.js';

export const TENANT_KEYS = Symbol('TENANT_KEYS');
export const PROVISIONING_OPEN_KEYS = Symbol('PROVISIONING_OPEN_KEYS');

/** A step's own refusal, with the fixed code the console explains. Permanent: retrying won't change it. */
export class StepRefused extends Error {
  constructor(readonly code: ProvisioningErrorCode) {
    super(code);
    this.name = 'StepRefused';
  }
}

/** Transient failures retried in place before the job fails (Q8): a Vault or database blip. */
const RETRIES = [500, 2_000] as const;

function classify(step: ProvisioningStepKey, err: unknown): { code: ProvisioningErrorCode; transient: boolean } {
  if (err instanceof StepRefused) return { code: err.code, transient: false };
  if (err instanceof KeyUnavailableError) {
    if (step === 'invite' && err.reason === 'unwrap_failed') return { code: 'invite_unreadable', transient: false };
    return { code: 'key_unavailable', transient: err.reason === 'provider_unavailable' };
  }
  const e = err as { code?: unknown; name?: string };
  if (typeof e.code === 'string' && /^P\d{4}$/.test(e.code)) return { code: 'database', transient: true };
  if (e.name?.startsWith('PrismaClient') || e.name === 'DriverAdapterError') return { code: 'database', transient: true };
  return { code: 'unexpected', transient: false };
}

interface JobRow {
  readonly id: string;
  readonly tenantId: string;
  readonly template: string;
  readonly products: string[];
  readonly status: 'QUEUED' | 'RUNNING' | 'FAILED' | 'DONE';
  readonly inviteEnc: string | null;
}

interface TenantRow {
  readonly id: string;
  readonly slug: string;
  readonly legalName: string;
  readonly status: string;
  readonly shardId: string;
}

@Injectable()
export class ProvisioningRunner {
  private readonly logger = new Logger('Provisioning');

  constructor(
    @Inject(PLATFORM_DB) private readonly platform: PlatformClient,
    private readonly shards: ShardRegistry,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(TENANT_KEYS) private readonly tenantKeys: KeyProvider,
    @Inject(PROVISIONING_OPEN_KEYS) private readonly inviteKeys: KeyProvider,
    /** Tests: no waiting between retries. */
    @Inject('PROVISIONING_RETRY_DELAYS') private readonly retryDelays: readonly number[] = RETRIES,
  ) {}

  /** Runs a job's remaining steps. A FAILED job waits for the console's resume; a DONE one has nothing left. */
  async run(jobId: string): Promise<'done' | 'failed' | 'skipped'> {
    const claimed = await this.platform.provisioningJob.updateMany({ where: { id: jobId, status: { in: ['QUEUED', 'RUNNING'] } }, data: { status: 'RUNNING' } });
    if (claimed.count !== 1) return 'skipped';
    for (;;) {
      const done = await this.platform.provisioningStep.findMany({ where: { jobId, status: 'DONE' }, select: { step: true } });
      const step = nextStep(new Set(done.map((d) => d.step as ProvisioningStepKey)));
      if (step === null) return 'done';
      const outcome = await this.runStep(jobId, step);
      if (outcome === 'failed') return 'failed';
      if (step === 'done') return 'done';
    }
  }

  private async runStep(jobId: string, step: ProvisioningStepKey): Promise<'ok' | 'failed'> {
    const existing = await this.platform.provisioningStep.findUnique({ where: { jobId_step: { jobId, step } }, select: { id: true, attempts: true } });
    const row = existing
      ? await this.platform.provisioningStep.update({ where: { id: existing.id }, data: { status: 'RUNNING', attempts: { increment: 1 }, errorCode: null, startedAt: new Date(), finishedAt: null }, select: { id: true } })
      : await this.platform.provisioningStep.create({ data: { jobId, step, status: 'RUNNING' }, select: { id: true } });
    for (let attempt = 0; ; attempt++) {
      try {
        const job = await this.loadJob(jobId);
        const tenant = await this.loadTenant(job.tenantId, step);
        if (step === 'done') {
          await this.finish(job, tenant, row.id);
        } else {
          await this.execute(step, job, tenant);
          await this.platform.provisioningStep.update({ where: { id: row.id }, data: { status: 'DONE', finishedAt: new Date() }, select: { id: true } });
        }
        return 'ok';
      } catch (err) {
        const { code, transient } = classify(step, err);
        const delay = this.retryDelays[attempt];
        if (transient && delay !== undefined) {
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        this.logger.warn({ event: 'provisioning.step_failed', jobId, step, code, error: err instanceof Error ? err.name : 'unknown' }, 'A provisioning step failed');
        await this.fail(jobId, row.id, step, code);
        return 'failed';
      }
    }
  }

  private async loadJob(jobId: string): Promise<JobRow> {
    const job = await this.platform.provisioningJob.findUniqueOrThrow({ where: { id: jobId }, select: { id: true, tenantId: true, template: true, products: true, status: true, inviteEnc: true } });
    return job;
  }

  /** The job's tenant, in the status this step expects; anything else is a conflict, never a guess. */
  private async loadTenant(tenantId: string, step: ProvisioningStepKey): Promise<TenantRow> {
    const t = await this.platform.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { id: true, slug: true, legalName: true, status: true, shardId: true } });
    const expected = statusBeforeStep(step);
    // `place` may find its own earlier work done (REQUESTED → PROVISIONING happened, the step's row didn't).
    const ok = t.status === expected || (step === 'place' && t.status === 'PROVISIONING');
    if (!ok) throw new StepRefused('state_conflict');
    return t;
  }

  private async execute(step: Exclude<ProvisioningStepKey, 'done'>, job: JobRow, t: TenantRow): Promise<void> {
    switch (step) {
      case 'place':
        return this.place(job, t);
      case 'key':
        await provisionTenantKey(this.platform, this.tenantKeys, t.id);
        return;
      case 'seed':
        await this.shards.tx(t.shardId, t.id, async (tx) => {
          await seedTenantBase(tx, t.id, t.legalName);
          await this.audit.write(tx, t.id, { actorType: 'SYSTEM', actorId: null, action: 'provisioning.seeded', entityType: 'tenant', entityId: t.id, after: { jobId: job.id } });
        });
        return;
      case 'template':
        return this.applyTemplate(job, t);
      case 'host':
        return this.addHost(job, t);
      case 'products':
        return this.setProducts(job, t);
      case 'invite':
        return this.invite(job, t);
    }
  }

  /** Q11: the shard was chosen at creation; here it must answer before anything is written to it. */
  private async place(job: JobRow, t: TenantRow): Promise<void> {
    try {
      const client = await this.shards.client(t.shardId);
      await client.$queryRaw`SELECT 1`;
    } catch {
      throw new StepRefused('shard_unavailable');
    }
    const n = await this.platform.$transaction(async (tx) => {
      const moved = await tx.tenant.updateMany({ where: { id: t.id, status: 'REQUESTED' }, data: { status: 'PROVISIONING' } });
      if (moved.count === 1) await writePlatformAudit(tx, { actorId: null, action: 'platform.tenant.provisioning_started', tenantId: t.id, metadata: { jobId: job.id } });
      return moved.count;
    });
    if (n === 0 && t.status !== 'PROVISIONING') throw new StepRefused('state_conflict');
  }

  /** Q6: only the settings the registry has today; a row already there (an earlier run's) is left as it is. */
  private async applyTemplate(job: JobRow, t: TenantRow): Promise<void> {
    if (!isTemplateId(job.template)) throw new StepRefused('unexpected');
    const template = TEMPLATES[job.template];
    await this.shards.tx(t.shardId, t.id, async (tx) => {
      const written: string[] = [];
      for (const [key, value] of Object.entries(template.settings)) {
        if (!isSettingKey(key)) continue;
        const parsed = SETTINGS[key].schema.parse(value) as object;
        const row = await tx.setting.findFirst({ where: { key, scopeKey: 'INSTITUTION' }, select: { id: true } });
        if (row) continue;
        await tx.setting.create({ data: { tenantId: t.id, key, scopeKey: 'INSTITUTION', value: parsed, version: 1 }, select: { id: true } });
        written.push(key);
      }
      if (written.length > 0) {
        await this.audit.write(tx, t.id, { actorType: 'SYSTEM', actorId: null, action: 'settings.template_applied', entityType: 'tenant', entityId: t.id, after: { template: template.id, templateVersion: template.version, keys: written } });
      }
    });
  }

  /** Q5 step 5: `<slug>.<domain>`, verified (the edge's wildcard serves it). A host held by another tenant stops here. */
  private async addHost(job: JobRow, t: TenantRow): Promise<void> {
    const hostname = `${t.slug}.${this.config.TENANT_DOMAIN}`;
    const held = await this.platform.tenantDomain.findUnique({ where: { hostname }, select: { tenantId: true } });
    if (held && held.tenantId !== t.id) throw new StepRefused('state_conflict');
    if (held) return;
    await this.platform.$transaction(async (tx) => {
      await tx.tenantDomain.create({ data: { tenantId: t.id, hostname, kind: 'SUBDOMAIN', verifiedAt: new Date() }, select: { id: true } });
      await writePlatformAudit(tx, { actorId: null, action: 'platform.tenant.host_added', tenantId: t.id, metadata: { hostname, jobId: job.id } });
    });
  }

  /** Q5 step 6: entitled as chosen; core switched on. A row already there is the console's from then on. */
  private async setProducts(job: JobRow, t: TenantRow): Promise<void> {
    await this.platform.$transaction(async (tx) => {
      const added: string[] = [];
      for (const product of job.products) {
        const row = await tx.tenantProduct.findUnique({ where: { tenantId_product: { tenantId: t.id, product } }, select: { id: true } });
        if (row) continue;
        await tx.tenantProduct.create({ data: { tenantId: t.id, product, entitled: true, enabled: ALWAYS_ON.includes(product as (typeof ALWAYS_ON)[number]) }, select: { id: true } });
        added.push(product);
      }
      if (added.length > 0) await writePlatformAudit(tx, { actorId: null, action: 'platform.tenant.products_set', tenantId: t.id, metadata: { products: added, jobId: job.id } });
    });
  }

  /**
   * Q5 step 7. The account, its role and its one email commit together on the tenant side; then the sealed invite is
   * wiped. Interrupted between the two, the next run finds the account and sends nothing again.
   */
  private async invite(job: JobRow, t: TenantRow): Promise<void> {
    if (job.inviteEnc === null) {
      // Wiped by an earlier run of this step: done if the administrator exists, unreadable otherwise.
      const exists = await this.shards.tx(t.shardId, t.id, (tx) => tx.roleAssignment.findFirst({ where: { revokedAt: null, role: { key: 'INSTITUTION_ADMIN' } }, select: { id: true } }));
      if (exists) return;
      throw new StepRefused('invite_unreadable');
    }
    const admin = await openInvite(this.inviteKeys, t.id, job.inviteEnc);
    const email = admin.email.toLowerCase();
    const username = admin.username.toUpperCase();
    const host = `${t.slug}.${this.config.TENANT_DOMAIN}`;
    const origin = this.config.TENANT_LINK_ORIGIN.replace('{host}', host);
    await this.shards.tx(t.shardId, t.id, async (tx) => {
      const role = await tx.role.findUniqueOrThrow({ where: { tenantId_key: { tenantId: t.id, key: 'INSTITUTION_ADMIN' } }, select: { id: true } });
      let user = await tx.userAccount.findUnique({ where: { tenantId_username: { tenantId: t.id, username } }, select: { id: true, email: true } });
      const created = user === null;
      if (user && user.email !== email) throw new StepRefused('state_conflict');
      user ??= await tx.userAccount.create({ data: { tenantId: t.id, username, email, displayName: admin.displayName }, select: { id: true, email: true } });
      const assigned = await tx.roleAssignment.findFirst({ where: { userId: user.id, roleId: role.id, revokedAt: null }, select: { id: true } });
      if (!assigned) await tx.roleAssignment.create({ data: { tenantId: t.id, userId: user.id, roleId: role.id, scopeType: 'INSTITUTION', reason: 'provisioning' }, select: { id: true } });
      if (created) {
        await this.outbox.enqueueEmail(tx, t.id, {
          to: email,
          subject: `Your UniVarse administrator account for ${t.legalName}`,
          text: [
            `Hello ${admin.displayName},`,
            '',
            `An administrator account has been set up for you at ${t.legalName} on UniVarse.`,
            '',
            `Your username: ${username}`,
            '',
            `To activate it, open ${origin}/activate and enter your username. We'll email you a 6-digit code, then you choose a password and set up an authenticator app.`,
            '',
            'If you weren’t expecting this, ignore this email: nothing happens until the account is activated.',
          ].join('\n'),
        });
        await this.audit.write(tx, t.id, { actorType: 'SYSTEM', actorId: null, action: 'identity.user.invited', entityType: 'user_account', entityId: user.id, after: { role: 'INSTITUTION_ADMIN', jobId: job.id } });
      }
    });
    await this.platform.$transaction(async (tx) => {
      await tx.provisioningJob.update({ where: { id: job.id }, data: { inviteEnc: null }, select: { id: true } });
      await writePlatformAudit(tx, { actorId: null, action: 'platform.tenant.admin_invited', tenantId: t.id, metadata: { jobId: job.id } });
    });
  }

  /** Q5 step 8: ONBOARDING, the job DONE and its last step, in one transaction. */
  private async finish(job: JobRow, t: TenantRow, stepRowId: string): Promise<void> {
    if (job.inviteEnc !== null) throw new StepRefused('state_conflict');
    await this.platform.$transaction(async (tx) => {
      const moved = await tx.tenant.updateMany({ where: { id: t.id, status: 'PROVISIONING' }, data: { status: 'ONBOARDING' } });
      if (moved.count !== 1) throw new StepRefused('state_conflict');
      const now = new Date();
      await tx.provisioningJob.update({ where: { id: job.id }, data: { status: 'DONE', finishedAt: now, version: { increment: 1 } }, select: { id: true } });
      await tx.provisioningStep.update({ where: { id: stepRowId }, data: { status: 'DONE', finishedAt: now }, select: { id: true } });
      await writePlatformAudit(tx, { actorId: null, action: 'platform.tenant.provisioned', tenantId: t.id, metadata: { jobId: job.id } });
    });
  }

  private async fail(jobId: string, stepRowId: string, step: ProvisioningStepKey, code: ProvisioningErrorCode): Promise<void> {
    await this.platform.$transaction(async (tx) => {
      const now = new Date();
      await tx.provisioningStep.update({ where: { id: stepRowId }, data: { status: 'FAILED', errorCode: code, finishedAt: now }, select: { id: true } });
      const job = await tx.provisioningJob.update({ where: { id: jobId }, data: { status: 'FAILED', errorStep: step, errorCode: code, version: { increment: 1 } }, select: { tenantId: true } });
      await writePlatformAudit(tx, { actorId: null, action: 'platform.tenant.provisioning_failed', tenantId: job.tenantId, metadata: { jobId, step, code } });
    });
  }
}
