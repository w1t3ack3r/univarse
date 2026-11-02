// Spec 0028 Q3, Q6, Q7, Q9: everything that checks a credential, each the console's mirror of spec 0001's rule.
// Every state change that must happen at most once is a conditional UPDATE checked for count === 1: a code's attempt
// and its use, a TOTP step (replays refused), a recovery code's use, a challenge's attempt and its use.
import { createHmac, randomBytes } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { KeyProvider } from '@univarse/crypto';
import { securityFields } from '../../shared/observability/security.js';
import { base32Encode, newTotpSecret, otpauthUri, verifyTotp } from '../../modules/identity/totp.js';
import { hashOneTimeCode, newOneTimeCode, newSessionToken, safeEqual, sha256 } from '../../modules/identity/tokens.js';
import { PLATFORM_CONFIG, type PlatformConfig } from '../platform-config.js';
import { enqueueMail, NOT_YOU } from './mail.js';
import { platformAudit } from './audit.js';
import {
  CHALLENGE_MAX_ATTEMPTS,
  CHALLENGE_TTL_MS,
  CODE_MAX_ATTEMPTS,
  CODE_TTL_MS,
  LOCK_AFTER_FAILURES,
  LOCK_MS,
  RECOVERY_CODE_COUNT,
  UNCONFIRMED_FACTOR_TTL_MS,
  type PlatformTx,
  type RequestMeta,
} from './types.js';

export const CONSOLE_KEYS = Symbol('CONSOLE_KEYS');

export type CodePurpose = 'ACTIVATION' | 'PASSWORD_RESET';
export type SecondFactor = { code: string } | { recoveryCode: string };

/** "ABCDE-FGHJK": 10 base32 characters, about 50 bits, grouped for people. */
const newRecoveryCode = () => {
  const s = base32Encode(randomBytes(7)).slice(0, 10);
  return `${s.slice(0, 5)}-${s.slice(5)}`;
};
const normaliseRecovery = (c: string) => c.toUpperCase().replace(/[^A-Z2-7]/g, '');

/** The Transit context binding a TOTP secret to its member: a secret copied to another member won't decrypt. */
export const factorContext = (userId: string) => `console:${userId}:totp`;

@Injectable()
export class PlatformCredentials {
  private readonly logger = new Logger('PlatformAuth');

  constructor(
    @Inject(PLATFORM_CONFIG) private readonly config: PlatformConfig,
    @Inject(CONSOLE_KEYS) private readonly keys: KeyProvider,
  ) {}

  // ── One-time codes (Q6): peppered HMAC at rest, bound to member and purpose, 15 minutes, 5 attempts, single use.

  /** A new code; every earlier unused one for the same purpose dies. */
  async issueCode(tx: PlatformTx, userId: string, purpose: CodePurpose): Promise<string> {
    const now = new Date();
    await tx.platformOneTimeCode.updateMany({ where: { userId, purpose, usedAt: null }, data: { usedAt: now } });
    const code = newOneTimeCode();
    await tx.platformOneTimeCode.create({
      data: { userId, purpose, codeHash: hashOneTimeCode(this.config.CONSOLE_CODE_PEPPER, userId, purpose, code), expiresAt: new Date(now.getTime() + CODE_TTL_MS) },
    });
    return code;
  }

  /**
   * Spends one attempt, reserved atomically before comparing; a wrong code returns (so the caller COMMITS the spent
   * attempt) and a right one is consumed in the same transaction.
   */
  async checkCode(tx: PlatformTx, userId: string, purpose: CodePurpose, code: string): Promise<boolean> {
    const now = new Date();
    const row = await tx.platformOneTimeCode.findFirst({ where: { userId, purpose, usedAt: null, expiresAt: { gt: now } }, orderBy: { createdAt: 'desc' } });
    if (!row) return false;
    const reserved = await tx.platformOneTimeCode.updateMany({
      where: { id: row.id, usedAt: null, expiresAt: { gt: now }, attempts: { lt: CODE_MAX_ATTEMPTS } },
      data: { attempts: { increment: 1 } },
    });
    if (reserved.count === 0) return false;
    if (!safeEqual(hashOneTimeCode(this.config.CONSOLE_CODE_PEPPER, userId, purpose, code), row.codeHash)) return false;
    const consumed = await tx.platformOneTimeCode.updateMany({ where: { id: row.id, usedAt: null }, data: { usedAt: now } });
    return consumed.count === 1;
  }

