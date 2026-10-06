// Spec 0009 RS8: deliberately leaky routes, TEST ONLY (src/testing is excluded from the build, and
// the sweep boots the compiled build to prove these paths are absent).
//
// Dropping a tenant filter would not leak anything: forced RLS still confines the app role. So each
// control reads the victim's data under the VICTIM's legitimate tenant context, then hands it to
// whoever called. That is a real cross-tenant leak, and the sweep must catch it.
import { Controller, Get, Inject, Param } from '@nestjs/common';
import { ShardRegistry } from '../shared/db/db.module.js';
import { ProblemError } from '../shared/errors/problem.js';
import { CurrentTenant } from '../shared/tenancy/tenant.guard.js';
import type { TenantContext } from '../shared/tenancy/tenant-resolver.service.js';
import { Authenticated } from '../modules/identity/access.guard.js';
import { Product } from '../modules/products/product.guard.js';

export const LEAK_VICTIM = Symbol('LEAK_VICTIM');
export interface LeakVictim {
  readonly tenantId: string;
  readonly shardId: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PUBLIC_FIELDS = { id: true, username: true, displayName: true } as const;
const notFound = () => new ProblemError(404, 'resource.not_found', 'Not found');

@Controller('api/v1/__test')
@Product('core')
export class LeakyControlsController {
  constructor(
    private readonly shards: ShardRegistry,
    @Inject(LEAK_VICTIM) private readonly victim: LeakVictim,
  ) {}

  /** A `resource` route: the caller's own user by id (legitimate), or the victim's (the leak). */
  @Get('leaky-user/:id')
  @Authenticated()
  async user(@CurrentTenant() tenant: TenantContext, @Param('id') id: string) {
    if (!UUID.test(id)) throw notFound();
    const own = await this.shards.tx(tenant.shardId, tenant.tenantId, (tx) => tx.userAccount.findUnique({ where: { id }, select: PUBLIC_FIELDS }));
    if (own) return own;
    const leaked = await this.shards.tx(this.victim.shardId, this.victim.tenantId, (tx) =>
      tx.userAccount.findUnique({ where: { id }, select: PUBLIC_FIELDS }),
    );
    if (!leaked) throw notFound();
    return leaked;
  }

  /** A `collection` route: the caller's users (legitimate) plus the victim's (the leak). */
  @Get('leaky-users')
  @Authenticated()
  async users(@CurrentTenant() tenant: TenantContext) {
    const own = await this.shards.tx(tenant.shardId, tenant.tenantId, (tx) => tx.userAccount.findMany({ select: PUBLIC_FIELDS }));
    const leaked = await this.shards.tx(this.victim.shardId, this.victim.tenantId, (tx) => tx.userAccount.findMany({ select: PUBLIC_FIELDS }));
    return { data: [...own, ...leaked] };
  }
}
