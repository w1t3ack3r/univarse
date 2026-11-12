// Spec 0034: provisioning's routes. Each declares its permission (the platform route sweep fails one that doesn't);
// `platform.tenant.provision` and `platform.tenant.go_live` need a fresh step-up by their catalogue entries (Q1).
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Req, Res } from '@nestjs/common';
import { PlatformOps } from '@univarse/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ProblemError } from '../../shared/errors/problem.js';
import { parse } from '../../shared/http/validate.js';
import { CurrentPlatformActor, RequirePlatformPermission, requestMeta } from '../identity/access.js';
import type { PlatformActor } from '../identity/types.js';
import { PlatformProvisioning } from './provisioning.service.js';

const IdempotencyKey = z.uuid();

/** Q12: required on create. A missing or malformed key is refused before anything is read. */
function idempotencyKey(req: FastifyRequest): string {
  const raw = req.headers['idempotency-key'];
  const parsed = IdempotencyKey.safeParse(Array.isArray(raw) ? undefined : raw);
  if (!parsed.success) {
    throw Object.assign(new ProblemError(400, 'request.invalid', 'An Idempotency-Key header (a UUID) is required'), {
      errors: [{ path: 'Idempotency-Key', code: 'required', message: 'A UUID is required' }],
    });
  }
  return parsed.data;
}

@Controller('api/platform/v1/tenants')
export class PlatformProvisioningController {
  constructor(private readonly provisioning: PlatformProvisioning) {}

  /** 202: the request is recorded; the worker provisions it. A replay answers the same, with `Idempotent-Replayed`. */
  @Post()
  @RequirePlatformPermission('platform.tenant.provision')
  async create(@CurrentPlatformActor() actor: PlatformActor, @Body() body: unknown, @Req() req: FastifyRequest, @Res({ passthrough: true }) res: FastifyReply) {
    const key = idempotencyKey(req);
    const result = await this.provisioning.create(actor, key, parse(PlatformOps.createTenant.body, body), requestMeta(req));
    res.status(202);
    if (result.replayed) res.header('idempotent-replayed', 'true');
    return { tenantId: result.tenantId, jobId: result.jobId };
  }

  @Get(':id/provisioning')
  @RequirePlatformPermission('platform.tenant.read')
  view(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.provisioning.view(id);
  }

  @Post(':id/provisioning/resume')
  @RequirePlatformPermission('platform.tenant.provision')
  @HttpCode(204)
  async resume(@CurrentPlatformActor() actor: PlatformActor, @Param('id', new ParseUUIDPipe()) id: string, @Req() req: FastifyRequest) {
    await this.provisioning.resume(actor, id, requestMeta(req));
  }

  @Get(':id/go-live')
  @RequirePlatformPermission('platform.tenant.read')
  goLiveView(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.provisioning.goLiveView(id);
  }

  @Put(':id/dpa')
  @RequirePlatformPermission('platform.tenant.go_live')
  @HttpCode(204)
  async dpa(@CurrentPlatformActor() actor: PlatformActor, @Param('id', new ParseUUIDPipe()) id: string, @Body() body: unknown, @Req() req: FastifyRequest) {
    await this.provisioning.recordDpa(actor, id, parse(PlatformOps.tenantDpa.body, body), requestMeta(req));
  }

  @Post(':id/go-live')
  @RequirePlatformPermission('platform.tenant.go_live')
  @HttpCode(204)
  async goLive(@CurrentPlatformActor() actor: PlatformActor, @Param('id', new ParseUUIDPipe()) id: string, @Req() req: FastifyRequest) {
    await this.provisioning.goLive(actor, id, requestMeta(req));
  }
}
