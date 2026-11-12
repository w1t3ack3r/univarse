// Spec 0034: the console's side of provisioning. It records a request (the tenant, its job and the audit event, in one
// transaction, Q5 step 0), shows where a provisioning stands, resumes a failed one (Q8), records the DPA (Q10) and takes
// an institution live through the computed checklist (Q9). It never touches a tenant database: the worker runs the
// steps (Q2). The IT Admin's details are sealed for the worker before anything is written (Q7), and never read back.
import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ALWAYS_ON, isProduct, type PlatformCreateTenant, type PlatformGoLive, type PlatformProvisioning as ProvisioningView } from '@univarse/contracts';
import { sealInvite, type KeyProvider } from '@univarse/crypto';
import type { PlatformClient } from '@univarse/db';
import {
  goLiveChecklist,
  maskEmail,
  PROVISIONING_STEPS,
  registryWritable,
  slugProblem,
  TEMPLATES,
  templateRef,
  type ProvisioningErrorCode,
  type ProvisioningStepKey,
} from '@univarse/domain';
import { ProblemError } from '../../shared/errors/problem.js';
import { platformAudit } from '../identity/audit.js';
import type { PlatformActor, PlatformTx, RequestMeta } from '../identity/types.js';
import { CONSOLE_DB } from '../platform-config.js';

export const PROVISIONING_KEYS = Symbol('PROVISIONING_KEYS');

const notFound = () => new ProblemError(404, 'resource.not_found', 'Not found');
const unavailable = () => new ProblemError(503, 'provisioning.unavailable', 'Provisioning is not set up');
const invalid = (code: string, path: string, message: string) =>
  Object.assign(new ProblemError(422, code, message), { errors: [{ path, code: code.split('.')[1] ?? code, message }] });

/**
 * Which unique constraint a failed insert hit, by name. The inserts are raw (step 0's named columns), so Postgres's
 * 23505 arrives inside Prisma's raw-query error; its constraint's name is in the message, never a value.
 */
function uniqueOn(err: unknown): 'slug' | 'idempotency' | null {
  const e = err as { code?: string; meta?: { code?: string; message?: string }; message?: string };
  const text = `${e.meta?.message ?? ''} ${e.message ?? ''}`;
  if (e.code !== 'P2010' && e.code !== 'P2002' && e.meta?.code !== '23505') return null;
  if (text.includes('tenant_slug_key')) return 'slug';
  if (text.includes('provisioning_job_requested_by_idempotency_key_key')) return 'idempotency';
  return null;
}

@Injectable()
export class PlatformProvisioning {
  constructor(
    @Inject(CONSOLE_DB) private readonly db: PlatformClient,
    @Inject(PROVISIONING_KEYS) private readonly keys: KeyProvider | null,
  ) {}

  /** Q5 step 0, Q12. A repeated key from the same member returns the first answer, whatever the body. */
  async create(actor: PlatformActor, idempotencyKey: string, body: PlatformCreateTenant, meta: RequestMeta): Promise<{ tenantId: string; jobId: string; replayed: boolean }> {
    const replay = await this.replay(actor.userId, idempotencyKey);
    if (replay) return { ...replay, replayed: true };
    if (!this.keys) throw unavailable();

    const problem = slugProblem(body.slug);
    if (problem === 'format') throw invalid('tenant.slug_invalid', 'slug', 'Not a valid subdomain');
    if (problem === 'reserved') throw invalid('tenant.slug_reserved', 'slug', 'A reserved name');
    const unknown = body.products.find((p) => !isProduct(p));
    if (unknown) throw invalid('tenant.product_unknown', 'products', 'Not a product');
    const products = [...new Set([...ALWAYS_ON, ...body.products])].sort();
    const template = TEMPLATES[body.template];

    // Q11: the active pool with the fewest institutions. Placed here because a tenant row needs its shard; the worker's
    // first step checks the shard can be reached before anything is written to it.
    const pools = await this.db.shard.findMany({ where: { kind: 'POOL', isActive: true }, select: { id: true } });
    if (pools.length === 0) throw new ProblemError(503, 'provisioning.unavailable', 'No active shard');
    const counts = await this.db.tenant.groupBy({ by: ['shardId'], where: { shardId: { in: pools.map((p) => p.id) } }, _count: { _all: true } });
    const load = new Map(counts.map((c) => [c.shardId, c._count._all]));
    const shardId = [...pools].sort((a, b) => (load.get(a.id) ?? 0) - (load.get(b.id) ?? 0) || a.id.localeCompare(b.id))[0]?.id;
    if (!shardId) throw unavailable();

    const tenantId = randomUUID();
    // Sealed before the transaction: a Vault call never holds a database transaction open.
    const inviteEnc = await sealInvite(this.keys, tenantId, body.admin);
    try {
      const jobId = await this.db.$transaction(async (tx) => {
        // The granted columns only, named: the status, tier and version are the database's defaults (REQUESTED,
        // POOLED, 0), which the console role can't set, so it can't create an institution in any other state.
        await tx.$executeRaw`
          INSERT INTO tenant (id, slug, legal_name, short_name, type, ownership, shard_id, template, updated_at)
          VALUES (${tenantId}::uuid, ${body.slug}, ${body.legalName}, ${body.shortName}, ${body.type}::"TenantType",
                  ${body.ownership}::"TenantOwnership", ${shardId}::uuid, ${templateRef(template)}, now())`;
        if (body.state) await tx.tenantRegulatoryProfile.create({ data: { tenantId, state: body.state, updatedBy: actor.userId }, select: { tenantId: true } });
        // As above: a job starts QUEUED, at version 0, by the database's defaults; the console can't set them.
        const [job] = await tx.$queryRaw<{ id: string }[]>`
          INSERT INTO provisioning_job (tenant_id, template, template_version, products, requested_by, idempotency_key, invite_enc, invite_masked, updated_at)
          VALUES (${tenantId}::uuid, ${template.id}, ${template.version}, ${products}::text[], ${actor.userId}::uuid, ${idempotencyKey}::uuid,
                  ${inviteEnc}, ${maskEmail(body.admin.email)}, now())
          RETURNING id::text`;
        if (!job) throw new Error('provisioning_job insert returned nothing');
        // Ids and choices only: the IT Admin's name and address never enter the audit chain (spec 0026 T26).
        await platformAudit(
          tx,
          { actorId: actor.userId, tenantId, action: 'platform.tenant.provisioning_requested', metadata: { slug: body.slug, template: template.id, templateVersion: template.version, products, jobId: job.id } },
          meta,
        );
        return job.id;
      });
      return { tenantId, jobId, replayed: false };
    } catch (err) {
      const on = uniqueOn(err);
      if (on === 'slug') throw new ProblemError(409, 'tenant.slug_taken', 'That subdomain is taken');
      if (on === 'idempotency') {
        const again = await this.replay(actor.userId, idempotencyKey);
        if (again) return { ...again, replayed: true };
      }
      throw err;
    }
  }

