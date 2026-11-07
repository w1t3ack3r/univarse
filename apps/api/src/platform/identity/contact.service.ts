// Spec 0032: changing a member's address. Whoever can change it can take the account over, so nothing changes until
// the new address is proven, the old one is told and can undo it, and a change someone else started also takes the
// person's password. Every step holds the staff lock, so two changes can't race for one address, and every completed
// change commits with its audit row and its mail. No address reaches an audit row, a log line, a URL or an error (Q12).
import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import type { PlatformClient } from '@univarse/db';
import { CONTACT_CODE_MAX_ATTEMPTS, CONTACT_CODE_TTL_MS, mayMarkOldAddressWrong, maskAddress, needsPassword, undoDeadline, withinRequestLimit, type ContactChangeKind } from '@univarse/domain';
import { ProblemError } from '../../shared/errors/problem.js';
import { backgroundPass } from '../../shared/observability/background.js';
import { securityFields } from '../../shared/observability/security.js';
import { verifyAgainstDummy, verifyPassword } from '../../modules/identity/password.js';
import { newOneTimeCode } from '../../modules/identity/tokens.js';
import { CONSOLE_DB, PLATFORM_CONFIG, type PlatformConfig } from '../platform-config.js';
import { platformAudit } from './audit.js';
import { PlatformCredentials } from './credentials.js';
import { enqueueMail, NOT_YOU } from './mail.js';
import { PlatformSessions } from './sessions.js';
import { activationMail, STAFF_LOCK } from './staff.service.js';
import type { PlatformActor, PlatformTx, RequestMeta } from './types.js';

const HOUR_MS = 3_600_000;

const invalidCode = () => new ProblemError(400, 'contact.code_invalid', 'Invalid or expired code');
const invalidUndo = () => new ProblemError(400, 'contact.undo_invalid', 'Invalid or expired undo code');
const tooMany = () => new ProblemError(429, 'contact.too_many', 'Too many address changes. Try again in an hour.');
const sameAddress = () => new ProblemError(422, 'contact.same_address', 'That is already the address on this account');
const notFound = () => new ProblemError(404, 'resource.not_found', 'Not found');

const lockStaff = (tx: PlatformTx) => tx.$executeRaw`SELECT pg_advisory_xact_lock(${STAFF_LOCK})`;

/** An address in use: another member's, or one held for the 72 hours an undo may need it back (Q6). */
export async function addressTaken(tx: PlatformTx, address: string, userId: string): Promise<boolean> {
  if (await tx.platformUser.findUnique({ where: { email: address }, select: { id: true } })) return true;
  const held = await tx.platformContactChange.findFirst({ where: { oldAddress: address, status: 'CONFIRMED', undoUntil: { gt: new Date() }, userId: { not: userId } }, select: { id: true } });
  return held !== null;
}

/**
 * Starts a change: one pending per account (Q3), counted against both limits. A taken address gets a notice and a code
 * it never receives, so the row, the timing and the answer are the same either way (Q4).
 */
export async function openContactChange(
  tx: PlatformTx,
  creds: PlatformCredentials,
  change: { user: { id: string }; newAddress: string; kind: ContactChangeKind; requestedBy: string | null; oldAddressWrong: boolean },
  meta?: RequestMeta,
): Promise<void> {
  const { user, newAddress, kind } = change;
  const since = new Date(Date.now() - HOUR_MS);
  const [mine, theirs] = await Promise.all([
    tx.platformContactChange.count({ where: { userId: user.id, createdAt: { gt: since } } }),
    tx.platformContactChange.count({ where: { newAddress, createdAt: { gt: since } } }),
  ]);
  if (!withinRequestLimit(mine) || !withinRequestLimit(theirs)) throw tooMany();
  await tx.platformContactChange.updateMany({ where: { userId: user.id, status: 'PENDING' }, data: { status: 'REPLACED', codeHash: null } });
  const taken = await addressTaken(tx, newAddress, user.id);
  const code = newOneTimeCode();
  const { id } = await tx.platformContactChange.create({
    data: {
      userId: user.id,
      kind,
      requestedBy: change.requestedBy,
      newAddress,
      oldAddressWrong: mayMarkOldAddressWrong(kind) && change.oldAddressWrong,
      // For a taken address this code is never sent, and confirming refuses it anyway: it fails as a wrong code does.
      codeHash: creds.contactHash(user.id, newAddress, code),
      expiresAt: new Date(Date.now() + CONTACT_CODE_TTL_MS),
    },
    select: { id: true },
  });
  await platformAudit(tx, { actorId: change.requestedBy, action: 'platform.contact.change_requested', metadata: { memberId: user.id, changeId: id, kind, oldAddressWrong: change.oldAddressWrong } }, meta);
  await enqueueMail(
    tx,
    taken
      ? { to: newAddress, subject: 'someone tried to use this address', text: `Someone tried to move a UniVarse console account to this address, which is already in use. Nothing has changed, and you don't need to do anything.${NOT_YOU}` }
      : {
          to: newAddress,
          subject: 'confirm your new address',
          text:
            kind === 'SELF'
              ? `Your code to confirm this address is ${code}. It expires in 15 minutes. Enter it in Your account in the console.${NOT_YOU}`
              : `Your console address is being corrected to this one. Your code is ${code}. It expires in 15 minutes. Open the console, choose "Confirm a new address", and enter the code and your password.${NOT_YOU}`,
        },
  );
}

