import { Inject, Injectable, Logger } from '@nestjs/common';
import type { TenantTx } from '@univarse/db';
import { AuditWriter } from '../../shared/audit/audit-writer.js';
import { ShardRegistry } from '../../shared/db/db.module.js';
import { ProblemError } from '../../shared/errors/problem.js';
import { RateLimiter } from '../../shared/infra/rate-limiter.js';
import { Outbox } from '../../shared/outbox/outbox.js';
import { withMinimumDuration } from '../../shared/http/timing.js';
import type { TenantContext } from '../../shared/tenancy/tenant-resolver.service.js';
import { needsMfa, type Actor } from './actor.js';
import { MfaService } from './mfa.service.js';
import { OneTimeCodeService, type CodePurpose } from './one-time-code.service.js';
import { PasswordAttempts } from './password-attempts.service.js';
import { hashPassword, needsRehash, passwordProblems, verifyAgainstDummy } from './password.js';
import { SessionService, type SessionMeta } from './session.service.js';
import { normaliseIdentifier } from './tokens.js';

/** Response-time floors for enumeration-sensitive endpoints (R15). Above the slowest non-success path. */
const REQUEST_FLOOR_MS = 400;
const CONFIRM_FLOOR_MS = 400;
/** Same floor as MFA verify (S11). */
const STEP_UP_FLOOR_MS = 400;

const invalidCredentials = () => new ProblemError(401, 'auth.invalid_credentials', 'Invalid username or password');
const invalidCode = (purpose: CodePurpose) =>
  purpose === 'ACTIVATION'
    ? new ProblemError(400, 'auth.activation_invalid', 'Invalid or expired activation code')
    : new ProblemError(400, 'auth.reset_invalid', 'Invalid or expired reset code');

/** Which account status each code flow serves (spec 0001 R11). */
const ELIGIBLE_STATUS: Record<CodePurpose, 'PENDING_ACTIVATION' | 'ACTIVE'> = {
  ACTIVATION: 'PENDING_ACTIVATION',
  PASSWORD_RESET: 'ACTIVE',
};

type UserWithRoles = Awaited<ReturnType<typeof findUserWithRoles>>;

function findUserWithRoles(tx: TenantTx, raw: string) {
  const id = normaliseIdentifier(raw);
  return tx.userAccount.findFirst({
    where: id.kind === 'email' ? { email: id.value } : { username: id.value },
    include: { roleAssignments: { include: { role: true } } },
  });
}

export type LoginResult =
  | { kind: 'mfa_challenge'; challengeToken: string }
  | {
    kind: 'session';
    token: string;
    maxAgeSec: number;
    user: { id: string; username: string; displayName: string };
    mfaEnrolmentRequired: boolean;
  };

@Injectable()
export class AuthService {
  private readonly logger = new Logger('Auth');

  constructor(
    private readonly shards: ShardRegistry,
    private readonly sessions: SessionService,
    private readonly codes: OneTimeCodeService,
    private readonly mfa: MfaService,
    private readonly passwords: PasswordAttempts,
    private readonly limiter: RateLimiter,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
  ) { }

  private async limit(key: string, rules: { limit: number; windowSec: number }[]): Promise<void> {
    const r = await this.limiter.hit(key, rules);
    if (!r.allowed) {
      throw Object.assign(new ProblemError(429, 'request.rate_limited', 'Too many attempts. Try again later.'), {
        retryAfterSec: r.retryAfterSec,
      });
    }
  }

  /** Login's buckets, shared by step-up (S5): the same keys AND the same rules (counters are per window). */
  private async limitPasswordAttempt(tenant: TenantContext, ip: string, identifier: string): Promise<void> {
    await this.limit(`${tenant.tenantId}:login:ip:${ip}`, [{ limit: 50, windowSec: 60 }]);
    await this.limit(`${tenant.tenantId}:login:ipid:${ip}:${identifier}`, [
      { limit: 5, windowSec: 60 },
      { limit: 20, windowSec: 3600 },
    ]);
  }

  private assertPasswordPolicy(tenant: TenantContext, user: NonNullable<UserWithRoles>, password: string): void {
    const isStaff = user.roleAssignments.some((a) => a.role.key !== 'STUDENT' && a.role.key !== 'APPLICANT');
    const problems = passwordProblems(password, {
      minLength: isStaff ? 12 : 8,
      context: [user.username, user.displayName, user.email ?? '', tenant.shortName, tenant.slug],
    });
    if (problems.length > 0) {
      throw Object.assign(new ProblemError(422, 'auth.password_rejected', 'Password does not meet the policy'), {
        errors: problems.map((p) => ({ path: 'password', code: p, message: p.replaceAll('_', ' ') })),
      });
    }
  }

