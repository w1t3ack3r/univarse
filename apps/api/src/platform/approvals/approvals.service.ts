// Spec 0037 Q2–Q5 (E4, T24): the two-person approval engine. A member asks; a different member holding the kind's
// approve permission, with step-up, approves the hash of the payload they were shown, and the stored payload runs in
// that same transaction with its audit events. Single use is held twice: a version check here, and a trigger in the
// database that lets a request move forward only once. The rules themselves are pure (packages/domain).
import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { PlatformApproval as ApprovalView, PlatformApprovalRequest } from '@univarse/contracts';
import type { PlatformClient } from '@univarse/db';
import {
  APPROVAL_KINDS,
  approvalExpiry,
  approvalSubject,
  canonicalJson,
  decisionRefusal,
  effectiveApprovalStatus,
  evaluatePlatform,
  isApprovalKind,
  PLATFORM_ROLE_PERMISSIONS,
  isPlatformRole,
  secondPersonAvailable,
  possibleApprovers,
  type ApprovalFailure,
  type ApprovalKind,
  type ApprovalStatus,
  type DecisionRefusal,
  type PlatformPermission,
} from '@univarse/domain';
import { ProblemError } from '../../shared/errors/problem.js';
import { securityFields } from '../../shared/observability/security.js';
import { platformAudit } from '../identity/audit.js';
import { enqueueMail, NOT_YOU } from '../identity/mail.js';
import { STAFF_LOCK } from '../identity/staff.service.js';
import type { PlatformActor, PlatformTx, RequestMeta } from '../identity/types.js';
import { CONSOLE_DB } from '../platform-config.js';

const notFound = () => new ProblemError(404, 'resource.not_found', 'Not found');

/** The hash an approver must send back: SHA-256 of the payload's canonical form (Q3). */
export const payloadHash = (payload: unknown): string => createHash('sha256').update(canonicalJson(payload)).digest('hex');

const holds = (role: string, permission: PlatformPermission): boolean => isPlatformRole(role) && PLATFORM_ROLE_PERMISSIONS[role].includes(permission);

/** Q3: each refusal, as the console explains it. A member who may not decide at all sees what an unknown id shows. */
function refused(r: DecisionRefusal): ProblemError {
  if (r === 'not_allowed') return notFound();
  const titles: Record<Exclude<DecisionRefusal, 'not_allowed'>, string> = {
    own_request: 'Your own request',
    names_you: 'A request about you',
    not_pending: 'Not pending',
    expired: 'Expired',
    payload_changed: 'Not the request you were shown',
  };
  return new ProblemError(409, `approval.${r}`, titles[r]);
}

/** The refusal of a permission check, as the platform guard answers it. */
function permissionProblem(actor: PlatformActor, permission: PlatformPermission): ProblemError | null {
  const d = evaluatePlatform(actor, permission);
  if (d.allowed) return null;
  if (d.reason === 'hidden') return notFound();
  if (d.reason === 'enrolment_required') return new ProblemError(403, 'auth.mfa_enrolment_required', 'Set up two-factor sign-in to continue');
  return new ProblemError(428, 'auth.step_up_required', 'Confirm your identity to continue');
}

interface Row {
  readonly id: string;
  readonly kind: string;
  readonly payload: unknown;
  readonly payloadHash: string;
  readonly subjectId: string | null;
  readonly reason: string;
  readonly status: ApprovalStatus;
  readonly requestedBy: string;
  readonly decidedBy: string | null;
  readonly decidedAt: Date | null;
  readonly executedAt: Date | null;
  readonly failureCode: string | null;
  readonly expiresAt: Date;
  readonly createdAt: Date;
  readonly version: number;
}

type Outcome = { readonly ok: true } | { readonly ok: false; readonly code: ApprovalFailure };

@Injectable()
export class PlatformApprovals {
  private readonly logger = new Logger('PlatformApprovals');

  constructor(@Inject(CONSOLE_DB) private readonly db: PlatformClient) {}

