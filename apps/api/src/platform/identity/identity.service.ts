// Spec 0028 Q5–Q11: the console's sign-in, as one service. A session's state is one of three, read from two columns:
//   enrol           restricted, no second factor yet: only the enrolment routes answer (Q7);
//   recovery-codes  restricted, TOTP confirmed: the codes were shown, and only their acknowledgement answers;
//   full            not restricted, TOTP passed: everything the member's role grants.
// Every change, its audit row and its mail commit together. Answers never say whether an account exists.
import { randomBytes } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { PlatformClient } from '@univarse/db';
import { ProblemError } from '../../shared/errors/problem.js';
import { securityFields } from '../../shared/observability/security.js';
import { hashPassword, passwordProblems, verifyAgainstDummy, verifyPassword } from '../../modules/identity/password.js';
import { CONSOLE_DB } from '../platform-config.js';
import { platformAudit } from './audit.js';
import { PlatformCredentials, type SecondFactor } from './credentials.js';
import { enqueueMail, NOT_YOU } from './mail.js';
import { PlatformSessions } from './sessions.js';
import type { PlatformActor, RequestMeta } from './types.js';

export type SessionState = 'enrol' | 'recovery-codes' | 'full';
export const sessionState = (a: Pick<PlatformActor, 'restricted' | 'mfaAt'>): SessionState => (!a.restricted && a.mfaAt ? 'full' : a.mfaAt ? 'recovery-codes' : 'enrol');

const invalidCredentials = () => new ProblemError(401, 'auth.invalid_credentials', 'Invalid email or password');
const invalidMfa = () => new ProblemError(401, 'auth.mfa_invalid', 'Invalid or expired verification code');
const invalidActivation = () => new ProblemError(400, 'auth.activation_invalid', 'Invalid or expired activation code');
const invalidReset = () => new ProblemError(400, 'auth.reset_invalid', 'Invalid or expired reset code');
/** The tenant API's shape (spec 0001): 422 with each problem as a field error on `password`. */
const rejectedPassword = (problems: string[]) =>
  Object.assign(new ProblemError(422, 'auth.password_rejected', 'Password does not meet the policy'), {
    errors: problems.map((p) => ({ path: 'password', code: p, message: p.replaceAll('_', ' ') })),
  });

/** Thrown inside a transaction to roll back a credential already spent. */
class Conflict extends Error {}

/** The transaction's result, or null if it rolled back on a Conflict; anything else is rethrown. */
async function orNullOnConflict<T>(work: Promise<T>): Promise<T | null> {
  try {
    return await work;
  } catch (err) {
    if (err instanceof Conflict) return null;
    throw err;
  }
}

export interface Issued {
  readonly token: string;
}

@Injectable()
export class PlatformIdentity {
  private readonly logger = new Logger('PlatformAuth');

  constructor(
    @Inject(CONSOLE_DB) private readonly db: PlatformClient,
    private readonly sessions: PlatformSessions,
    private readonly creds: PlatformCredentials,
  ) {}

  private checkPassword(password: string, user: { email: string; displayName: string }): void {
    const problems = passwordProblems(password, { minLength: 12, context: [user.email, user.displayName] });
    if (problems.length > 0) throw rejectedPassword(problems);
  }

  /** Q6: an emailed code and a new password. The session that follows is enrolment-only (Q7). */
  async activate(input: { email: string; code: string; password: string }, meta: RequestMeta): Promise<Issued> {
    const user = await this.db.platformUser.findUnique({ where: { email: input.email } });
    if (!user || !user.isActive || user.passwordHash) throw invalidActivation();
    this.checkPassword(input.password, user);
    const passwordHash = await hashPassword(input.password);
    const outcome = await orNullOnConflict(this.db.$transaction(async (tx) => {
      if (!(await this.creds.checkCode(tx, user.id, 'ACTIVATION', input.code))) return null;
      const set = await tx.platformUser.updateMany({ where: { id: user.id, passwordHash: null, isActive: true }, data: { passwordHash, failedLoginCount: 0, lockedUntil: null } });
      if (set.count !== 1) throw new Conflict();
      const session = await this.sessions.create(tx, user.id, meta, { mfaAt: null, restricted: true });
      await platformAudit(tx, { actorId: user.id, action: 'platform.auth.activated', metadata: { sessionId: session.sessionId } }, meta);
      return session;
    }));
    if (!outcome) throw invalidActivation();
    return outcome;
  }

