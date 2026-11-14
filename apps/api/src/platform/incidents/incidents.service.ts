// Spec 0037 Q13, Q14 (E19): incidents, from the console. Opening one decides the affected institutions (a row each) and
// writes its first update; each later update is a new row in its timeline, never an edit, and moves every affected
// institution's row forward so its cache hears of it (spec 0016's capture) and its banner changes at once. Public text
// goes to the institutions; internal notes, the follow-up and the personal-data flag stay in the console (the tenant
// API's role can't read them). The audit chain holds ids and choices; the text stays on the incident's own rows.
import { Inject, Injectable } from '@nestjs/common';
import type { PlatformIncident, PlatformIncidentSummary, PlatformOps } from '@univarse/contracts';
import type { PlatformClient } from '@univarse/db';
import { breachDeadline, openingProblems, reachable, updatable, updateProblems, type IncidentStatus } from '@univarse/domain';
import type { z } from 'zod';
import { ProblemError } from '../../shared/errors/problem.js';
import { stale } from '../../shared/http/etag.js';
import { platformAudit } from '../identity/audit.js';
import type { PlatformActor, PlatformTx, RequestMeta } from '../identity/types.js';
import { CONSOLE_DB } from '../platform-config.js';

type OpenBody = z.infer<typeof PlatformOps.openIncident.body>;
type UpdateBody = z.infer<typeof PlatformOps.postIncidentUpdate.body>;
type FollowupBody = z.infer<typeof PlatformOps.incidentFollowup.body>;

const notFound = () => new ProblemError(404, 'resource.not_found', 'Not found');
const invalid = (problems: (readonly [string, string])[]) =>
  Object.assign(new ProblemError(422, 'incident.invalid', 'Invalid incident'), { errors: problems.map(([path, code]) => ({ path, code, message: code })) });
const iso = (d: Date | null) => d?.toISOString() ?? null;
const noteOf = (n: string | null | undefined) => (n?.trim() ? n.trim() : null);

const SUMMARY = {
  id: true,
  title: true,
  severity: true,
  status: true,
  scope: true,
  personalData: true,
  startedAt: true,
  awareAt: true,
  resolvedAt: true,
  updatedAt: true,
  _count: { select: { tenants: true } },
  updates: { select: { createdAt: true }, orderBy: { createdAt: 'desc' }, take: 1 },
} as const;

type SummaryRow = {
  id: string;
  title: string;
  severity: PlatformIncidentSummary['severity'];
  status: IncidentStatus;
  scope: 'ALL' | 'TENANTS';
  personalData: PlatformIncidentSummary['personalData'];
  startedAt: Date;
  awareAt: Date;
  resolvedAt: Date | null;
  updatedAt: Date;
  _count: { tenants: number };
  updates: { createdAt: Date }[];
};

function summary(r: SummaryRow): PlatformIncidentSummary {
  return {
    id: r.id,
    title: r.title,
    severity: r.severity,
    status: r.status,
    scope: r.scope,
    personalData: r.personalData,
    startedAt: r.startedAt.toISOString(),
    awareAt: r.awareAt.toISOString(),
    resolvedAt: iso(r.resolvedAt),
    breachDeadline: iso(breachDeadline(r)),
    institutions: r._count.tenants,
    lastUpdateAt: (r.updates[0]?.createdAt ?? r.updatedAt).toISOString(),
  };
}

@Injectable()
export class PlatformIncidents {
  constructor(@Inject(CONSOLE_DB) private readonly db: PlatformClient) {}

  /** Open first (newest first), then resolved. */
  async list(open: boolean | undefined): Promise<{ data: PlatformIncidentSummary[] }> {
    const rows = await this.db.platformIncident.findMany({
      where: open === undefined ? {} : open ? { status: { not: 'RESOLVED' } } : { status: 'RESOLVED' },
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: SUMMARY,
    });
    const data = rows.map(summary);
    return { data: [...data.filter((i) => i.status !== 'RESOLVED'), ...data.filter((i) => i.status === 'RESOLVED')] };
  }

  async get(id: string): Promise<PlatformIncident> {
    const r = await this.db.platformIncident.findUnique({
      where: { id },
      select: {
        ...SUMMARY,
        version: true,
        followupWhat: true,
        followupActions: true,
        opener: { select: { id: true, displayName: true } },
        tenants: { select: { tenant: { select: { id: true, slug: true, shortName: true } } }, orderBy: { tenant: { shortName: 'asc' } } },
      },
    });
    if (!r) throw notFound();
    const updates = await this.db.platformIncidentUpdate.findMany({
      where: { incidentId: id },
      orderBy: { createdAt: 'desc' },
      select: { id: true, status: true, severity: true, personalData: true, publicText: true, internalNote: true, createdAt: true, poster: { select: { id: true, displayName: true } } },
    });
    return {
      ...summary(r),
      openedBy: { id: r.opener.id, name: r.opener.displayName },
      tenants: r.tenants.map((t) => ({ id: t.tenant.id, slug: t.tenant.slug, name: t.tenant.shortName })),
      updates: updates.map((u) => ({
        id: u.id,
        status: u.status,
        severity: u.severity,
        personalData: u.personalData,
        publicText: u.publicText,
        internalNote: u.internalNote,
        postedBy: { id: u.poster.id, name: u.poster.displayName },
        createdAt: u.createdAt.toISOString(),
      })),
      followup: { what: r.followupWhat, actions: r.followupActions },
      version: r.version,
    };
  }

