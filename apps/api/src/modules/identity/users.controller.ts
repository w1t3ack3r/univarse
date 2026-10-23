import { Controller, Get, Query } from '@nestjs/common';
import { DEFAULT_PAGE_LIMIT, UsersOps } from '@univarse/contracts';
import { Contract } from '../../openapi/contract.js';
import { ShardRegistry } from '../../shared/db/db.module.js';
import { ProblemError } from '../../shared/errors/problem.js';
import { decodeCursor, encodeCursor } from '../../shared/http/cursor.js';
import { parse } from '../../shared/http/validate.js';
import { CurrentTenant } from '../../shared/tenancy/tenant.guard.js';
import type { TenantContext } from '../../shared/tenancy/tenant-resolver.service.js';
import { RequirePermission } from './access.guard.js';
import { Product } from '../products/product.guard.js';

@Controller('api/v1/users')
@Product('core')
export class UsersController {
  constructor(private readonly shards: ShardRegistry) {}

  /**
   * First permission-protected endpoint. Explicit field selection: never return hashes. Spec 0021: a page at a time,
   * ordered by username then id, read from the last row of the previous page (keyset, never an offset).
   */
  @Contract(UsersOps.listUsers)
  @Get()
  @RequirePermission('identity.user.view')
  async list(@CurrentTenant() tenant: TenantContext, @Query() query: unknown) {
    const q = parse(UsersOps.listUsers.query, query);
    const limit = q.limit ?? DEFAULT_PAGE_LIMIT;
    const db = await this.shards.forTenant(tenant.shardId, tenant.tenantId);
    let after: { id: string; username: string } | null = null;
    if (q.cursor !== undefined) {
      const id = decodeCursor(q.cursor);
      // Under this tenant's RLS: another institution's id is invisible, exactly like a garbage cursor (P5).
      after = id ? await db.userAccount.findUnique({ where: { id }, select: { id: true, username: true } }) : null;
      if (!after) throw new ProblemError(400, 'request.invalid_cursor', 'This page link is no longer valid');
    }
    const rows = await db.userAccount.findMany({
      select: { id: true, username: true, displayName: true, status: true, lastLoginAt: true },
      where: after ? { OR: [{ username: { gt: after.username } }, { username: after.username, id: { gt: after.id } }] } : {},
      orderBy: [{ username: 'asc' }, { id: 'asc' }],
      take: limit + 1, // one more than asked: whether there is a next page
    });
    const data = rows.slice(0, limit);
    const hasMore = rows.length > limit;
    const last = data.at(-1);
    return { data, page: { nextCursor: hasMore && last ? encodeCursor(last.id) : null, limit, hasMore } };
  }
}