  /**
   * Q8, Q9: a password. With a confirmed factor, the answer is a challenge (Q7); without one, an enrolment-only session.
   * An unknown, inactive, unactivated or locked account takes the same time and gets the same answer as a wrong password.
   */
  async login(input: { email: string; password: string }, meta: RequestMeta): Promise<{ next: 'mfa'; challenge: string } | { next: 'enrol'; token: string }> {
    const user = await this.db.platformUser.findUnique({ where: { email: input.email } });
    if (!user || !user.isActive || !user.passwordHash || (user.lockedUntil && user.lockedUntil > new Date())) {
      await verifyAgainstDummy(input.password);
      throw invalidCredentials();
    }
    if (!(await verifyPassword(input.password, user.passwordHash))) {
      await this.db.$transaction((tx) => this.creds.recordFailure(tx, user, 'login', meta));
      throw invalidCredentials();
    }
    return this.db.$transaction(async (tx) => {
      if (await this.creds.hasFactor(tx, user.id)) {
        await platformAudit(tx, { actorId: user.id, action: 'platform.auth.password_accepted' }, meta);
        return { next: 'mfa' as const, challenge: await this.creds.startChallenge(tx, user.id, meta.ip) };
      }
      await tx.platformUser.update({ where: { id: user.id }, data: { failedLoginCount: 0 } });
      const session = await this.sessions.create(tx, user.id, meta, { mfaAt: null, restricted: true });
      await platformAudit(tx, { actorId: user.id, action: 'platform.auth.signed_in', metadata: { sessionId: session.sessionId, state: 'enrol' } }, meta);
      return { next: 'enrol' as const, token: session.token };
    });
  }

  /**
   * Q7, Q10: a challenge and a TOTP or recovery code give a full session. A wrong code spends the challenge's attempt
   * and counts toward the lockout (committed before the refusal). A browser this member hasn't used before gets a
   * new device id, and the member an email.
   */
  async verify(challengeToken: string, input: SecondFactor, deviceId: string | null, meta: RequestMeta): Promise<Issued & { deviceId: string | null }> {
    const now = new Date();
    const outcome = await orNullOnConflict(
      this.db.$transaction(async (tx) => {
        const challenge = await this.creds.reserveChallenge(tx, challengeToken, now);
        if (!challenge) return null;
        const user = await tx.platformUser.findUniqueOrThrow({ where: { id: challenge.userId } });
        if (!user.isActive || (user.lockedUntil && user.lockedUntil > now)) return null;
        const second = await this.creds.checkSecondFactor(tx, user.id, input, now);
        if (!second.ok) {
          await this.creds.recordFailure(tx, user, 'second_factor', meta);
          return null;
        }
        // A credential is spent from here: a failure must roll back, not commit.
        if (!(await this.creds.consumeChallenge(tx, challenge.id, now))) throw new Conflict();
        await tx.platformUser.update({ where: { id: user.id }, data: { failedLoginCount: 0, lastLoginAt: now } });
        const session = await this.sessions.create(tx, user.id, meta, { mfaAt: now, restricted: false });
        if (second.usedRecovery) {
          const remaining = await this.creds.remainingRecoveryCodes(tx, user.id);
          await platformAudit(tx, { actorId: user.id, action: 'platform.auth.recovery_code_used', metadata: { remaining, context: 'sign_in' } }, meta);
          await enqueueMail(tx, { to: user.email, subject: 'a recovery code was used to sign in', text: `A recovery code was just used to sign in to your UniVarse console account. ${String(remaining)} recovery code(s) remain.${NOT_YOU}` });
        }
        const issuedDevice = await this.recordDevice(tx, user, deviceId, now, meta);
        await platformAudit(tx, { actorId: user.id, action: 'platform.auth.signed_in', metadata: { sessionId: session.sessionId, state: 'full', secondFactor: second.usedRecovery ? 'recovery_code' : 'totp', newDevice: issuedDevice !== null } }, meta);
        return { token: session.token, deviceId: issuedDevice };
      }),
    );
    if (!outcome) throw invalidMfa();
    return outcome;
  }

  /** Q10: the browser's device id is known (seen again), or a new one is issued and the member emailed. */
  private async recordDevice(tx: Parameters<Parameters<PlatformClient['$transaction']>[0]>[0], user: { id: string; email: string }, deviceId: string | null, now: Date, meta: RequestMeta): Promise<string | null> {
    if (deviceId) {
      const seen = await tx.platformKnownDevice.updateMany({ where: { userId: user.id, deviceHash: this.creds.deviceHash(user.id, deviceId) }, data: { lastSeenAt: now } });
      if (seen.count === 1) return null;
    }
    const fresh = randomBytes(32).toString('base64url');
    await tx.platformKnownDevice.create({ data: { userId: user.id, deviceHash: this.creds.deviceHash(user.id, fresh) } });
    await enqueueMail(tx, {
      to: user.email,
      subject: 'new sign-in to the console',
      text: `Your UniVarse console account was signed in to from a browser not seen before.\n\nTime: ${now.toISOString()}\nAddress: ${meta.ip}\nBrowser: ${(meta.userAgent ?? 'unknown').slice(0, 200)}${NOT_YOU}`,
    });
    return fresh;
  }

