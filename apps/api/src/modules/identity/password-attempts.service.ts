import { Injectable, Logger } from '@nestjs/common';
import { ShardRegistry } from '../../shared/db/db.module.js';
import type { TenantContext } from '../../shared/tenancy/tenant-resolver.service.js';
import { verifyAgainstDummy, verifyPassword } from './password.js';

const LOCK_AFTER_FAILURES = 10;
const LOCK_MS = 15 * 60_000;

/**
 * The single place that checks a password against an account and maintains the lockout counter.
 * Shared by login and step-up so they cannot drift apart (spec 0001 S5/S12).
 */
@Injectable()
export class PasswordAttempts {
  private readonly logger = new Logger('Auth');

  constructor(private readonly shards: ShardRegistry) {}

  async verify(
    tenant: TenantContext,
    user: { id: string; passwordHash: string | null; lockedUntil: Date | null },
    password: string,
  ): Promise<boolean> {
    const now = new Date();
    if (!user.passwordHash || (user.lockedUntil && user.lockedUntil > now)) {
      await verifyAgainstDummy(password);
      return false;
    }
    if (await verifyPassword(password, user.passwordHash)) return true;

    const db = await this.shards.forTenant(tenant.shardId, tenant.tenantId);
    // Atomic increment: parallel guesses can't under-count.
    const { failedLoginCount } = await db.userAccount.update({
      where: { id: user.id },
      data: { failedLoginCount: { increment: 1 } },
      select: { failedLoginCount: true },
    });
    if (failedLoginCount >= LOCK_AFTER_FAILURES) {
      await db.userAccount.update({
        where: { id: user.id },
        data: { failedLoginCount: 0, lockedUntil: new Date(now.getTime() + LOCK_MS) },
      });
      this.logger.warn(`Account locked after repeated failures tenant=${tenant.slug} user=${user.id}`);
    }
    return false;
  }
}
