import { Inject, Injectable } from '@nestjs/common';
import type { TenantTx } from '@univarse/db';
import { APP_CONFIG, type AppConfig } from '../../config/config.js';
import { hashOneTimeCode, newOneTimeCode, safeEqual } from './tokens.js';

export type CodePurpose = 'ACTIVATION' | 'PASSWORD_RESET';

const TTL_MS = 15 * 60_000;
const MAX_ATTEMPTS = 5;

/**
 * Emailed 6-digit codes shared by activation and password reset (spec 0001 R2–R4).
 * Low entropy ⇒ peppered HMAC at rest, bound to (user, purpose), 15-minute TTL, 5 attempts,
 * single use, and issuing a new code kills all earlier unused ones.
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
   * Checks a code. On a wrong code the attempt counter is incremented — the caller MUST let the
   * transaction commit before failing, or the counter rolls back (R3).
   * Returns the token id to consume on success.
   */
  async check(
    tx: TenantTx,
    userId: string,
    purpose: CodePurpose,
    code: string,
  ): Promise<{ ok: true; tokenId: string } | { ok: false; reason: 'NO_CODE' | 'WRONG_CODE' }> {
    const token = await tx.oneTimeToken.findFirst({
      where: { userId, purpose, usedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
    if (!token || token.attempts >= MAX_ATTEMPTS) return { ok: false, reason: 'NO_CODE' };
    const expected = hashOneTimeCode(this.config.SESSION_PEPPER, userId, purpose, code);
    if (!safeEqual(expected, token.tokenHash)) {
      await tx.oneTimeToken.update({ where: { id: token.id }, data: { attempts: { increment: 1 } } });
      return { ok: false, reason: 'WRONG_CODE' };
    }
    return { ok: true, tokenId: token.id };
  }

  async consume(tx: TenantTx, tokenId: string): Promise<void> {
    await tx.oneTimeToken.update({ where: { id: tokenId }, data: { usedAt: new Date() } });
  }
}
