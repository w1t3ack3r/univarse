import { Body, Controller, Delete, Get, Param, Put, Req, Res } from '@nestjs/common';
import { SettingsOps } from '@univarse/contracts';
import { Contract } from '../../openapi/contract.js';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { etagOf } from '../../shared/http/etag.js';
import { parse } from '../../shared/http/validate.js';
import { CurrentTenant } from '../../shared/tenancy/tenant.guard.js';
import type { TenantContext } from '../../shared/tenancy/tenant-resolver.service.js';
import { CurrentActor, RequirePermission } from '../identity/access.guard.js';
import type { Actor } from '../identity/actor.js';
import { Product } from '../products/product.guard.js';
import { SettingsService } from './settings.service.js';

const meta = (req: FastifyRequest) => ({ ip: req.ip, userAgent: req.headers['user-agent'], requestId: req.id });

/**
 * Spec 0007. Every route needs `settings.tenant.view`; writes also need the key's own manage
 * permission (checked per key in the service, with MFA and step-up from the catalog).
 */
@Controller('api/v1/settings')
@Product('core')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Contract(SettingsOps.listSettings)
  @Get()
  @RequirePermission('settings.tenant.view')
  async list(@CurrentTenant() tenant: TenantContext, @CurrentActor() actor: Actor) {
    return { data: await this.settings.list(tenant, actor) };
  }

  @Contract(SettingsOps.getSetting)
  @Get(':key')
  @RequirePermission('settings.tenant.view')
  async get(
    @CurrentTenant() tenant: TenantContext,
    @CurrentActor() actor: Actor,
    @Param('key') key: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const view = await this.settings.view(tenant, actor, key);
    void reply.header('etag', etagOf(view.version));
    return view;
  }

  @Contract(SettingsOps.putSetting)
  @Put(':key')
  @RequirePermission('settings.tenant.view')
  async put(
    @CurrentTenant() tenant: TenantContext,
    @CurrentActor() actor: Actor,
    @Param('key') key: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const { value } = parse(SettingsOps.putSetting.body, body);
    const view = await this.settings.update(tenant, actor, key, value, req.headers['if-match'], meta(req));
    void reply.header('etag', etagOf(view.version));
    return view;
  }

  /** ST7: reset to the default. */
  @Contract(SettingsOps.resetSetting)
  @Delete(':key')
  @RequirePermission('settings.tenant.view')
  async reset(
    @CurrentTenant() tenant: TenantContext,
    @CurrentActor() actor: Actor,
    @Param('key') key: string,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const view = await this.settings.reset(tenant, actor, key, req.headers['if-match'], meta(req));
    void reply.header('etag', etagOf(view.version));
    return view;
  }
}
