import { Inject, Injectable, Logger } from '@nestjs/common';
import type { TenantTx } from '@univarse/db';
import { createHmac, randomBytes } from 'node:crypto';
import { APP_CONFIG, type AppConfig } from '../../config/config.js';
import { decryptField, encryptField, keyringFromEnv, type FieldKeyring } from '../../shared/crypto/field-encryption.js';
import { ShardRegistry } from '../../shared/db/db.module.js';
import { ProblemError } from '../../shared/errors/problem.js';
import { MAILER, type Mailer } from '../../shared/infra/mailer.js';
import type { TenantContext } from '../../shared/tenancy/tenant-resolver.service.js';
import { needsMfa, type Actor } from './actor.js';
import { PasswordAttempts } from './password-attempts.service.js';
import { verifyPassword } from './password.js';
import { SessionService, type SessionMeta } from './session.service.js';
import { base32Encode, newTotpSecret, otpauthUri, verifyTotp } from './totp.js';
import { newSessionToken, sha256 } from './tokens.js';

const CHALLENGE_TTL_MS = 5 * 60_000;
const CHALLENGE_MAX_ATTEMPTS = 5; // also a DB CHECK constraint (migration mfa_totp)
const UNCONFIRMED_FACTOR_TTL_MS = 15 * 60_000;
const RECOVERY_CODE_COUNT = 10;

export type VerifyInput = { code: string } | { recoveryCode: string };

const invalidMfa = () => new ProblemError(401, 'auth.mfa_invalid', 'Invalid or expired verification code');

/** Thrown inside the verify transaction to roll back already-spent credentials. */
class ChallengeConsumeConflict extends Error {}

/** "ABCDE-FGHJK": 10 base32 chars ≈ 50 bits, grouped for humans. */
const newRecoveryCode = () => {
  const s = base32Encode(randomBytes(7)).slice(0, 10);
  return `${s.slice(0, 5)}-${s.slice(5)}`;
};
const normaliseRecovery = (c: string) => c.toUpperCase().replace(/[^A-Z2-7]/g, '');

/**
 * TOTP MFA (spec 0001 Part M). Every state change that must happen at most once is a
 * conditional UPDATE checked for count === 1 (M12): challenge attempts, challenge consumption,
 * TOTP step replay guard, recovery-code consumption, enrolment confirmation.
 */
@Injectable()
export class MfaService {
  private readonly logger = new Logger('Mfa');
  private readonly ring: FieldKeyring;

  constructor(
    private readonly shards: ShardRegistry,
    private readonly sessions: SessionService,
    private readonly passwords: PasswordAttempts,
    @Inject(MAILER) private readonly mailer: Mailer,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    this.ring = keyringFromEnv(config.DATA_ENCRYPTION_KEY_ID, config.DATA_ENCRYPTION_KEY);
  }

  private aad(tenantId: string, userId: string) {
    return `${tenantId}:${userId}:totp`;
  }

  private recoveryHash(userId: string, code: string) {
    return new Uint8Array(createHmac('sha256', this.config.SESSION_PEPPER).update(`${userId}:recovery:${normaliseRecovery(code)}`).digest());
  }

  /**
   * The ONE implementation of "check a second factor", used by login verify and step-up (S7).
   * TOTP: replay guard per time step (M5). Recovery: atomic single-use consumption (M12).
   * Spends the credential on success; never spends anything on failure.
   */
  private async checkSecondFactor(
    tx: TenantTx,
    tenantId: string,
    userId: string,
    input: VerifyInput,
    now: Date,
  ): Promise<{ ok: false } | { ok: true; usedRecovery: boolean }> {
    if ('code' in input) {
      const factor = await tx.mfaFactor.findFirst({ where: { userId, type: 'TOTP', confirmedAt: { not: null } } });
      if (!factor) return { ok: false };
      const secret = decryptField(this.ring, factor.secretEnc, this.aad(tenantId, userId));
      const step = verifyTotp(secret, input.code, now.getTime());
      if (step === null) return { ok: false };
      const fresh = await tx.mfaFactor.updateMany({
        where: { id: factor.id, OR: [{ lastUsedStep: null }, { lastUsedStep: { lt: BigInt(step) } }] },
        data: { lastUsedStep: BigInt(step), lastUsedAt: now },
      });
      return fresh.count === 1 ? { ok: true, usedRecovery: false } : { ok: false };
    }
    const used = await tx.recoveryCode.updateMany({
      where: { userId, codeHash: this.recoveryHash(userId, input.recoveryCode), usedAt: null },
      data: { usedAt: now },
    });
    return used.count === 1 ? { ok: true, usedRecovery: true } : { ok: false };
  }