  /** Q3, Q5: a request, if the member may make it, it would change something, and someone else could approve it. */
  async request(actor: PlatformActor, body: PlatformApprovalRequest, meta: RequestMeta, now = new Date()): Promise<ApprovalView> {
    const kind = body.kind;
    const problem = permissionProblem(actor, APPROVAL_KINDS[kind].requestPermission);
    if (problem) throw problem;
    const payload = body.payload;
    const subjectId = approvalSubject(kind, payload);
    const hash = payloadHash(payload);

    const id = await this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${STAFF_LOCK})`;
      await this.applicable[kind](tx, payload, actor);
      const waiting = await tx.platformApproval.findFirst({ where: { kind, payloadHash: hash, status: 'PENDING', expiresAt: { gt: now } }, select: { id: true } });
      if (waiting) throw new ProblemError(409, 'approval.already_pending', 'Already waiting');
      const staff = await this.staff(tx);
      if (!secondPersonAvailable(kind, staff, actor.userId, subjectId)) throw new ProblemError(409, 'approval.no_second_person', 'Nobody else can approve this');

      // Named columns only: the status, decider and version are the database's defaults, which the console can't set.
      const [row] = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO platform_approval (kind, payload, payload_hash, subject_id, reason, requested_by, expires_at, updated_at)
        VALUES (${kind}, ${canonicalJson(payload)}::jsonb, ${hash}, ${subjectId}::uuid, ${body.reason}, ${actor.userId}::uuid, ${approvalExpiry(kind, now)}, now())
        RETURNING id::text`;
      if (!row) throw new Error('platform_approval insert returned nothing');
      // Ids only: the reason is free text and stays in the request's own row, never in the audit chain.
      await platformAudit(tx, { actorId: actor.userId, action: 'platform.approval.requested', metadata: { approvalId: row.id, kind, subjectId, payloadHash: hash } }, meta);
      for (const approver of possibleApprovers(kind, staff, actor.userId, subjectId)) {
        await enqueueMail(tx, {
          to: approver.email,
          subject: 'a request waits for your approval',
          text: `${actor.displayName} asked for an approval (${kind}). Open the console's inbox to read it and decide. It expires in 24 hours.`,
        });
      }
      return row.id;
    });
    this.logger.warn(securityFields('platform.approval.requested', { actorId: actor.userId, approvalId: id, kind }), 'Approval requested');
    return this.get(actor, id, now);
  }

  /** Q3: the approver sends back the hash they were shown; the stored payload runs in this transaction. */
  async approve(actor: PlatformActor, id: string, shownHash: string, meta: RequestMeta, now = new Date()): Promise<ApprovalView> {
    const problem = permissionProblem(actor, 'platform.approval.decide');
    if (problem) throw problem;
    const outcome = await this.db.$transaction(async (tx): Promise<Outcome> => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${STAFF_LOCK})`;
      const a = await this.lockRow(tx, id);
      const refusal = decisionRefusal({ ...a, kind: a.kind as ApprovalKind }, actor, shownHash, now);
      if (refusal) throw refused(refusal);
      // The requester must still be able to ask: a member demoted or removed since doesn't get it done by proxy.
      const requester = await tx.platformUser.findUnique({ where: { id: a.requestedBy }, select: { role: true, isActive: true } });
      const stillAllowed = requester !== null && requester.isActive && holds(requester.role, APPROVAL_KINDS[a.kind as ApprovalKind].requestPermission);
      const outcome: Outcome = stillAllowed ? await this.executors[a.kind as ApprovalKind](tx, a, actor, meta) : { ok: false, code: 'state_conflict' };
      const n = await tx.platformApproval.updateMany({
        where: { id, status: 'PENDING', version: a.version },
        data: {
          status: outcome.ok ? 'EXECUTED' : 'FAILED',
          decidedBy: actor.userId,
          decidedAt: now,
          executedAt: now,
          failureCode: outcome.ok ? null : outcome.code,
          version: { increment: 1 },
        },
      });
      if (n.count !== 1) throw refused('not_pending');
      await platformAudit(
        tx,
        { actorId: actor.userId, action: 'platform.approval.approved', metadata: { approvalId: id, kind: a.kind, payloadHash: a.payloadHash, outcome: outcome.ok ? 'executed' : 'failed', ...(outcome.ok ? {} : { failureCode: outcome.code }) } },
        meta,
      );
      await this.tellRequester(tx, a, outcome.ok ? 'was approved and done' : 'was approved, but could not be done: things had changed since it was asked');
      return outcome;
    });
    this.logger.warn(securityFields('platform.approval.decided', { actorId: actor.userId, approvalId: id, decision: 'approved', outcome: outcome.ok ? 'executed' : 'failed' }), 'Approval decided');
    return this.get(actor, id, now);
  }

  async reject(actor: PlatformActor, id: string, meta: RequestMeta, now = new Date()): Promise<ApprovalView> {
    const problem = permissionProblem(actor, 'platform.approval.decide');
    if (problem) throw problem;
    await this.db.$transaction(async (tx) => {
      const a = await this.lockRow(tx, id);
      const refusal = decisionRefusal({ ...a, kind: a.kind as ApprovalKind }, actor, null, now);
      if (refusal) throw refused(refusal);
      const n = await tx.platformApproval.updateMany({
        where: { id, status: 'PENDING', version: a.version },
        data: { status: 'REJECTED', decidedBy: actor.userId, decidedAt: now, version: { increment: 1 } },
      });
      if (n.count !== 1) throw refused('not_pending');
      await platformAudit(tx, { actorId: actor.userId, action: 'platform.approval.rejected', metadata: { approvalId: id, kind: a.kind } }, meta);
      await this.tellRequester(tx, a, 'was rejected');
    });
    this.logger.warn(securityFields('platform.approval.decided', { actorId: actor.userId, approvalId: id, decision: 'rejected' }), 'Approval decided');
    return this.get(actor, id, now);
  }

  /** Q3: only the requester, only while it waits. */
  async cancel(actor: PlatformActor, id: string, meta: RequestMeta, now = new Date()): Promise<ApprovalView> {
    await this.db.$transaction(async (tx) => {
      const a = await this.lockRow(tx, id);
      if (a.requestedBy !== actor.userId) {
        if (!this.visible(actor, a)) throw notFound();
        throw new ProblemError(409, 'approval.not_pending', 'Only the requester can cancel');
      }
      if (effectiveApprovalStatus(a, now) !== 'PENDING') throw refused('not_pending');
      const n = await tx.platformApproval.updateMany({ where: { id, status: 'PENDING', version: a.version }, data: { status: 'CANCELLED', version: { increment: 1 } } });
      if (n.count !== 1) throw refused('not_pending');
      await platformAudit(tx, { actorId: actor.userId, action: 'platform.approval.cancelled', metadata: { approvalId: id, kind: a.kind } }, meta);
    });
    return this.get(actor, id, now);
  }

  /** The requests a member may see: their own, and every request of a kind they could decide. Newest first. */
  async list(actor: PlatformActor, now = new Date()): Promise<ApprovalView[]> {
    const decidable = Object.entries(APPROVAL_KINDS)
      .filter(([, k]) => holds(actor.role, k.approvePermission))
      .map(([name]) => name);
    const rows = await this.db.platformApproval.findMany({
      where: { OR: [{ requestedBy: actor.userId }, { kind: { in: decidable } }] },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return this.views(actor, rows, now);
  }

  async get(actor: PlatformActor, id: string, now = new Date()): Promise<ApprovalView> {
    const row = (await this.db.platformApproval.findUnique({ where: { id } })) as Row | null;
    if (!row || !this.visible(actor, row)) throw notFound();
    const [view] = await this.views(actor, [row], now);
    if (!view) throw notFound();
    return view;
  }

  private visible(actor: PlatformActor, a: Pick<Row, 'requestedBy' | 'kind'>): boolean {
    return a.requestedBy === actor.userId || (isApprovalKind(a.kind) && holds(actor.role, APPROVAL_KINDS[a.kind].approvePermission));
  }

  private async views(actor: PlatformActor, rows: readonly Row[], now: Date): Promise<ApprovalView[]> {
    const ids = [...new Set(rows.flatMap((r) => [r.requestedBy, r.decidedBy, r.subjectId]).filter((x): x is string => x !== null))];
    const people = await this.db.platformUser.findMany({ where: { id: { in: ids } }, select: { id: true, displayName: true } });
    const name = new Map(people.map((p) => [p.id, p.displayName]));
    const person = (id: string) => ({ id, name: name.get(id) ?? null });
    return rows
      .filter((r) => isApprovalKind(r.kind))
      .map((r) => {
        const kind = r.kind as ApprovalKind;
        const status = effectiveApprovalStatus(r, now);
        return {
          id: r.id,
          kind,
          payload: r.payload as Record<string, unknown>,
          payloadHash: r.payloadHash,
          subject: r.subjectId ? person(r.subjectId) : null,
          reason: r.reason,
          status,
          requestedBy: person(r.requestedBy),
          requestedAt: r.createdAt.toISOString(),
          expiresAt: r.expiresAt.toISOString(),
          decidedBy: r.decidedBy ? person(r.decidedBy) : null,
          decidedAt: r.decidedAt?.toISOString() ?? null,
          executedAt: r.executedAt?.toISOString() ?? null,
          failureCode: (r.failureCode as ApprovalFailure | null) ?? null,
          canDecide: decisionRefusal({ ...r, kind }, actor, null, now) === null,
          canCancel: r.requestedBy === actor.userId && status === 'PENDING',
        };
      });
  }

  private async lockRow(tx: PlatformTx, id: string): Promise<Row> {
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id::text FROM platform_approval WHERE id = ${id}::uuid FOR UPDATE`;
    if (locked.length === 0) throw notFound();
    const a = (await tx.platformApproval.findUnique({ where: { id } })) as Row | null;
    if (!a || !isApprovalKind(a.kind)) throw notFound();
    return a;
  }

  private async staff(tx: PlatformTx) {
    const users = await tx.platformUser.findMany({
      select: { id: true, email: true, role: true, isActive: true, mfaFactors: { where: { confirmedAt: { not: null }, revokedAt: null }, select: { id: true } } },
    });
    return users.map((u) => ({ id: u.id, email: u.email, role: u.role, isActive: u.isActive, mfaEnrolled: u.mfaFactors.length > 0 }));
  }

  /** Whether a request would change anything now, per kind: refused at the asking, so nobody approves a no-op. */
  private readonly applicable: Record<ApprovalKind, (tx: PlatformTx, payload: Readonly<Record<string, unknown>>, actor: PlatformActor) => Promise<void>> = {
    'staff.make_owner': async (tx, payload, actor) => {
      const memberId = String(payload.memberId);
      if (memberId === actor.userId) throw new ProblemError(409, 'staff.own_account', "You can't change your own role or access");
      const target = await tx.platformUser.findUnique({ where: { id: memberId }, select: { role: true, isActive: true } });
      if (!target) throw notFound();
      if (!target.isActive || target.role === 'OWNER') throw new ProblemError(409, 'approval.not_applicable', 'Nothing would change');
    },
  };

  /** The stored payload, run, per kind. A changed world is a FAILED outcome with a fixed code, never a half-done action. */
  private readonly executors: Record<ApprovalKind, (tx: PlatformTx, a: Row, approver: PlatformActor, meta: RequestMeta) => Promise<Outcome>> = {
    'staff.make_owner': async (tx, a, approver, meta) => {
      const memberId = String((a.payload as Record<string, unknown>).memberId);
      const target = await tx.platformUser.findUnique({ where: { id: memberId }, select: { role: true, isActive: true, email: true } });
      if (!target) return { ok: false, code: 'subject_gone' };
      if (!target.isActive) return { ok: false, code: 'subject_inactive' };
      if (target.role === 'OWNER') return { ok: false, code: 'already_done' };
      await tx.platformUser.update({ where: { id: memberId }, data: { role: 'OWNER' }, select: { id: true } });
      await platformAudit(tx, { actorId: approver.userId, action: 'platform.staff.role_changed', metadata: { memberId, from: target.role, to: 'OWNER', approvalId: a.id, requestedBy: a.requestedBy } }, meta);
      await enqueueMail(tx, { to: target.email, subject: 'your console role changed', text: `Your role in the UniVarse platform console changed from ${target.role} to OWNER, approved by two members.${NOT_YOU}` });
      this.logger.warn(securityFields('platform.staff.changed', { actorId: approver.userId, action: 'role_changed', targetId: memberId }), 'Platform staff changed');
      return { ok: true };
    },
  };

  private async tellRequester(tx: PlatformTx, a: Row, what: string): Promise<void> {
    const requester = await tx.platformUser.findUnique({ where: { id: a.requestedBy }, select: { email: true, isActive: true } });
    if (!requester?.isActive) return;
    await enqueueMail(tx, { to: requester.email, subject: 'your approval request was decided', text: `Your request (${a.kind}) ${what}. The console's inbox shows the details.${NOT_YOU}` });
  }
}
