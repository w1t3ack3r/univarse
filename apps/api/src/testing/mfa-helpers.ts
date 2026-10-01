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
 * The replay guard (M5) accepts each 30 s step once. Tests that log the same user in more than once
 * within a step clear the guard first. Never do this outside tests.
 */
export async function resetReplayGuard(shard: TenantShardClient, tenantId: string, userId: string): Promise<void> {
  await forTenant(shard, tenantId).mfaFactor.updateMany({ where: { userId }, data: { lastUsedStep: null } });
}