  /** Serialises management actions per user (S10): parallel regenerates must not leave 20 codes. */
  private async lockUser(tx: TenantTx, userId: string): Promise<void> {
    await tx.$queryRaw`SELECT id FROM user_account WHERE id = ${userId}::uuid FOR UPDATE`;
  }

  private notify(tenant: TenantContext, email: string | null, subject: string, text: string): void {
    if (!email) return;
    void this.mailer
      .send({ to: email, subject: `${tenant.shortName}: ${subject}`, text })
      .catch((err: unknown) => this.logger.error(`Notice failed: ${err instanceof Error ? err.message : String(err)}`));
  }

  /**
   * S1–S8, S12: re-authenticate on the CURRENT session and rotate it into a new session with
   * step_up_at = now. Wrong passwords count toward the shared lockout (S12).
   */
  async stepUp(
    tenant: TenantContext,
    actor: Actor,
    input: { password: string; code?: string | undefined; recoveryCode?: string | undefined },
    meta: SessionMeta,
  ) {
    const db = await this.shards.forTenant(tenant.shardId, tenant.tenantId);
    const user = await db.userAccount.findUniqueOrThrow({ where: { id: actor.userId } });
    if (user.status !== 'ACTIVE' || !(await this.passwords.verify(tenant, user, input.password))) {
      throw new ProblemError(401, 'auth.invalid_credentials', 'Invalid password');
    }

    const now = new Date();
    const outcome = await this.shards.tx(tenant.shardId, tenant.tenantId, async (tx) => {
      if (!(await this.hasActiveFactor(tx, user.id))) return { ok: true as const, mfa: false, usedRecovery: false };
      const second: VerifyInput | null = input.code
        ? { code: input.code }
        : input.recoveryCode
          ? { recoveryCode: input.recoveryCode }
          : null;
      if (!second) return { ok: false as const, reason: 'missing' as const };
      const checked = await this.checkSecondFactor(tx, tenant.tenantId, user.id, second, now);
      return checked.ok ? { ok: true as const, mfa: true, usedRecovery: checked.usedRecovery } : { ok: false as const, reason: 'invalid' as const };
    });
    if (!outcome.ok) {
      throw outcome.reason === 'missing'
        ? new ProblemError(400, 'auth.step_up_second_factor_required', 'Enter your authenticator code to continue')
        : invalidMfa();
    }
    if (outcome.usedRecovery) {
      this.notify(tenant, user.email, 'a recovery code was used to confirm your identity', 'A recovery code was just used to confirm your identity in UniVarse. If this was not you, contact your ICT unit immediately.');
    }
    // S3/S6: new token, step-up recorded only on the new session.
    return this.sessions.rotate(tenant, actor.sessionId, user.id, meta, 'step_up', {
      mfaAt: outcome.mfa ? now : actor.mfaAt,
      restricted: false,
      stepUpAt: now,
    });
  }

  /** M9b: 10 fresh recovery codes; every previous code dies; other sessions are revoked. */
  async regenerateRecoveryCodes(tenant: TenantContext, actor: Actor): Promise<string[]> {
    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
    const email = await this.shards.tx(tenant.shardId, tenant.tenantId, async (tx) => {
      await this.lockUser(tx, actor.userId);
      if (!(await this.hasActiveFactor(tx, actor.userId))) {
        throw new ProblemError(409, 'auth.mfa_not_enrolled', 'MFA is not enabled');
      }
      await tx.recoveryCode.deleteMany({ where: { userId: actor.userId } });
      await tx.recoveryCode.createMany({
        data: codes.map((c) => ({ tenantId: tenant.tenantId, userId: actor.userId, codeHash: this.recoveryHash(actor.userId, c) })),
      });
      await tx.session.updateMany({
        where: { userId: actor.userId, revokedAt: null, id: { not: actor.sessionId } },
        data: { revokedAt: new Date(), revokeReason: 'recovery_codes_regenerated' },
      });
      return (await tx.userAccount.findUniqueOrThrow({ where: { id: actor.userId } })).email;
    });
    this.notify(tenant, email, 'your MFA recovery codes were regenerated', 'New recovery codes were generated for your UniVarse account. All previous codes no longer work, and your other sessions were signed out.');
    return codes;
  }

