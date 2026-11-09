// Spec 0033: the tenant registry's routes. Each declares its permission (the platform route sweep fails one that
// doesn't); `platform.tenant.edit` and `platform.tenant.entitlements` need a fresh step-up by their catalogue entries.
import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Put, Query, Req, Res } from '@nestjs/common';
import { PlatformOps } from '@univarse/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { requireIfMatch } from '../../shared/http/etag.js';
import { parse } from '../../shared/http/validate.js';
import { CurrentPlatformActor, RequirePlatformPermission, requestMeta } from '../identity/access.js';
import type { PlatformActor } from '../identity/types.js';
import { TenantRegistry } from './tenant-registry.service.js';

@Controller('api/platform/v1/tenants')
export class PlatformTenantsController {
  constructor(private readonly registry: TenantRegistry) {}

  @Get()
  @RequirePlatformPermission('platform.tenant.read')
  list(@Query() query: unknown) {
    return this.registry.list(parse(PlatformOps.tenants.query, query));
  }

  @Get(':id')
  @RequirePlatformPermission('platform.tenant.read')
  async detail(@Param('id', new ParseUUIDPipe()) id: string, @Res({ passthrough: true }) res: FastifyReply) {
    const t = await this.registry.detail(id);
    res.header('etag', `"v${String(t.version)}"`);
    return t;
  }

  @Put(':id')
  @RequirePlatformPermission('platform.tenant.edit')
  @HttpCode(204)
  async profile(@CurrentPlatformActor() actor: PlatformActor, @Param('id', new ParseUUIDPipe()) id: string, @Body() body: unknown, @Req() req: FastifyRequest) {
    await this.registry.editProfile(actor, id, requireIfMatch(req.headers['if-match']), parse(PlatformOps.tenantProfile.body, body), requestMeta(req));
  }

  @Put(':id/regulatory')
  @RequirePlatformPermission('platform.tenant.edit')
  @HttpCode(204)
  async regulatory(@CurrentPlatformActor() actor: PlatformActor, @Param('id', new ParseUUIDPipe()) id: string, @Body() body: unknown, @Req() req: FastifyRequest) {
    await this.registry.editRegulatory(actor, id, requireIfMatch(req.headers['if-match']), parse(PlatformOps.tenantRegulatory.body, body), requestMeta(req));
  }

  @Put(':id/branding/color')
  @RequirePlatformPermission('platform.tenant.edit')
  @HttpCode(204)
  async color(@CurrentPlatformActor() actor: PlatformActor, @Param('id', new ParseUUIDPipe()) id: string, @Body() body: unknown, @Req() req: FastifyRequest) {
    await this.registry.setColor(actor, id, parse(PlatformOps.tenantColor.body, body).primaryColor, requestMeta(req));
  }

  @Put(':id/branding/logo')
  @RequirePlatformPermission('platform.tenant.edit')
  @HttpCode(204)
  async setLogo(@CurrentPlatformActor() actor: PlatformActor, @Param('id', new ParseUUIDPipe()) id: string, @Body() body: unknown, @Req() req: FastifyRequest) {
    await this.registry.setLogo(actor, id, parse(PlatformOps.tenantLogo.body, body).base64, requestMeta(req));
  }

  @Delete(':id/branding/logo')
  @RequirePlatformPermission('platform.tenant.edit')
  @HttpCode(204)
  async removeLogo(@CurrentPlatformActor() actor: PlatformActor, @Param('id', new ParseUUIDPipe()) id: string, @Req() req: FastifyRequest) {
    await this.registry.removeLogo(actor, id, requestMeta(req));
  }

  /** The preview. A stored image, served as its checked type (`nosniff` is on every response). */
  @Get(':id/branding/logo')
  @RequirePlatformPermission('platform.tenant.read')
  async logo(@Param('id', new ParseUUIDPipe()) id: string, @Res() res: FastifyReply) {
    const { bytes, mime, sha256 } = await this.registry.logo(id);
    await res
      .header('content-type', mime)
      .header('etag', `"${sha256}"`)
      .header('cache-control', 'private, no-cache')
      .header('content-security-policy', "default-src 'none'")
      .send(Buffer.from(bytes));
  }

  @Put(':id/products/:product')
  @RequirePlatformPermission('platform.tenant.entitlements')
  @HttpCode(204)
  async product(@CurrentPlatformActor() actor: PlatformActor, @Param('id', new ParseUUIDPipe()) id: string, @Param('product') product: string, @Body() body: unknown, @Req() req: FastifyRequest) {
    await this.registry.setEntitlement(actor, id, product, parse(PlatformOps.tenantProduct.body, body), requestMeta(req));
  }
}
