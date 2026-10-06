import { Body, Controller, Get, Param, Put, Req } from '@nestjs/common';
import { ProductsOps } from '@univarse/contracts';
import { Contract } from '../../openapi/contract.js';
import type { FastifyRequest } from 'fastify';
import { parse } from '../../shared/http/validate.js';
import { CurrentTenant } from '../../shared/tenancy/tenant.guard.js';
import type { TenantContext } from '../../shared/tenancy/tenant-resolver.service.js';
import { Authenticated, CurrentActor, RequirePermission } from '../identity/access.guard.js';
import type { Actor } from '../identity/actor.js';
import { Product } from './product.guard.js';
import { ProductService } from './product.service.js';

const meta = (req: FastifyRequest) => ({ ip: req.ip, userAgent: req.headers['user-agent'], requestId: req.id });

/** Spec 0003 P4/P6. Entitlements are read-only here; only the platform grants them (P9). */
@Controller('api/v1')
@Product('core')
export class ProductsController {
  constructor(private readonly products: ProductService) {}

  /** Active products, for navigation. */
  @Contract(ProductsOps.listActiveProducts)
  @Get('products')
  @Authenticated()
  async active(@CurrentTenant() tenant: TenantContext) {
    return { data: [...(await this.products.active(tenant.tenantId))].sort() };
  }

  @Contract(ProductsOps.productsOverview)
  @Get('admin/products')
  @RequirePermission('settings.product.manage')
  async overview(@CurrentTenant() tenant: TenantContext) {
    return { data: await this.products.overview(tenant.tenantId) };
  }

  @Contract(ProductsOps.setProductEnabled)
  @Put('admin/products/:product')
  @RequirePermission('settings.product.manage')
  async set(
    @CurrentTenant() tenant: TenantContext,
    @CurrentActor() actor: Actor,
    @Param('product') product: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    return this.products.setEnabled(tenant, actor, product, parse(ProductsOps.setProductEnabled.body, body).enabled, meta(req));
  }
}
