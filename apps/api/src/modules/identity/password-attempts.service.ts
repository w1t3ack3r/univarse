import { Injectable, Logger } from '@nestjs/common';
import { AuditWriter } from '../../shared/audit/audit-writer.js';
import { ShardRegistry } from '../../shared/db/db.module.js';
import type { TenantContext } from '../../shared/tenancy/tenant-resolver.service.js';
import { verifyAgainstDummy, verifyPassword } from './password.js';
import { SessionService, type SessionMeta } from './session.service.js';

const LOCK_AFTER_FAILURES = 10;
const LOCK_MS = 15 * 60_000;

/**
 * The single place that checks a password against an account and maintains the lockout counter.
 * Shared by login and step-up so they cannot drift apart (spec 0001 S5/S12).
 * A failure's counter update, optional lock and audit events commit together (spec 0002 A1/A7).
 */
@Injectable()
export class PasswordAttempts {
  private readonly logger = new Logger('Auth');

  constructor(
    private readonly shards: ShardRegistry,
    private readonly audit: AuditWriter,
  ) {}

  async verify(
    tenant: TenantContext,
    user: { id: string; passwordHash: string | null; lockedUntil: Date | null },
    password: string,
    meta?: SessionMeta,
    context: 'login' | 'step_up' = 'login',
  ): Promise<boolean> {
    const now = new Date();
    if (!user.passwordHash || (user.lockedUntil && user.lockedUntil > now)) {
      await verifyAgainstDummy(password);
      return false;
    }
    if (await verifyPassword(password, user.passwordHash)) return true;

    const locked = await this.shards.tx(tenant.shardId, tenant.tenantId, async (tx) => {
      // Atomic increment: parallel guesses can't under-count.
      const { failedLoginCount } = await tx.userAccount.update({
        where: { id: user.id },
        data: { failedLoginCount: { increment: 1 } },
        select: { failedLoginCount: true },
      });
      const base = { actorType: 'USER' as const, actorId: user.id, entityType: 'user_account', entityId: user.id, ...SessionService.auditMeta(meta) };
      await this.audit.write(tx, tenant.tenantId, { ...base, action: 'auth.login.failed', after: { context, failedLoginCount } });
      if (failedLoginCount < LOCK_AFTER_FAILURES) return false;
      const lockedUntil = new Date(now.getTime() + LOCK_MS);
      await tx.userAccount.update({ where: { id: user.id }, data: { failedLoginCount: 0, lockedUntil } });
      await this.audit.write(tx, tenant.tenantId, { ...base, action: 'auth.account.locked', after: { lockedUntil, context } });
      return true;
    });
    if (locked) this.logger.warn(`Account locked after repeated failures tenant=${tenant.slug} user=${user.id}`);
    return false;
  }
}