  /**
   * M9c/M9d: remove the factor and recovery codes, revoke other sessions and pending challenges.
   * A privileged user's CURRENT session becomes enrolment-only in this same response (M9d).
   */
  async disable(tenant: TenantContext, actor: Actor, meta: SessionMeta) {
    const now = new Date();
    const { email, privileged } = await this.shards.tx(tenant.shardId, tenant.tenantId, async (tx) => {
      await this.lockUser(tx, actor.userId);
      if (!(await this.hasActiveFactor(tx, actor.userId))) {
        throw new ProblemError(409, 'auth.mfa_not_enrolled', 'MFA is not enabled');
      }
      await tx.mfaFactor.deleteMany({ where: { userId: actor.userId, type: 'TOTP' } });
      await tx.recoveryCode.deleteMany({ where: { userId: actor.userId } });
      await tx.mfaChallenge.updateMany({ where: { userId: actor.userId, usedAt: null, revokedAt: null }, data: { revokedAt: now } });
      await tx.session.updateMany({
        where: { userId: actor.userId, revokedAt: null, id: { not: actor.sessionId } },
        data: { revokedAt: now, revokeReason: 'mfa_disabled' },
      });
      const { grants } = await this.sessions.loadGrants(tx, actor.userId, now);
      return {
        email: (await tx.userAccount.findUniqueOrThrow({ where: { id: actor.userId } })).email,
        privileged: needsMfa(grants),
      };
    });
    this.notify(tenant, email, 'MFA was turned off', 'Multi-factor authentication was just turned off for your UniVarse account, and your other sessions were signed out. If this was not you, contact your ICT unit immediately.');
    // M9d: no lingering MFA/step-up state on the current device; privileged ⇒ enrolment-only.
    const session = await this.sessions.rotate(tenant, actor.sessionId, actor.userId, meta, 'mfa_disabled', {
      mfaAt: null,
      stepUpAt: null,
      restricted: privileged,
    });
    return { ...session, mfaEnrolmentRequired: privileged };
  }

  async hasActiveFactor(tx: TenantTx, userId: string): Promise<boolean> {
    return (await tx.mfaFactor.count({ where: { userId, type: 'TOTP', confirmedAt: { not: null } } })) > 0;
  }

