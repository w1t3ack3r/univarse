import { Body, Controller, Delete, Get, HttpCode, Param, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { parse } from '../../shared/http/validate.js';
import { CurrentTenant } from '../../shared/tenancy/tenant.guard.js';
import type { TenantContext } from '../../shared/tenancy/tenant-resolver.service.js';
import { CurrentActor, RequirePermission } from '../identity/access.guard.js';
import type { Actor } from '../identity/actor.js';
import { Product } from '../products/product.guard.js';
import { contentDisposition } from './file-types.js';
import { FilesService } from './files.service.js';

const RequestUpload = z
  .object({ name: z.string().trim().min(1).max(255), mime: z.string().min(1).max(100), sizeBytes: z.number().int().min(1) })
  .strict();
const meta = (req: FastifyRequest) => ({ ip: req.ip, userAgent: req.headers['user-agent'], requestId: req.id });

/**
 * Spec 0010. Own documents only (D2): another user's file, in this tenant or another, is the same 404
 * as a nonexistent id. Every route is a resource route under the spec 0009 sweep (RS6, FU2).
 */
@Controller('api/v1/files')
@Product('core')
export class FilesController {
  constructor(private readonly files: FilesService) {}

  @Post('uploads')
  @RequirePermission('files.file.upload')
  @HttpCode(201)
  async requestUpload(@CurrentTenant() tenant: TenantContext, @CurrentActor() actor: Actor, @Body() body: unknown, @Req() req: FastifyRequest) {
    return this.files.requestUpload(tenant, actor, parse(RequestUpload, body), meta(req));
  }

  @Get()
  @RequirePermission('files.file.read')
  async list(@CurrentTenant() tenant: TenantContext, @CurrentActor() actor: Actor) {
    return { data: await this.files.list(tenant, actor) };
  }

  @Get(':id')
  @RequirePermission('files.file.read')
  async view(@CurrentTenant() tenant: TenantContext, @CurrentActor() actor: Actor, @Param('id') id: string) {
    return this.files.view(tenant, actor, id);
  }

  @Post(':id/complete')
  @RequirePermission('files.file.upload')
  @HttpCode(200)
  async complete(@CurrentTenant() tenant: TenantContext, @CurrentActor() actor: Actor, @Param('id') id: string, @Req() req: FastifyRequest) {
    return this.files.complete(tenant, actor, id, meta(req));
  }

  /** FU5/FU14: verified bytes only, as an attachment, never rendered by the browser. */
  @Get(':id/content')
  @RequirePermission('files.file.read')
  async content(
    @CurrentTenant() tenant: TenantContext,
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const file = await this.files.download(tenant, actor, id, meta(req));
    // nosniff, CSP (incl. sandbox), no-store and CORP come from the global hook (fastify-hooks.ts),
    // which runs after this handler so no route can weaken them.
    void reply
      .header('content-type', file.type)
      .header('content-length', String(file.bytes.length))
      .header('content-disposition', contentDisposition(file.name));
    return file.bytes;
  }

  @Delete(':id')
  @RequirePermission('files.file.delete')
  @HttpCode(204)
  async remove(@CurrentTenant() tenant: TenantContext, @CurrentActor() actor: Actor, @Param('id') id: string, @Req() req: FastifyRequest) {
    await this.files.remove(tenant, actor, id, meta(req));
  }
}
