import { Controller, Get } from '@nestjs/common';
import { UsersOps } from '@univarse/contracts';
import { Contract } from '../../openapi/contract.js';
import { ShardRegistry } from '../../shared/db/db.module.js';
import { CurrentTenant } from '../../shared/tenancy/tenant.guard.js';
import type { TenantContext } from '../../shared/tenancy/tenant-resolver.service.js';
import { RequirePermission } from './access.guard.js';
import { Product } from '../products/product.guard.js';

@Controller('api/v1/users')
@Product('core')
export class UsersController {
  constructor(private readonly shards: ShardRegistry) {}

  /** First permission-protected endpoint. Explicit field selection: never return hashes. */
  @Contract(UsersOps.listUsers)
  @Get()
  @RequirePermission('identity.user.view')
  async list(@CurrentTenant() tenant: TenantContext) {
    const db = await this.shards.forTenant(tenant.shardId, tenant.tenantId);
    const users = await db.userAccount.findMany({
      select: { id: true, username: true, displayName: true, status: true, lastLoginAt: true },
      orderBy: { username: 'asc' },
      take: 50,
    });
    return { data: users };
  }
}