  private async replay(requestedBy: string, idempotencyKey: string) {
    const job = await this.db.provisioningJob.findUnique({ where: { requestedBy_idempotencyKey: { requestedBy, idempotencyKey } }, select: { id: true, tenantId: true } });
    return job ? { tenantId: job.tenantId, jobId: job.id } : null;
  }

  /** Q13: every step, in order; one not yet reached is PENDING. */
  async view(tenantId: string): Promise<ProvisioningView> {
    const job = await this.db.provisioningJob.findUnique({
      where: { tenantId },
      select: {
        id: true,
        tenantId: true,
        template: true,
        templateVersion: true,
        status: true,
        inviteMasked: true,
        errorStep: true,
        errorCode: true,
        createdAt: true,
        finishedAt: true,
        steps: { select: { step: true, status: true, attempts: true, errorCode: true, startedAt: true, finishedAt: true } },
      },
    });
    if (!job) throw notFound();
    const rows = new Map(job.steps.map((s) => [s.step, s]));
    return {
      jobId: job.id,
      tenantId: job.tenantId,
      template: `${job.template}@${String(job.templateVersion)}`,
      status: job.status,
      invite: job.inviteMasked,
      steps: PROVISIONING_STEPS.map((step) => {
        const r = rows.get(step);
        return {
          step,
          status: r?.status ?? 'PENDING',
          attempts: r?.attempts ?? 0,
          errorCode: (r?.errorCode as ProvisioningErrorCode | null | undefined) ?? null,
          startedAt: r?.startedAt.toISOString() ?? null,
          finishedAt: r?.finishedAt?.toISOString() ?? null,
        };
      }),
      error: job.errorStep && job.errorCode ? { step: job.errorStep as ProvisioningStepKey, code: job.errorCode as ProvisioningErrorCode } : null,
      createdAt: job.createdAt.toISOString(),
      finishedAt: job.finishedAt?.toISOString() ?? null,
    };
  }

  /** Q8: a failed job goes back to the queue; the worker starts at the failed step. */
  async resume(actor: PlatformActor, tenantId: string, meta: RequestMeta): Promise<void> {
    await this.db.$transaction(async (tx) => {
      const job = await tx.provisioningJob.findUnique({ where: { tenantId }, select: { id: true, status: true, version: true, errorStep: true, errorCode: true } });
      if (!job) throw notFound();
      if (job.status !== 'FAILED') throw new ProblemError(409, 'provisioning.not_failed', 'Not failed');
      const n = await tx.provisioningJob.updateMany({
        where: { id: job.id, status: 'FAILED', version: job.version },
        data: { status: 'QUEUED', errorStep: null, errorCode: null, version: { increment: 1 } },
      });
      if (n.count !== 1) throw new ProblemError(409, 'provisioning.not_failed', 'Not failed');
      await platformAudit(
        tx,
        { actorId: actor.userId, tenantId, action: 'platform.tenant.provisioning_resumed', metadata: { jobId: job.id, failedStep: job.errorStep, errorCode: job.errorCode } },
        meta,
      );
    });
  }

