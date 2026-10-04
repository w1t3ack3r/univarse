// Test-only helpers for MFA: enrol a known TOTP factor directly and compute current codes.
import { forTenant, type TenantShardClient } from '@univarse/db';
import { encryptField, keyringFromEnv } from '../shared/crypto/field-encryption.js';
import { hotp, newTotpSecret, timeStep } from '../modules/identity/totp.js';

const ring = () => keyringFromEnv(process.env.DATA_ENCRYPTION_KEY_ID!, process.env.DATA_ENCRYPTION_KEY!);

/** Inserts a CONFIRMED TOTP factor with a known secret (same AAD as MfaService). */
export async function enrolTestTotp(shard: TenantShardClient, tenantId: string, userId: string): Promise<Buffer> {
  const secret = newTotpSecret();
  await forTenant(shard, tenantId).mfaFactor.create({
    data: {
      tenantId,
      userId,
      type: 'TOTP',
      secretEnc: encryptField(ring(), secret, `${tenantId}:${userId}:totp`),
      confirmedAt: new Date(),
    },
  });
  return secret;
}

export const totpCode = (secret: Uint8Array, offsetSteps = 0): string => hotp(secret, timeStep(Date.now()) + offsetSteps);

/**
 * Tests that assert exact step offsets (e.g. "−1 accepted, +2 rejected") must not straddle a 30 s
 * TOTP boundary: crossing one shifts every offset by 1 and flips the expected result. If fewer than
 * `marginSec` seconds remain in the current step, wait for the next one (max ~marginSec).
 */
export async function waitForFreshTotpStep(marginSec = 10): Promise<void> {
  const intoStep = (Date.now() / 1000) % 30;
  if (30 - intoStep < marginSec) await new Promise((r) => setTimeout(r, (30 - intoStep) * 1000 + 50));
}

/**
 * The replay guard (M5) accepts each 30 s step once. Tests that log the same user in more than once
 * within a step clear the guard first. Never do this outside tests.
 */
export async function resetReplayGuard(shard: TenantShardClient, tenantId: string, userId: string): Promise<void> {
  await forTenant(shard, tenantId).mfaFactor.updateMany({ where: { userId }, data: { lastUsedStep: null } });
}
