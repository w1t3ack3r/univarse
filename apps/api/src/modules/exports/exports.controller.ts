import { Controller, Get, HttpCode, Param, Post, Req, Res } from '@nestjs/common';
import { ExportOps } from '@univarse/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Contract } from '../../openapi/contract.js';
import { CurrentTenant } from '../../shared/tenancy/tenant.guard.js';
import type { TenantContext } from '../../shared/tenancy/tenant-resolver.service.js';
import { CurrentActor, RequirePermission } from '../identity/access.guard.js';
import type { Actor } from '../identity/actor.js';
import { Product } from '../products/product.guard.js';
import { contentDisposition } from '../files/file-types.js';
import { ExportsService } from './exports.service.js';

const meta = (req: FastifyRequest) => ({ ip: req.ip, userAgent: req.headers['user-agent'], requestId: req.id });

/**
 * Spec 0038 Q7, Q8: the institution's full export. `data.export.request` is privileged and step-up flagged, so every
 * route here needs MFA and a fresh step-up; the use case checks the institution scope again (out of scope is 404).
 */
@Controller('api/v1/exports')
@Product('core')
export class ExportsController {
  constructor(private readonly exports: ExportsService) {}

  @Contract(ExportOps.requestExport)
  @Post()
  @RequirePermission('data.export.request')
  @HttpCode(201)
  async request(@CurrentTenant() tenant: TenantContext, @CurrentActor() actor: Actor, @Req() req: FastifyRequest) {
    return this.exports.request(tenant, actor, meta(req));
  }

  @Contract(ExportOps.listExports)
  @Get()
  @RequirePermission('data.export.request')
  async list(@CurrentTenant() tenant: TenantContext, @CurrentActor() actor: Actor) {
    return this.exports.list(tenant, actor);
  }

  /** Q-B9: streamed, as an attachment; no-store, nosniff and the sandboxing CSP come from the global hook. */
  @Contract(ExportOps.downloadExport)
  @Get(':id/content')
  @RequirePermission('data.export.request')
  async content(
    @CurrentTenant() tenant: TenantContext,
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const file = await this.exports.download(tenant, actor, id, meta(req));
    void reply.header('content-type', 'application/zip').header('content-length', String(file.length)).header('content-disposition', contentDisposition(file.name));
    return file.body;
  }
}
