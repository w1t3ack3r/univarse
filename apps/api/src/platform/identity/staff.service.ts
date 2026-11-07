// Spec 0028 Q13, Q14: platform staff, managed by an OWNER with a fresh step-up (the guard enforces both). Nobody
// changes their own role or access, and the platform always keeps an active OWNER. A deactivation ends every session
// in the same transaction. The affected member is emailed; the audit row names ids only.
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { PlatformClient } from '@univarse/db';
import type { PlatformMember } from '@univarse/contracts';
import { ProblemError } from '../../shared/errors/problem.js';
import { securityFields } from '../../shared/observability/security.js';
import { CONSOLE_DB } from '../platform-config.js';
import { platformAudit } from './audit.js';
import { PlatformCredentials } from './credentials.js';
import { enqueueMail, NOT_YOU } from './mail.js';
import { PlatformSessions } from './sessions.js';
import type { PlatformActor, PlatformTx, RequestMeta } from './types.js';

type Role = PlatformMember['role'];

const notFound = () => new ProblemError(404, 'resource.not_found', 'Not found');
const ownAccount = () => new ProblemError(409, 'staff.own_account', "You can't change your own role or access");
const lastOwner = () => new ProblemError(409, 'staff.last_owner', 'The platform must keep an active owner');

/**
 * Q13's rule for a change that could leave the platform without an OWNER: it is refused when the target is an
 * active OWNER, the change takes that away (a demotion or a deactivation), and no other active OWNER remains. Pure.
 */
export function leavesNoOwner(target: { role: string; isActive: boolean }, change: { role?: string; deactivate?: boolean }, activeOwners: number): boolean {
  if (target.role !== 'OWNER' || !target.isActive) return false;
  const removes = change.deactivate === true || (change.role !== undefined && change.role !== 'OWNER');
  return removes && activeOwners <= 1;
}

/** The activation email: a code, never a link (invariant 8). */
export const activationMail = (to: string, code: string, why: string) => ({
  to,
  subject: 'activate your console account',
  text: `${why}\n\nYour activation code is ${code}. It expires in 15 minutes. Open the console and choose "Activate your account".${NOT_YOU}`,
});

@Injectable()
export class PlatformStaff {
  private readonly logger = new Logger('PlatformStaff');

  constructor(
    @Inject(CONSOLE_DB) private readonly db: PlatformClient,
    private readonly sessions: PlatformSessions,
    private readonly creds: PlatformCredentials,
  ) {}

  private async member(tx: PlatformTx | PlatformClient, id: string): Promise<PlatformMember> {
    const u = await tx.platformUser.findUnique({ where: { id }, include: { mfaFactors: { where: { confirmedAt: { not: null }, revokedAt: null }, select: { id: true } } } });
    if (!u) throw notFound();
    return { id: u.id, email: u.email, emailVerified: u.emailVerifiedAt !== null, displayName: u.displayName, role: u.role, isActive: u.isActive, mfaEnrolled: u.mfaFactors.length > 0, lastLoginAt: u.lastLoginAt?.toISOString() ?? null };
  }

  async list(): Promise<PlatformMember[]> {
    const users = await this.db.platformUser.findMany({ orderBy: [{ isActive: 'desc' }, { displayName: 'asc' }], select: { id: true } });
    return Promise.all(users.map((u) => this.member(this.db, u.id)));
  }