  /**
   * Emails a code for activation or reset. Identical outcome for every input (no enumeration, R1).
   */
  private async requestCode(tenant: TenantContext, purpose: CodePurpose, rawUsername: string, ip: string): Promise<void> {
    const id = normaliseIdentifier(rawUsername);
    const k = purpose === 'ACTIVATION' ? 'act' : 'reset';
    await this.limit(`${tenant.tenantId}:${k}-req:ip:${ip}`, [{ limit: 20, windowSec: 900 }]);
    await this.limit(`${tenant.tenantId}:${k}-req:id:${id.value}`, [{ limit: 3, windowSec: 900 }]);

    const what = purpose === 'ACTIVATION' ? 'activation' : 'password reset';
    await this.shards.tx(tenant.shardId, tenant.tenantId, async (tx) => {
      const user = await findUserWithRoles(tx, rawUsername);
      if (!user || user.status !== ELIGIBLE_STATUS[purpose] || !user.email) return;
      const code = await this.codes.issue(tx, tenant.tenantId, user.id, purpose);
      // Spec 0002 B1/B7: enqueued with the code and delivered by the worker. No SMTP on this path (R15).
      await this.outbox.enqueueEmail(tx, tenant.tenantId, {
        to: user.email,
        subject: `${tenant.shortName}: your UniVarse ${what} code`,
        text: `Your ${what} code is ${code}. It expires in 15 minutes.\n\nIf you did not request this, ignore this email — your account is unchanged.`,
      });
    });
  }

  /**
   * Verifies a code and sets a new password. Wrong codes are counted in a committed transaction
   * before failing (R3); policy failures roll back without consuming the code (R5).
   */
  private async confirmCode(
    tenant: TenantContext,
    purpose: CodePurpose,
    input: { username: string; code: string; password: string },
    ip: string,
  ): Promise<void> {
    const k = purpose === 'ACTIVATION' ? 'act' : 'reset';
    await this.limit(`${tenant.tenantId}:${k}-confirm:ip:${ip}`, [{ limit: 30, windowSec: 900 }]);

    const outcome = await this.shards.tx(tenant.shardId, tenant.tenantId, async (tx) => {
      const user = await findUserWithRoles(tx, input.username);
      if (!user || user.status !== ELIGIBLE_STATUS[purpose]) return { ok: false as const };
      // Spends one attempt atomically and consumes the code on success (R12, R13).
      const check = await this.codes.check(tx, user.id, purpose, input.code);
      if (!check.ok) return { ok: false as const };

      this.assertPasswordPolicy(tenant, user, input.password);
      const now = new Date();
      await tx.userAccount.update({
        where: { id: user.id },
        data: {
          passwordHash: await hashPassword(input.password),
          status: 'ACTIVE',
          failedLoginCount: 0, // R8
          lockedUntil: null,
        },
      });
      if (purpose === 'PASSWORD_RESET') {
        // R6: every session of the user dies, including any that asked for the reset.
        await tx.session.updateMany({
          where: { userId: user.id, revokedAt: null },
          data: { revokedAt: now, revokeReason: 'password_reset' },
        });
        // M11 / R16: a challenge started before the reset can never be completed after it.
        await tx.mfaChallenge.updateMany({ where: { userId: user.id, usedAt: null, revokedAt: null }, data: { revokedAt: now } });
      }
      // Spec 0002 A1/A7: recorded in the same transaction as the password change.
      await this.audit.write(tx, tenant.tenantId, {
        actorType: 'USER',
        actorId: user.id,
        action: purpose === 'ACTIVATION' ? 'auth.activation.completed' : 'auth.password_reset.completed',
        entityType: 'user_account',
        entityId: user.id,
        after: { status: 'ACTIVE', sessionsRevoked: purpose === 'PASSWORD_RESET' },
        ip,
      });
      if (purpose === 'PASSWORD_RESET' && user.email) {
        // R9: notification only — no code, no link. Enqueued with the change (spec 0002 B1).
        await this.outbox.enqueueEmail(tx, tenant.tenantId, {
          to: user.email,
          subject: `${tenant.shortName}: your UniVarse password was changed`,
          text:
            'The password for your UniVarse account was just changed and all your sessions were signed out.\n\n' +
            'If this was not you, contact your institution’s ICT unit immediately.',
        });
      }
      return { ok: true as const };
    });
    if (!outcome.ok) throw invalidCode(purpose);
  }