  /** Q13: the incident, its first update and its institutions, in one transaction. */
  async open(actor: PlatformActor, body: OpenBody, meta: RequestMeta, now = new Date()): Promise<PlatformIncident> {
    const startedAt = new Date(body.startedAt);
    const awareAt = new Date(body.awareAt);
    const internalNote = noteOf(body.internalNote);
    const chosen = body.scope === 'TENANTS' ? [...new Set(body.tenantIds ?? [])] : [];
    const problems = openingProblems({ title: body.title, publicText: body.publicText, internalNote, scope: body.scope, tenantIds: chosen, startedAt, awareAt }, now);
    if (problems.length) throw invalid(problems);
    const id = await this.db.$transaction(async (tx) => {
      const tenants = await tx.tenant.findMany({ select: { id: true, status: true } });
      const affected = tenants.filter((t) => reachable(t.status) && (body.scope === 'ALL' || chosen.includes(t.id))).map((t) => t.id);
      if (affected.length === 0) throw new ProblemError(422, 'incident.no_institutions', 'No institution affected');
      // Raw and by column: the console role inserts only these (the migration's grants).
      const [row] = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO platform_incident (title, severity, scope, personal_data, started_at, aware_at, opened_by, updated_at)
        VALUES (${body.title.trim()}, ${body.severity}::"IncidentSeverity", ${body.scope}::"IncidentScope", ${body.personalData}::"PersonalDataInvolved",
                ${startedAt}, ${awareAt}, ${actor.userId}::uuid, now())
        RETURNING id::text`;
      if (!row) throw new Error('platform_incident insert returned nothing');
      await tx.$executeRaw`
        INSERT INTO platform_incident_update (incident_id, status, severity, personal_data, public_text, internal_note, posted_by)
        VALUES (${row.id}::uuid, 'INVESTIGATING', ${body.severity}::"IncidentSeverity", ${body.personalData}::"PersonalDataInvolved",
                ${body.publicText.trim()}, ${internalNote}, ${actor.userId}::uuid)`;
      await tx.$executeRaw`INSERT INTO platform_incident_tenant (incident_id, tenant_id) SELECT ${row.id}::uuid, unnest(${affected}::uuid[])`;
      await platformAudit(tx, { actorId: actor.userId, action: 'platform.incident.opened', metadata: { incidentId: row.id, severity: body.severity, scope: body.scope, personalData: body.personalData, institutions: affected.length } }, meta);
      return row.id;
    });
    return this.get(id);
  }

  /**
   * Q13: a new entry in the timeline, under `If-Match`. It sets the incident's status, severity and personal-data flag;
   * RESOLVED is final. Every affected institution's row moves forward, so its banner changes at once.
   */
  async postUpdate(actor: PlatformActor, id: string, expected: number, body: UpdateBody, meta: RequestMeta, now = new Date()): Promise<PlatformIncident> {
    const internalNote = noteOf(body.internalNote);
    const problems = updateProblems({ publicText: body.publicText, internalNote });
    if (problems.length) throw invalid(problems);
    await this.db.$transaction(async (tx) => {
      const r = await this.locked(tx, id);
      if (!updatable(r.status)) throw new ProblemError(409, 'incident.resolved', 'Resolved');
      if (r.version !== expected) throw stale();
      await tx.$executeRaw`
        INSERT INTO platform_incident_update (incident_id, status, severity, personal_data, public_text, internal_note, posted_by)
        VALUES (${id}::uuid, ${body.status}::"IncidentStatus", ${body.severity}::"IncidentSeverity", ${body.personalData}::"PersonalDataInvolved",
                ${body.publicText.trim()}, ${internalNote}, ${actor.userId}::uuid)`;
      const resolved = body.status === 'RESOLVED';
      await tx.platformIncident.update({
        where: { id },
        data: { status: body.status, severity: body.severity, personalData: body.personalData, ...(resolved ? { resolvedAt: now } : {}), version: { increment: 1 } },
        select: { id: true },
      });
      await tx.platformIncidentTenant.updateMany({ where: { incidentId: id }, data: { changedAt: now } });
      const metadata = { incidentId: id, status: body.status, severity: body.severity, personalData: body.personalData, from: r.status };
      if (resolved) await platformAudit(tx, { actorId: actor.userId, action: 'platform.incident.resolved', metadata }, meta);
      else await platformAudit(tx, { actorId: actor.userId, action: 'platform.incident.updated', metadata }, meta);
    });
    return this.get(id);
  }

  /** Q13: what happened and what's being done, written after resolving, staff only, under `If-Match`. */
  async followup(actor: PlatformActor, id: string, expected: number, body: FollowupBody, meta: RequestMeta): Promise<PlatformIncident> {
    await this.db.$transaction(async (tx) => {
      const r = await this.locked(tx, id);
      if (r.status !== 'RESOLVED') throw new ProblemError(409, 'incident.not_resolved', 'Not resolved');
      if (r.version !== expected) throw stale();
      await tx.platformIncident.update({ where: { id }, data: { followupWhat: body.what || null, followupActions: body.actions || null, version: { increment: 1 } }, select: { id: true } });
      await platformAudit(tx, { actorId: actor.userId, action: 'platform.incident.followup_recorded', metadata: { incidentId: id } }, meta);
    });
    return this.get(id);
  }

  private async locked(tx: PlatformTx, id: string) {
    const [lock] = await tx.$queryRaw<{ id: string }[]>`SELECT id::text FROM platform_incident WHERE id = ${id}::uuid FOR UPDATE`;
    if (!lock) throw notFound();
    return tx.platformIncident.findUniqueOrThrow({ where: { id }, select: { status: true, version: true } });
  }
}