  /** M4: issued after a correct password when the user has an active factor. Not a session. */
  async startChallenge(tenant: TenantContext, userId: string, ip: string): Promise<string> {
    const token = newSessionToken();
    const db = await this.shards.forTenant(tenant.shardId, tenant.tenantId);
    await db.mfaChallenge.create({
      data: { tenantId: tenant.tenantId, userId, tokenHash: sha256(token), expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS), ip },
    });
    return token;
  }

  /** M4–M7, M12: exchanges a challenge + second factor for a full session (mfa_at set). */
  async verify(tenant: TenantContext, challengeToken: string, input: VerifyInput, meta: SessionMeta) {
    const outcome = await this.verifyTx(tenant, challengeToken, input).catch((err: unknown) => {
      if (err instanceof ChallengeConsumeConflict) return { ok: false as const };
      throw err;
    });
    // Failed attempts are committed before failing (same rule as one-time codes).
    if (!outcome.ok) throw invalidMfa();
    return this.completeLogin(tenant, outcome, meta);
  }

  private verifyTx(tenant: TenantContext, challengeToken: string, input: VerifyInput) {
    return this.shards.tx(tenant.shardId, tenant.tenantId, async (tx) => {
      const now = new Date();
      const challenge = await tx.mfaChallenge.findUnique({
        where: { tenantId_tokenHash: { tenantId: tenant.tenantId, tokenHash: sha256(challengeToken) } },
      });
      if (!challenge) return { ok: false as const };
      // Reserve an attempt atomically (M6/M12); also rejects used/revoked/expired challenges.
      const reserved = await tx.mfaChallenge.updateMany({
        where: { id: challenge.id, usedAt: null, revokedAt: null, expiresAt: { gt: now }, attempts: { lt: CHALLENGE_MAX_ATTEMPTS } },
        data: { attempts: { increment: 1 } },
      });
      if (reserved.count === 0) return { ok: false as const };

      // Check eligibility BEFORE spending any credential (no side effects on a refused login).
      const user = await tx.userAccount.findUniqueOrThrow({ where: { id: challenge.userId } });
      if (user.status !== 'ACTIVE') return { ok: false as const };

      const second = await this.checkSecondFactor(tx, tenant.tenantId, challenge.userId, input, now);
      if (!second.ok) return { ok: false as const };
      const usedRecovery = second.usedRecovery;

      // Backstop for single-use (M4/M12). By now a credential (TOTP step or recovery code) has been
      // spent, so failing here must THROW to roll the whole transaction back — returning would
      // commit a burned recovery code. Mutation testing (2026-10-01) showed that side effect.
      const consumed = await tx.mfaChallenge.updateMany({ where: { id: challenge.id, usedAt: null, revokedAt: null }, data: { usedAt: now } });
      if (consumed.count === 0) throw new ChallengeConsumeConflict();

      const remaining = usedRecovery ? await tx.recoveryCode.count({ where: { userId: user.id, usedAt: null } }) : null;
      return { ok: true as const, user, remaining };
    });
  }

  private async completeLogin(
    tenant: TenantContext,
    { user, remaining }: { user: { id: string; username: string; displayName: string; email: string | null }; remaining: number | null },
    meta: SessionMeta,
  ) {
    if (remaining !== null && user.email) {
      // M7: tell the user a recovery code was used and how many are left.
      void this.mailer
        .send({
          to: user.email,
          subject: `${tenant.shortName}: a recovery code was used to sign in`,
          text: `A recovery code was just used to sign in to your UniVarse account. ${remaining} recovery code(s) remain.\n\nIf this was not you, contact your institution's ICT unit immediately.`,
        })
        .catch((err: unknown) => this.logger.error(`Recovery notice failed: ${err instanceof Error ? err.message : String(err)}`));
    }
    const session = await this.sessions.create(tenant, user.id, meta, { mfaAt: new Date() });
    return { ...session, user: { id: user.id, username: user.username, displayName: user.displayName } };
  }

  /** M1 + M15: start enrolment after re-entering the password; refused if a factor is already active. */
  async beginEnrolment(tenant: TenantContext, actor: Actor, password: string) {
    return this.shards.tx(tenant.shardId, tenant.tenantId, async (tx) => {
      const user = await tx.userAccount.findUniqueOrThrow({ where: { id: actor.userId } });
      if (!user.passwordHash || !(await verifyPassword(password, user.passwordHash))) {
        throw new ProblemError(401, 'auth.invalid_credentials', 'Invalid password');
      }
      if (await this.hasActiveFactor(tx, user.id)) {
        throw new ProblemError(409, 'auth.mfa_already_enrolled', 'MFA is already enabled. Changing it requires step-up (not yet available).');
      }
      await tx.mfaFactor.deleteMany({ where: { userId: user.id, type: 'TOTP', confirmedAt: null } });
      const secret = newTotpSecret();
      await tx.mfaFactor.create({
        data: {
          tenantId: tenant.tenantId,
          userId: user.id,
          type: 'TOTP',
          label: 'Authenticator app',
          secretEnc: encryptField(this.ring, secret, this.aad(tenant.tenantId, user.id)),
        },
      });
      return { secret: base32Encode(secret), otpauthUri: otpauthUri(secret, `${tenant.shortName} UniVarse`, user.username) };
    });
  }

  /**
   * M2 + M3 + M14: confirm with one valid code → factor active, 10 recovery codes (shown once),
   * and the CURRENT session (restricted or not) is replaced by a fresh full session.
   */
  async confirmEnrolment(tenant: TenantContext, actor: Actor, code: string, meta: SessionMeta) {
    const recoveryCodes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
    await this.shards.tx(tenant.shardId, tenant.tenantId, async (tx) => {
      const now = new Date();
      const factor = await tx.mfaFactor.findFirst({
        where: { userId: actor.userId, type: 'TOTP', confirmedAt: null, createdAt: { gt: new Date(now.getTime() - UNCONFIRMED_FACTOR_TTL_MS) } },
        orderBy: { createdAt: 'desc' },
      });
      if (!factor) throw new ProblemError(400, 'auth.mfa_enrolment_expired', 'Start enrolment again');
      const secret = decryptField(this.ring, factor.secretEnc, this.aad(tenant.tenantId, actor.userId));
      const step = verifyTotp(secret, code, now.getTime());
      if (step === null) throw invalidMfa();
      const confirmed = await tx.mfaFactor.updateMany({
        where: { id: factor.id, confirmedAt: null },
        data: { confirmedAt: now, lastUsedStep: BigInt(step), lastUsedAt: now },
      });
      if (confirmed.count === 0) throw invalidMfa();
      await tx.recoveryCode.deleteMany({ where: { userId: actor.userId } });
      await tx.recoveryCode.createMany({
        data: recoveryCodes.map((c) => ({ tenantId: tenant.tenantId, userId: actor.userId, codeHash: this.recoveryHash(actor.userId, c) })),
      });
      // M14: no token reuse across privilege levels — the enrolling session is retired.
      await tx.session.updateMany({ where: { id: actor.sessionId, revokedAt: null }, data: { revokedAt: now, revokeReason: 'mfa_enrolled' } });
    });
    const session = await this.sessions.create(tenant, actor.userId, meta, { mfaAt: new Date() });
    return { ...session, recoveryCodes };
  }
}