@Injectable()
export class PlatformContact implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('PlatformContact');
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(CONSOLE_DB) private readonly db: PlatformClient,
    @Inject(PLATFORM_CONFIG) private readonly config: PlatformConfig,
    private readonly sessions: PlatformSessions,
    private readonly creds: PlatformCredentials,
  ) {}

  onApplicationBootstrap(): void {
    const every = this.config.CONTACT_BLANK_INTERVAL_MS;
    if (every === 0) return;
    this.timer = setInterval(() => void backgroundPass(this.logger, 'platform.contact.blank_failed', () => this.blank()), every);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Q12: a change's row stays; its addresses and codes go. Returns how many. */
  async blank(now = new Date()): Promise<number> {
    const { count } = await this.db.platformContactChange.updateMany({
      where: {
        blankedAt: null,
        OR: [
          { status: 'UNDONE' },
          { status: 'CONFIRMED', confirmedAt: { lt: new Date(now.getTime() - 72 * HOUR_MS) } },
          { status: { in: ['PENDING', 'REPLACED'] }, expiresAt: { lt: new Date(now.getTime() - HOUR_MS) } },
        ],
      },
      data: { newAddress: null, oldAddress: null, codeHash: null, undoHash: null, blankedAt: now },
    });
    return count;
  }

  /** The change a member has waiting: enough for the page to pick up after a reload. */
  async pending(actor: PlatformActor): Promise<{ address: string; expiresAt: string } | null> {
    const row = await this.db.platformContactChange.findFirst({ where: { userId: actor.userId, kind: 'SELF', status: 'PENDING', expiresAt: { gt: new Date() } }, orderBy: { createdAt: 'desc' } });
    return row?.newAddress ? { address: row.newAddress, expiresAt: row.expiresAt.toISOString() } : null;
  }

  /** Q2: the guard has required a step-up. Always the same answer, whatever the address (Q4). */
  async requestOwn(actor: PlatformActor, newAddress: string, meta: RequestMeta): Promise<void> {
    if (newAddress === actor.email) throw sameAddress();
    await this.db.$transaction(async (tx) => {
      await lockStaff(tx);
      await openContactChange(tx, this.creds, { user: { id: actor.userId }, newAddress, kind: 'SELF', requestedBy: actor.userId, oldAddressWrong: false }, meta);
    });
  }

  /** Q2, Q5: a code for this account's pending change. This session stays; every other ends. */
  async confirmOwn(actor: PlatformActor, code: string, meta: RequestMeta): Promise<void> {
    const done = await this.db.$transaction(async (tx) => {
      await lockStaff(tx);
      const now = new Date();
      const row = await tx.platformContactChange.findFirst({ where: { userId: actor.userId, kind: 'SELF', status: 'PENDING', expiresAt: { gt: now } }, orderBy: { createdAt: 'desc' } });
      if (!row) return false;
      if (!(await this.spendAttempt(tx, row.id, now))) return false;
      if (!this.creds.contactCodeMatches(row, code)) return false;
      return this.complete(tx, row, actor.sessionId, meta);
    });
    if (!done) throw invalidCode();
  }

  /**
   * Q7: signed out, because the person may have lost their old mailbox. The code and their password, both: wrong either
   * way spends an attempt and answers alike. The password is checked outside the transaction, as sign-in's is.
   */
  async confirmCorrection(input: { email: string; code: string; password: string }, meta: RequestMeta): Promise<void> {
    const now = new Date();
    const row = await this.db.platformContactChange.findFirst({
      where: { newAddress: input.email, status: 'PENDING', expiresAt: { gt: now } },
      orderBy: { createdAt: 'desc' },
      include: { user: true },
    });
    const { user } = row ?? {};
    if (!row || !needsPassword(row.kind) || !user?.passwordHash || !user.isActive || user.passwordResetRequired || (user.lockedUntil && user.lockedUntil > now)) {
      await verifyAgainstDummy(input.password);
      throw invalidCode();
    }
    const passwordOk = await verifyPassword(input.password, user.passwordHash);
    const done = await this.db.$transaction(async (tx) => {
      await lockStaff(tx);
      if (!(await this.spendAttempt(tx, row.id, now))) return false;
      if (!passwordOk || !this.creds.contactCodeMatches(row, input.code)) return false;
      return this.complete(tx, row, null, meta);
    });
    if (!done) throw invalidCode();
  }

  /** Spends one attempt, committed even when the code then proves wrong. */
  private async spendAttempt(tx: PlatformTx, id: string, now: Date): Promise<boolean> {
    const n = await tx.platformContactChange.updateMany({ where: { id, status: 'PENDING', expiresAt: { gt: now }, attempts: { lt: CONTACT_CODE_MAX_ATTEMPTS } }, data: { attempts: { increment: 1 } } });
    return n.count === 1;
  }

  /** Q5: one transaction. Returns false, changing nothing, if the address was taken after the code went out. */
  private async complete(tx: PlatformTx, row: { id: string; userId: string; kind: ContactChangeKind; newAddress: string | null; oldAddressWrong: boolean }, keepSession: string | null, meta: RequestMeta): Promise<boolean> {
    const newAddress = row.newAddress;
    if (!newAddress || (await addressTaken(tx, newAddress, row.userId))) return false;
    const user = await tx.platformUser.findUniqueOrThrow({ where: { id: row.userId } });
    const now = new Date();
    const undoCode = row.oldAddressWrong ? null : this.creds.newUndoCode();
    await tx.platformUser.update({ where: { id: user.id }, data: { email: newAddress, emailVerifiedAt: now } });
    await tx.platformContactChange.update({
      where: { id: row.id },
      data: { status: 'CONFIRMED', oldAddress: user.email, confirmedAt: now, codeHash: null, undoHash: undoCode ? this.creds.undoHash(user.id, user.email, undoCode) : null, undoUntil: undoCode ? undoDeadline(now) : null },
    });
    // What was issued for the old address dies with it: a reset code sent there must not outlive the change.
    await this.creds.retireCodes(tx, user.id);
    const sessionsEnded = await this.sessions.endAll(tx, user.id, 'email_changed', keepSession ?? undefined);
    await platformAudit(tx, { actorId: row.kind === 'SELF' ? user.id : null, action: 'platform.contact.changed', metadata: { memberId: user.id, changeId: row.id, kind: row.kind, oldAddressWrong: row.oldAddressWrong, sessionsEnded } }, meta);
    await enqueueMail(tx, { to: newAddress, subject: 'this is now your address', text: `This is now the address of your UniVarse console account, and what you sign in with. Your other sessions were signed out.${NOT_YOU}` });
    if (undoCode) {
      await enqueueMail(tx, {
        to: user.email,
        subject: 'your address was changed',
        text: `The address of your UniVarse console account was changed to ${maskAddress(newAddress)}, and your other sessions were signed out.\n\nIf this wasn't you, open the console and choose "Undo an address change". Your undo code is ${undoCode}. It works for 72 hours.${NOT_YOU}`,
      });
    }
    return true;
  }

  /**
   * Q6: restores the old address, ends every session, and makes the password useless until it's replaced. Later
   * changes can't be undone after this; earlier ones still can, so an intruder who moved the account twice can't use
   * their own undo to close the owner's.
   */
  async undo(input: { email: string; code: string }, meta: RequestMeta): Promise<void> {
    const done = await this.db.$transaction(async (tx) => {
      await lockStaff(tx);
      const now = new Date();
      const row = await tx.platformContactChange.findFirst({ where: { oldAddress: input.email, status: 'CONFIRMED', undoUntil: { gt: now } }, orderBy: { confirmedAt: 'desc' } });
      if (!row?.confirmedAt || !row.undoHash) return null;
      const spent = await tx.platformContactChange.updateMany({ where: { id: row.id, status: 'CONFIRMED', undoAttempts: { lt: CONTACT_CODE_MAX_ATTEMPTS } }, data: { undoAttempts: { increment: 1 } } });
      if (spent.count !== 1) return null;
      if (!this.creds.undoMatches(row.undoHash, row.userId, input.email, input.code)) return null;
      const user = await tx.platformUser.findUniqueOrThrow({ where: { id: row.userId } });
      await tx.platformUser.update({ where: { id: user.id }, data: { email: input.email, emailVerifiedAt: now, passwordResetRequired: true } });
      await tx.platformContactChange.update({ where: { id: row.id }, data: { status: 'UNDONE', undoneAt: now, undoHash: null, undoUntil: null } });
      await tx.platformContactChange.updateMany({ where: { userId: user.id, confirmedAt: { gt: row.confirmedAt } }, data: { undoHash: null, undoUntil: null } });
      await tx.platformContactChange.updateMany({ where: { userId: user.id, status: 'PENDING' }, data: { status: 'REPLACED', codeHash: null } });
      await this.creds.retireCodes(tx, user.id);
      await this.creds.retireChallenges(tx, user.id);
      const sessionsEnded = await this.sessions.endAll(tx, user.id, 'email_change_undone');
      await platformAudit(tx, { actorId: null, action: 'platform.contact.undone', metadata: { memberId: user.id, changeId: row.id, sessionsEnded } }, meta);
      await enqueueMail(tx, { to: input.email, subject: 'your address was restored', text: `This address is back on your UniVarse console account, and every session was signed out. To sign in again, choose "Forgot your password?" and set a new one. Your old password no longer works.${NOT_YOU}` });
      return user.id;
    });
    if (!done) throw invalidUndo();
    this.logger.warn(securityFields('identity.email_change.undone', { memberId: done }), 'An address change was undone');
  }

  /**
   * Q7, Q8, Q9: an OWNER with a fresh step-up. Not activated yet: the address changes now, and activation proves it.
   * Activated: a change the person finishes with a code and their password. Unlike a member's own request this may say
   * an address is taken: the same OWNER sees the whole staff list.
   */
  async correct(actor: PlatformActor, memberId: string, input: { email: string; oldAddressWrong: boolean }, meta: RequestMeta): Promise<void> {
    if (memberId === actor.userId) throw new ProblemError(409, 'staff.own_account', 'Change your own address in Your account');
    await this.db.$transaction(async (tx) => {
      await lockStaff(tx);
      const target = await tx.platformUser.findUnique({ where: { id: memberId } });
      if (!target) throw notFound();
      if (!target.isActive) throw new ProblemError(409, 'contact.member_inactive', 'Restore their access first');
      if (target.email === input.email) throw sameAddress();
      if (await addressTaken(tx, input.email, target.id)) throw new ProblemError(409, 'staff.email_taken', 'That email is already a member');
      if (!target.passwordHash) {
        await tx.platformUser.update({ where: { id: target.id }, data: { email: input.email, emailVerifiedAt: null } });
        const code = await this.creds.issueCode(tx, target.id, 'ACTIVATION');
        await platformAudit(tx, { actorId: actor.userId, action: 'platform.contact.corrected_unactivated', metadata: { memberId: target.id } }, meta);
        await enqueueMail(tx, activationMail(input.email, code, 'Your address on the UniVarse platform console was corrected.'));
        return;
      }
      await openContactChange(tx, this.creds, { user: target, newAddress: input.email, kind: 'ADMIN', requestedBy: actor.userId, oldAddressWrong: input.oldAddressWrong }, meta);
    });
    this.logger.warn(securityFields('platform.staff.changed', { actorId: actor.userId, action: 'address_corrected', targetId: memberId }), 'Platform staff changed');
  }
}