  // ── Lockout (Q9): 10 failures (passwords and second factors) lock the account for 15 minutes, and email the member.

  /** Counts a failure, and locks and notifies at the threshold, in the caller's transaction. */
  async recordFailure(tx: PlatformTx, user: { id: string; email: string }, context: 'login' | 'second_factor' | 'step_up', meta: RequestMeta): Promise<void> {
    const { failedLoginCount } = await tx.platformUser.update({ where: { id: user.id }, data: { failedLoginCount: { increment: 1 } }, select: { failedLoginCount: true } });
    await platformAudit(tx, { actorId: user.id, action: 'platform.auth.failed', metadata: { context, failedLoginCount } }, meta);
    if (failedLoginCount < LOCK_AFTER_FAILURES) return;
    const lockedUntil = new Date(Date.now() + LOCK_MS);
    await tx.platformUser.update({ where: { id: user.id }, data: { failedLoginCount: 0, lockedUntil } });
    await platformAudit(tx, { actorId: user.id, action: 'platform.auth.account_locked', metadata: { context, lockedUntil: lockedUntil.toISOString() } }, meta);
    await enqueueMail(tx, {
      to: user.email,
      subject: 'your console account was locked',
      text: `Your UniVarse console account was locked for 15 minutes after ${String(LOCK_AFTER_FAILURES)} failed attempts to sign in or confirm your identity.${NOT_YOU}`,
    });
    this.logger.warn(securityFields('platform.account.locked', { lockedUserId: user.id, context }), 'Console account locked after repeated failures');
  }

  // ── TOTP factors (Q3, Q7): the secret encrypted with the console's own Transit key, bound to its member.

  async hasFactor(tx: PlatformTx, userId: string): Promise<boolean> {
    return (await tx.platformMfaFactor.count({ where: { userId, confirmedAt: { not: null }, revokedAt: null } })) > 0;
  }

  /** A new unconfirmed factor (any earlier unconfirmed one retired); returns what the authenticator app needs. */
  async beginFactor(tx: PlatformTx, user: { id: string; email: string }): Promise<{ secret: string; otpauthUri: string }> {
    const now = new Date();
    await tx.platformMfaFactor.updateMany({ where: { userId: user.id, confirmedAt: null, revokedAt: null }, data: { revokedAt: now } });
    const secret = newTotpSecret();
    await tx.platformMfaFactor.create({ data: { userId: user.id, secretEnc: await this.keys.wrap(secret, factorContext(user.id)) } });
    return { secret: base32Encode(secret), otpauthUri: otpauthUri(secret, 'UniVarse Console', user.email) };
  }

  /** Confirms the newest unconfirmed factor with a code; false if none is pending (15 minutes) or the code is wrong. */
  async confirmFactor(tx: PlatformTx, userId: string, code: string): Promise<boolean> {
    const now = new Date();
    const factor = await tx.platformMfaFactor.findFirst({
      where: { userId, confirmedAt: null, revokedAt: null, createdAt: { gt: new Date(now.getTime() - UNCONFIRMED_FACTOR_TTL_MS) } },
      orderBy: { createdAt: 'desc' },
    });
    if (!factor) return false;
    const step = verifyTotp(await this.keys.unwrap(factor.secretEnc, factorContext(userId)), code, now.getTime());
    if (step === null) return false;
    const confirmed = await tx.platformMfaFactor.updateMany({ where: { id: factor.id, confirmedAt: null, revokedAt: null }, data: { confirmedAt: now, lastUsedStep: BigInt(step), lastUsedAt: now } });
    return confirmed.count === 1;
  }

