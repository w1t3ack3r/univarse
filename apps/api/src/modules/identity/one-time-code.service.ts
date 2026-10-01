import { Inject, Injectable } from '@nestjs/common';
import type { TenantTx } from '@univarse/db';
import { APP_CONFIG, type AppConfig } from '../../config/config.js';
import { hashOneTimeCode, newOneTimeCode, safeEqual } from './tokens.js';

export type CodePurpose = 'ACTIVATION' | 'PASSWORD_RESET';

const TTL_MS = 15 * 60_000;
const MAX_ATTEMPTS = 5;

/**
 * Emailed 6-digit codes shared by activation and password reset (spec 0001 R2–R4, R12–R13).
 * Low entropy ⇒ peppered HMAC at rest, bound to (user, purpose), 15-minute TTL, 5 attempts,
 * single use, and issuing a new code kills all earlier unused ones.
 *
 * Concurrency: every check first RESERVES an attempt with a conditional UPDATE. That takes the
 * row lock for the rest of the transaction, so concurrent checks of the same code serialise and
 * each re-evaluates `attempts < 5 AND used_at IS NULL` after the previous one commits.
 */
@Injectable()
export class OneTimeCodeService {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  async issue(tx: TenantTx, tenantId: string, userId: string, purpose: CodePurpose): Promise<string> {
    const now = new Date();
    await tx.oneTimeToken.updateMany({ where: { userId, purpose, usedAt: null }, data: { usedAt: now } });
    const code = newOneTimeCode();
    await tx.oneTimeToken.create({
      data: {
        tenantId,
        userId,
        purpose,
        channel: 'EMAIL',
        tokenHash: hashOneTimeCode(this.config.SESSION_PEPPER, userId, purpose, code),
        expiresAt: new Date(now.getTime() + TTL_MS),
      },
    });
    return code;
  }

  /**
   * Checks a code. Each call spends one attempt, reserved atomically before comparing (R13).
   * A wrong code returns (never throws) so the caller's transaction COMMITS the spent attempt (R3).
   * On success the code is consumed atomically in the same transaction (R12).
   */
  async check(
    tx: TenantTx,
    userId: string,
    purpose: CodePurpose,
    code: string,
  ): Promise<{ ok: true } | { ok: false; reason: 'NO_CODE' | 'WRONG_CODE' }> {
    const now = new Date();
    const token = await tx.oneTimeToken.findFirst({
      where: { userId, purpose, usedAt: null, expiresAt: { gt: now } },
      orderBy: { createdAt: 'desc' },
    });
    if (!token) return { ok: false, reason: 'NO_CODE' };

    const reserved = await tx.oneTimeToken.updateMany({
      where: { id: token.id, usedAt: null, expiresAt: { gt: now }, attempts: { lt: MAX_ATTEMPTS } },
      data: { attempts: { increment: 1 } },
    });
    if (reserved.count === 0) return { ok: false, reason: 'NO_CODE' };

    const expected = hashOneTimeCode(this.config.SESSION_PEPPER, userId, purpose, code);
    if (!safeEqual(expected, token.tokenHash)) return { ok: false, reason: 'WRONG_CODE' };

    const consumed = await tx.oneTimeToken.updateMany({ where: { id: token.id, usedAt: null }, data: { usedAt: now } });
    return consumed.count === 1 ? { ok: true } : { ok: false, reason: 'NO_CODE' };
  }
}