  requestActivation(tenant: TenantContext, rawUsername: string, ip: string): Promise<void> {
    return withMinimumDuration(REQUEST_FLOOR_MS, () => this.requestCode(tenant, 'ACTIVATION', rawUsername, ip));
  }

  async confirmActivation(tenant: TenantContext, input: { username: string; code: string; password: string }, ip: string) {
    await withMinimumDuration(CONFIRM_FLOOR_MS, () => this.confirmCode(tenant, 'ACTIVATION', input, ip));
  }

  requestPasswordReset(tenant: TenantContext, rawUsername: string, ip: string): Promise<void> {
    return withMinimumDuration(REQUEST_FLOOR_MS, () => this.requestCode(tenant, 'PASSWORD_RESET', rawUsername, ip));
  }

  /** R7: never creates a session — the user logs in (and later passes MFA) afterwards. */
  async confirmPasswordReset(tenant: TenantContext, input: { username: string; code: string; password: string }, ip: string) {
    await withMinimumDuration(CONFIRM_FLOOR_MS, () => this.confirmCode(tenant, 'PASSWORD_RESET', input, ip));
  }

  async login(
    tenant: TenantContext,
    input: { username: string; password: string },
    meta: SessionMeta,
  ): Promise<LoginResult> {
    const id = normaliseIdentifier(input.username);
    await this.limitPasswordAttempt(tenant, meta.ip, id.value);

    const db = await this.shards.forTenant(tenant.shardId, tenant.tenantId);
    const user = await db.userAccount.findFirst({ where: id.kind === 'email' ? { email: id.value } : { username: id.value } });
    const now = new Date();

    if (!user?.passwordHash || user.status !== 'ACTIVE') {
      await verifyAgainstDummy(input.password);
      throw invalidCredentials();
    }
    // Shared with step-up: lockout check, verification and failure counting (S12).
    if (!(await this.passwords.verify(tenant, user, input.password, meta, 'login'))) throw invalidCredentials();

    await db.userAccount.update({
      where: { id: user.id },
      data: {
        failedLoginCount: 0,
        lockedUntil: null,
        lastLoginAt: now,
        ...(needsRehash(user.passwordHash) ? { passwordHash: await hashPassword(input.password) } : {}),
      },
    });
    const publicUser = { id: user.id, username: user.username, displayName: user.displayName };

    // Second factor (spec 0001 M4/M8): MFA users get a challenge, never a session, at this point.
    const { hasFactor, privileged } = await this.shards.tx(tenant.shardId, tenant.tenantId, async (tx) => ({
      hasFactor: await this.mfa.hasActiveFactor(tx, user.id),
      privileged: needsMfa((await this.sessions.loadGrants(tx, user.id, now)).grants),
    }));
    if (hasFactor) {
      return { kind: 'mfa_challenge', challengeToken: await this.mfa.startChallenge(tenant, user.id, meta.ip) };
    }
    // Privileged without a factor ⇒ enrolment-only session until M14 upgrades it.
    const { token, maxAgeSec } = await this.sessions.create(tenant, user.id, meta, { restricted: privileged }, 'auth.login.succeeded');
    return { kind: 'session', token, maxAgeSec, user: publicUser, mfaEnrolmentRequired: privileged };
  }

  /**
   * Spec 0001 Part S. Shares login's rate-limit buckets and lockout counter (S5, S12). The extra
   * per-user bucket bounds second-factor guessing even across rotating IPs.
   */
  async stepUp(
    tenant: TenantContext,
    actor: Actor,
    input: { password: string; code?: string | undefined; recoveryCode?: string | undefined },
    meta: SessionMeta,
  ) {
    await this.limitPasswordAttempt(tenant, meta.ip, normaliseIdentifier(actor.username).value);
    await this.limit(`${tenant.tenantId}:step-up:user:${actor.userId}`, [{ limit: 10, windowSec: 900 }]);
    return withMinimumDuration(STEP_UP_FLOOR_MS, () => this.mfa.stepUp(tenant, actor, input, meta));
  }
}