  /** Retires a member's factor and recovery codes (an OWNER's MFA reset, Q14). */
  async retireFactor(tx: PlatformTx, userId: string): Promise<void> {
    const now = new Date();
    await tx.platformMfaFactor.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: now } });
    await tx.platformRecoveryCode.updateMany({ where: { userId, usedAt: null, revokedAt: null }, data: { revokedAt: now } });
    await tx.platformMfaChallenge.updateMany({ where: { userId, usedAt: null, revokedAt: null }, data: { revokedAt: now } });
  }

  /**
   * The ONE check of a second factor, for sign-in and step-up. TOTP: a time step at most once. Recovery: single use.
   * Spends the credential on success; never spends anything on failure.
   */
  async checkSecondFactor(tx: PlatformTx, userId: string, input: SecondFactor, now: Date): Promise<{ ok: false } | { ok: true; usedRecovery: boolean }> {
    if ('code' in input) {
      const factor = await tx.platformMfaFactor.findFirst({ where: { userId, confirmedAt: { not: null }, revokedAt: null } });
      if (!factor) return { ok: false };
      const step = verifyTotp(await this.keys.unwrap(factor.secretEnc, factorContext(userId)), input.code, now.getTime());
      if (step === null) return { ok: false };
      const fresh = await tx.platformMfaFactor.updateMany({
        where: { id: factor.id, revokedAt: null, OR: [{ lastUsedStep: null }, { lastUsedStep: { lt: BigInt(step) } }] },
        data: { lastUsedStep: BigInt(step), lastUsedAt: now },
      });
      return fresh.count === 1 ? { ok: true, usedRecovery: false } : { ok: false };
    }
    const used = await tx.platformRecoveryCode.updateMany({
      where: { userId, codeHash: this.recoveryHash(userId, input.recoveryCode), usedAt: null, revokedAt: null },
      data: { usedAt: now },
    });
    return used.count === 1 ? { ok: true, usedRecovery: true } : { ok: false };
  }

  // ── Recovery codes (Q7).

  /** Ten new codes; every earlier one dies. Returns them in clear, once. */
  async newRecoveryCodes(tx: PlatformTx, userId: string): Promise<string[]> {
    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
    await tx.platformRecoveryCode.updateMany({ where: { userId, usedAt: null, revokedAt: null }, data: { revokedAt: new Date() } });
    await tx.platformRecoveryCode.createMany({ data: codes.map((c) => ({ userId, codeHash: this.recoveryHash(userId, c) })) });
    return codes;
  }

  async remainingRecoveryCodes(tx: PlatformTx, userId: string): Promise<number> {
    return tx.platformRecoveryCode.count({ where: { userId, usedAt: null, revokedAt: null } });
  }

  private recoveryHash(userId: string, code: string): Uint8Array<ArrayBuffer> {
    return new Uint8Array(createHmac('sha256', this.config.CONSOLE_CODE_PEPPER).update(`${userId}:recovery:${normaliseRecovery(code)}`).digest());
  }

  // ── The sign-in challenge (Q7): after a correct password, 5 minutes and 5 attempts for the second factor.

  async startChallenge(tx: PlatformTx, userId: string, ip: string): Promise<string> {
    const token = newSessionToken();
    await tx.platformMfaChallenge.create({ data: { userId, tokenHash: sha256(token), expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS), ip } });
    return token;
  }

  /** Reserves an attempt on a live challenge; returns its member, or null (unknown, used, revoked, expired, spent). */
  async reserveChallenge(tx: PlatformTx, token: string, now: Date): Promise<{ id: string; userId: string } | null> {
    const challenge = await tx.platformMfaChallenge.findUnique({ where: { tokenHash: sha256(token) } });
    if (!challenge) return null;
    const reserved = await tx.platformMfaChallenge.updateMany({
      where: { id: challenge.id, usedAt: null, revokedAt: null, expiresAt: { gt: now }, attempts: { lt: CHALLENGE_MAX_ATTEMPTS } },
      data: { attempts: { increment: 1 } },
    });
    return reserved.count === 1 ? { id: challenge.id, userId: challenge.userId } : null;
  }

  async consumeChallenge(tx: PlatformTx, id: string, now: Date): Promise<boolean> {
    const n = await tx.platformMfaChallenge.updateMany({ where: { id, usedAt: null, revokedAt: null }, data: { usedAt: now } });
    return n.count === 1;
  }

  // ── Known devices (Q10): a random id in a cookie, stored as a peppered hash per member.

  deviceHash(userId: string, deviceId: string): Uint8Array<ArrayBuffer> {
    return new Uint8Array(createHmac('sha256', this.config.CONSOLE_CODE_PEPPER).update(`${userId}:device:${deviceId}`).digest());
  }
}
