// Tenant DEK lifecycle (spec 0006 E1, E2, E10, E11, E12). Platform-side only: never reachable from a
// tenant endpoint. Every change is audited in the same platform transaction.
import { randomBytes } from 'node:crypto';
import type { PlatformClient } from '@univarse/db';
import { writePlatformAudit } from './platform-audit.js';
import { wrapContext, type KeyProvider } from './providers.js';

/**
 * E11: gives a tenant its first (or next, when it has none active) DEK. Idempotent: a tenant that
 * already has an ACTIVE key is left untouched and its version is returned.
 */
export async function provisionTenantKey(
  platform: PlatformClient,
  provider: KeyProvider,
  tenantId: string,
  actorId: string | null = null,
): Promise<{ version: number; created: boolean }> {
  const active = await platform.tenantDataKey.findFirst({ where: { tenantId, status: 'ACTIVE' } });
  if (active) return { version: active.version, created: false };

  const latest = await platform.tenantDataKey.findFirst({ where: { tenantId }, orderBy: { version: 'desc' } });
  const version = (latest?.version ?? 0) + 1;
  const dek = randomBytes(32);
  try {
    // Wrap outside the DB transaction (a network call); the row and its audit commit together.
    const wrapped = await provider.wrap(dek, wrapContext(tenantId, version));
    await platform.$transaction(async (tx) => {
      await tx.tenantDataKey.create({ data: { tenantId, version, kekId: provider.kekId, wrappedDek: wrapped } });
      await writePlatformAudit(tx, {
        actorId,
        action: 'crypto.tenant_key.created',
        tenantId,
        metadata: { version, kekId: provider.kekId },
      });
    });
    return { version, created: true };
  } finally {
    dek.fill(0);
  }
}

/**
 * E10 crypto-shredding: erases every wrapped DEK of the tenant. All of its encrypted fields become
 * permanently undecryptable; other tenants are unaffected. Irreversible by design.
 */
export async function destroyTenantKeys(
  platform: PlatformClient,
  tenantId: string,
  actorId: string | null,
  reason: string,
): Promise<number> {
  return platform.$transaction(async (tx) => {
    const live = await tx.tenantDataKey.findMany({ where: { tenantId, status: { not: 'DESTROYED' } }, select: { version: true } });
    if (live.length === 0) return 0;
    await tx.tenantDataKey.updateMany({
      where: { tenantId, status: { not: 'DESTROYED' } },
      data: { status: 'DESTROYED', wrappedDek: null, destroyedAt: new Date() },
    });
    await writePlatformAudit(tx, {
      actorId,
      action: 'crypto.tenant_key.destroyed',
      tenantId,
      metadata: { versions: live.map((k) => k.version).sort((a, b) => a - b), reason },
    });
    return live.length;
  });
}