  /** Always the same answer; a code is sent only to an active, activated member. */
  async requestPasswordReset(email: string, meta: RequestMeta): Promise<void> {
    const user = await this.db.platformUser.findUnique({ where: { email } });
    if (!user || !user.isActive || !user.passwordHash) return;
    await this.db.$transaction(async (tx) => {
      const code = await this.creds.issueCode(tx, user.id, 'PASSWORD_RESET');
      await platformAudit(tx, { actorId: user.id, action: 'platform.auth.password_reset_requested' }, meta);
      await enqueueMail(tx, { to: user.email, subject: 'your password reset code', text: `Your UniVarse console password reset code is ${code}. It expires in 15 minutes.${NOT_YOU}` });
    });
  }

  /** A reset code and a new password; every session of the member ends. TOTP is still needed to sign in. */
  async confirmPasswordReset(input: { email: string; code: string; password: string }, meta: RequestMeta): Promise<void> {
    const user = await this.db.platformUser.findUnique({ where: { email: input.email } });
    if (!user || !user.isActive || !user.passwordHash) throw invalidReset();
    this.checkPassword(input.password, user);
    const passwordHash = await hashPassword(input.password);
    const ok = await this.db.$transaction(async (tx) => {
      if (!(await this.creds.checkCode(tx, user.id, 'PASSWORD_RESET', input.code))) return false;
      await tx.platformUser.update({ where: { id: user.id }, data: { passwordHash, failedLoginCount: 0, lockedUntil: null } });
      const ended = await this.sessions.endAll(tx, user.id, 'password_reset');
      await platformAudit(tx, { actorId: user.id, action: 'platform.auth.password_reset', metadata: { sessionsEnded: ended } }, meta);
      await enqueueMail(tx, { to: user.email, subject: 'your password was changed', text: `The password of your UniVarse console account was just changed, and every session was signed out.${NOT_YOU}` });
      return true;
    });
    if (!ok) throw invalidReset();
  }

  /** Signing out of a session that already ended is not an error. */
  async logout(actor: PlatformActor, meta: RequestMeta): Promise<void> {
    try {
      await this.db.$transaction(async (tx) => {
        await this.sessions.retire(tx, actor.sessionId, 'logout');
        await platformAudit(tx, { actorId: actor.userId, action: 'platform.auth.signed_out', metadata: { sessionId: actor.sessionId } }, meta);
      });
    } catch (err) {
      if (!(err instanceof ProblemError && err.status === 401)) throw err;
    }
  }

  /** Q7: from an enrolment-only session; refused once a factor is confirmed (resetting one is an OWNER's, Q14). */
  async beginEnrolment(actor: PlatformActor, meta: RequestMeta): Promise<{ secret: string; otpauthUri: string }> {
    if (sessionState(actor) !== 'enrol') throw new ProblemError(409, 'auth.mfa_already_enrolled', 'MFA is already set up');
    return this.db.$transaction(async (tx) => {
      if (await this.creds.hasFactor(tx, actor.userId)) throw new ProblemError(409, 'auth.mfa_already_enrolled', 'MFA is already set up');
      const started = await this.creds.beginFactor(tx, { id: actor.userId, email: actor.email });
      await platformAudit(tx, { actorId: actor.userId, action: 'platform.mfa.enrolment_started' }, meta);
      return started;
    });
  }

  /** Q7: a code confirms the factor; 10 recovery codes are returned once, and the session moves to `recovery-codes`. */
  async confirmEnrolment(actor: PlatformActor, code: string, meta: RequestMeta): Promise<Issued & { recoveryCodes: string[] }> {
    if (sessionState(actor) !== 'enrol') throw new ProblemError(409, 'auth.mfa_already_enrolled', 'MFA is already set up');
    return this.db.$transaction(async (tx) => {
      if (!(await this.creds.confirmFactor(tx, actor.userId, code))) throw invalidMfa();
      const recoveryCodes = await this.creds.newRecoveryCodes(tx, actor.userId);
      const now = new Date();
      const session = await this.sessions.rotate(tx, actor, meta, 'mfa_enrolled', { mfaAt: now, restricted: true });
      await platformAudit(tx, { actorId: actor.userId, action: 'platform.mfa.enrolled', metadata: { recoveryCodes: recoveryCodes.length } }, meta);
      await enqueueMail(tx, { to: actor.email, subject: 'two-factor sign-in was set up', text: `An authenticator app was set up for your UniVarse console account.${NOT_YOU}` });
      return { token: session.token, recoveryCodes };
    });
  }