  /** Serialises staff changes, so two OWNERs can't each remove the other and leave none. */
  private async lockStaff(tx: PlatformTx): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${STAFF_LOCK})`;
  }

  private async activeOwners(tx: PlatformTx): Promise<number> {
    return tx.platformUser.count({ where: { role: 'OWNER', isActive: true } });
  }

  private changed(actor: PlatformActor, action: string, targetId: string): void {
    this.logger.warn(securityFields('platform.staff.changed', { actorId: actor.userId, action, targetId }), 'Platform staff changed');
  }

  /** Q13: a new member, with no password, and an activation code by email. */
  async invite(actor: PlatformActor, input: { email: string; displayName: string; role: Role }, meta: RequestMeta): Promise<PlatformMember> {
    const id = await this.db.$transaction(async (tx) => {
      await this.lockStaff(tx);
      const held = await tx.platformContactChange.findFirst({ where: { oldAddress: input.email, status: 'CONFIRMED', undoUntil: { gt: new Date() } }, select: { id: true } }); // an undo may need it back (spec 0032 Q6)
      if (held || (await tx.platformUser.findUnique({ where: { email: input.email }, select: { id: true } }))) throw new ProblemError(409, 'staff.email_taken', 'That email is already a member');
      const { id } = await tx.platformUser.create({ data: { email: input.email, displayName: input.displayName, role: input.role }, select: { id: true } });
      const code = await this.creds.issueCode(tx, id, 'ACTIVATION');
      await platformAudit(tx, { actorId: actor.userId, action: 'platform.staff.invited', metadata: { memberId: id, role: input.role } }, meta);
      await enqueueMail(tx, activationMail(input.email, code, `You were invited to the UniVarse platform console as ${input.role}.`));
      return id;
    });
    this.changed(actor, 'invited', id);
    return this.member(this.db, id);
  }

  /** Q13: another member's role; never one's own, and never the last active OWNER's. */
  async changeRole(actor: PlatformActor, memberId: string, role: Role, meta: RequestMeta): Promise<PlatformMember> {
    if (memberId === actor.userId) throw ownAccount();
    await this.db.$transaction(async (tx) => {
      await this.lockStaff(tx);
      const target = await tx.platformUser.findUnique({ where: { id: memberId } });
      if (!target) throw notFound();
      if (target.role === role) return;
      if (leavesNoOwner(target, { role }, await this.activeOwners(tx))) throw lastOwner();
      await tx.platformUser.update({ where: { id: memberId }, data: { role } });
      await platformAudit(tx, { actorId: actor.userId, action: 'platform.staff.role_changed', metadata: { memberId, from: target.role, to: role } }, meta);
      await enqueueMail(tx, { to: target.email, subject: 'your console role changed', text: `Your role in the UniVarse platform console changed from ${target.role} to ${role}.${NOT_YOU}` });
    });
    this.changed(actor, 'role_changed', memberId);
    return this.member(this.db, memberId);
  }

  /** Q13: off at once: the member is inactive and every session ends, in one transaction. */
  async deactivate(actor: PlatformActor, memberId: string, meta: RequestMeta): Promise<PlatformMember> {
    if (memberId === actor.userId) throw ownAccount();
    await this.db.$transaction(async (tx) => {
      await this.lockStaff(tx);
      const target = await tx.platformUser.findUnique({ where: { id: memberId } });
      if (!target) throw notFound();
      if (!target.isActive) return;
      if (leavesNoOwner(target, { deactivate: true }, await this.activeOwners(tx))) throw lastOwner();
      await tx.platformUser.update({ where: { id: memberId }, data: { isActive: false } });
      const ended = await this.sessions.endAll(tx, memberId, 'deactivated');
      await platformAudit(tx, { actorId: actor.userId, action: 'platform.staff.deactivated', metadata: { memberId, sessionsEnded: ended } }, meta);
      await enqueueMail(tx, { to: target.email, subject: 'your console access was removed', text: `Your access to the UniVarse platform console was removed, and your sessions were signed out.${NOT_YOU}` });
    });
    this.changed(actor, 'deactivated', memberId);
    return this.member(this.db, memberId);
  }

  /** Q13: back, through a fresh activation: no password, no factor, a new code by email. */
  async reinstate(actor: PlatformActor, memberId: string, meta: RequestMeta): Promise<PlatformMember> {
    if (memberId === actor.userId) throw ownAccount();
    await this.db.$transaction(async (tx) => {
      await this.lockStaff(tx);
      const target = await tx.platformUser.findUnique({ where: { id: memberId } });
      if (!target) throw notFound();
      if (target.isActive) return;
      await tx.platformUser.update({ where: { id: memberId }, data: { isActive: true, passwordHash: null, failedLoginCount: 0, lockedUntil: null } });
      await this.creds.retireFactor(tx, memberId);
      const code = await this.creds.issueCode(tx, memberId, 'ACTIVATION');
      await platformAudit(tx, { actorId: actor.userId, action: 'platform.staff.reinstated', metadata: { memberId } }, meta);
      await enqueueMail(tx, activationMail(target.email, code, 'Your access to the UniVarse platform console was restored.'));
    });
    this.changed(actor, 'reinstated', memberId);
    return this.member(this.db, memberId);
  }

  /** Q14: another member lost their authenticator: the factor and recovery codes are retired and every session ends. */
  async resetMfa(actor: PlatformActor, memberId: string, meta: RequestMeta): Promise<PlatformMember> {
    if (memberId === actor.userId) throw ownAccount();
    await this.db.$transaction(async (tx) => {
      await this.lockStaff(tx);
      const target = await tx.platformUser.findUnique({ where: { id: memberId } });
      if (!target) throw notFound();
      await this.creds.retireFactor(tx, memberId);
      const ended = await this.sessions.endAll(tx, memberId, 'mfa_reset');
      await platformAudit(tx, { actorId: actor.userId, action: 'platform.staff.mfa_reset', metadata: { memberId, sessionsEnded: ended } }, meta);
      await enqueueMail(tx, { to: target.email, subject: 'your two-factor sign-in was reset', text: 'Your authenticator app was removed from your UniVarse console account by an owner. Set up a new one the next time you sign in.' + NOT_YOU });
    });
    this.changed(actor, 'mfa_reset', memberId);
    return this.member(this.db, memberId);
  }
}

/** Advisory-lock key for staff changes (an arbitrary constant, platform database only; the audit chain's is different). */
export const STAFF_LOCK = 0x75767374; // "uvst"