  private async facts(tx: PlatformTx | PlatformClient, tenantId: string) {
    const t = await tx.tenant.findUnique({
      where: { id: tenantId },
      select: {
        status: true,
        products: { where: { entitled: true }, select: { product: true } },
        branding: { select: { primaryColor: true } },
        regulatoryProfile: { select: { state: true, operatingStatus: true } },
        onboarding: { select: { adminReadyAt: true } },
        dpa: { select: { dpaVersion: true, signedOn: true, reference: true, recordedAt: true, version: true } },
      },
    });
    if (!t) throw notFound();
    const checklist = goLiveChecklist({
      status: t.status,
      adminReadyAt: t.onboarding?.adminReadyAt ?? null,
      entitled: [...ALWAYS_ON, ...t.products.map((p) => p.product)],
      primaryColor: t.branding?.primaryColor ?? null,
      state: t.regulatoryProfile?.state ?? null,
      operatingStatus: t.regulatoryProfile?.operatingStatus ?? 'UNKNOWN',
      dpaRecorded: t.dpa !== null,
    });
    return { t, checklist };
  }

  /** Q9. */
  async goLiveView(tenantId: string): Promise<PlatformGoLive> {
    const { t, checklist } = await this.facts(this.db, tenantId);
    return {
      status: t.status,
      items: [...checklist.items],
      ready: checklist.ready,
      dpa: t.dpa
        ? { dpaVersion: t.dpa.dpaVersion, signedOn: t.dpa.signedOn.toISOString().slice(0, 10), reference: t.dpa.reference, recordedAt: t.dpa.recordedAt.toISOString(), version: t.dpa.version }
        : null,
    };
  }

  /** Q10: recorded by hand, dated no later than today (UTC), audited. Recording it again replaces it. */
  async recordDpa(actor: PlatformActor, tenantId: string, body: { dpaVersion: string; signedOn: string; reference: string }, meta: RequestMeta, now = new Date()): Promise<void> {
    if (body.signedOn > now.toISOString().slice(0, 10)) throw invalid('tenant.dpa_date', 'signedOn', 'In the future');
    await this.db.$transaction(async (tx) => {
      const t = await tx.tenant.findUnique({ where: { id: tenantId }, select: { status: true } });
      if (!t) throw notFound();
      if (!registryWritable(t.status)) throw new ProblemError(409, 'tenant.closed', 'Archived');
      const before = await tx.tenantDpa.findUnique({ where: { tenantId }, select: { dpaVersion: true, signedOn: true, reference: true } });
      const data = { dpaVersion: body.dpaVersion, signedOn: new Date(`${body.signedOn}T00:00:00Z`), reference: body.reference, recordedBy: actor.userId, recordedAt: now };
      if (before) await tx.tenantDpa.update({ where: { tenantId }, data: { ...data, version: { increment: 1 } }, select: { tenantId: true } });
      else await tx.tenantDpa.create({ data: { tenantId, ...data }, select: { tenantId: true } });
      await platformAudit(
        tx,
        {
          actorId: actor.userId,
          tenantId,
          action: 'platform.tenant.dpa_recorded',
          metadata: {
            before: before ? { dpaVersion: before.dpaVersion, signedOn: before.signedOn.toISOString().slice(0, 10), reference: before.reference } : null,
            after: { dpaVersion: body.dpaVersion, signedOn: body.signedOn, reference: body.reference },
          },
        },
        meta,
      );
    });
  }

  /** Q9: ONBOARDING → ACTIVE, only when every item passes, decided again inside the transaction that changes it. */
  async goLive(actor: PlatformActor, tenantId: string, meta: RequestMeta): Promise<void> {
    await this.db.$transaction(async (tx) => {
      // Locks the row, so two members can't both decide on a checklist the other is changing.
      const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id::text FROM tenant WHERE id = ${tenantId}::uuid FOR UPDATE`;
      if (locked.length === 0) throw notFound();
      const { t, checklist } = await this.facts(tx, tenantId);
      if (t.status !== 'ONBOARDING') throw new ProblemError(409, 'tenant.not_onboarding', 'Not onboarding');
      if (!checklist.ready) {
        const failing = checklist.items.filter((i) => !i.passed);
        throw Object.assign(new ProblemError(409, 'tenant.go_live_incomplete', 'The checklist has not passed'), {
          errors: failing.map((i) => ({ path: i.item, code: 'not_passed', message: 'Not passed yet' })),
        });
      }
      const n = await tx.tenant.updateMany({ where: { id: tenantId, status: 'ONBOARDING' }, data: { status: 'ACTIVE' } });
      if (n.count !== 1) throw new ProblemError(409, 'tenant.not_onboarding', 'Not onboarding');
      await platformAudit(tx, { actorId: actor.userId, tenantId, action: 'platform.tenant.went_live', metadata: { checklist: checklist.items.map((i) => i.item) } }, meta);
    });
  }
}