  /** Q7: the member says the recovery codes are saved; only now is the session a full one. */
  async acknowledgeRecoveryCodes(actor: PlatformActor, meta: RequestMeta): Promise<Issued> {
    if (sessionState(actor) !== 'recovery-codes') throw new ProblemError(409, 'auth.mfa_not_enrolled', 'Nothing to acknowledge');
    return this.db.$transaction(async (tx) => {
      const now = new Date();
      await tx.platformUser.update({ where: { id: actor.userId }, data: { lastLoginAt: now } });
      const session = await this.sessions.rotate(tx, actor, meta, 'recovery_codes_saved', { mfaAt: actor.mfaAt, restricted: false });
      await platformAudit(tx, { actorId: actor.userId, action: 'platform.mfa.recovery_codes_saved', metadata: { sessionId: session.sessionId } }, meta);
      return session;
    });
  }

  /**
   * Q11: a TOTP or recovery code again, on a full session: a new token, step-up recorded on it. A wrong code counts
   * toward the lockout. If the session died meanwhile, nothing is spent.
   */
  async stepUp(actor: PlatformActor, input: SecondFactor, meta: RequestMeta): Promise<Issued> {
    const now = new Date();
    const outcome = await this.db.$transaction(async (tx) => {
      const user = await tx.platformUser.findUniqueOrThrow({ where: { id: actor.userId } });
      const second = await this.creds.checkSecondFactor(tx, actor.userId, input, now);
      if (!second.ok) {
        await this.creds.recordFailure(tx, user, 'step_up', meta);
        return null;
      }
      await tx.platformUser.update({ where: { id: actor.userId }, data: { failedLoginCount: 0 } });
      const session = await this.sessions.rotate(tx, actor, meta, 'step_up', { mfaAt: actor.mfaAt, restricted: false, stepUpAt: now });
      if (second.usedRecovery) {
        const remaining = await this.creds.remainingRecoveryCodes(tx, actor.userId);
        await platformAudit(tx, { actorId: actor.userId, action: 'platform.auth.recovery_code_used', metadata: { remaining, context: 'step_up' } }, meta);
        await enqueueMail(tx, { to: user.email, subject: 'a recovery code was used', text: `A recovery code was just used to confirm your identity in the UniVarse console. ${String(remaining)} recovery code(s) remain.${NOT_YOU}` });
      }
      await platformAudit(tx, { actorId: actor.userId, action: 'platform.auth.stepped_up', metadata: { sessionId: session.sessionId } }, meta);
      return session;
    });
    if (!outcome) {
      this.logger.warn(securityFields('platform.step_up.failed', { userId: actor.userId }), 'Console step-up failed');
      throw invalidMfa();
    }
    return outcome;
  }

  /** Q11: ten new recovery codes (every earlier one dies), and the member's other sessions end. Needs a step-up. */
  async regenerateRecoveryCodes(actor: PlatformActor, meta: RequestMeta): Promise<string[]> {
    return this.db.$transaction(async (tx) => {
      if (!(await this.creds.hasFactor(tx, actor.userId))) throw new ProblemError(409, 'auth.mfa_not_enrolled', 'MFA is not set up');
      const codes = await this.creds.newRecoveryCodes(tx, actor.userId);
      const ended = await this.sessions.endAll(tx, actor.userId, 'recovery_codes_regenerated', actor.sessionId);
      await platformAudit(tx, { actorId: actor.userId, action: 'platform.mfa.recovery_codes_regenerated', metadata: { sessionsEnded: ended } }, meta);
      await enqueueMail(tx, { to: actor.email, subject: 'your recovery codes were replaced', text: `New recovery codes were made for your UniVarse console account. Every earlier code no longer works, and your other sessions were signed out.${NOT_YOU}` });
      return codes;
    });
  }

  async listSessions(actor: PlatformActor) {
    const now = new Date();
    const rows = await this.db.platformSession.findMany({
      where: { userId: actor.userId, revokedAt: null, idleExpiresAt: { gt: now }, absoluteExpiresAt: { gt: now } },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((s) => ({ id: s.id, current: s.id === actor.sessionId, createdAt: s.createdAt.toISOString(), lastSeenAt: s.lastSeenAt.toISOString(), ip: s.ip, userAgent: s.userAgent }));
  }

  /** Ends one of the member's own sessions; another member's is not found (404). */
  async endSession(actor: PlatformActor, sessionId: string, meta: RequestMeta): Promise<void> {
    await this.db.$transaction(async (tx) => {
      const n = await tx.platformSession.updateMany({ where: { id: sessionId, userId: actor.userId, revokedAt: null }, data: { revokedAt: new Date(), revokeReason: 'ended_by_member' } });
      if (n.count !== 1) throw new ProblemError(404, 'resource.not_found', 'Not found');
      await platformAudit(tx, { actorId: actor.userId, action: 'platform.session.ended', metadata: { sessionId } }, meta);
    });
  }
}
