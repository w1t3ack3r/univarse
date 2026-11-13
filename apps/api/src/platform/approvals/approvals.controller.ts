// Spec 0037: the approval engine's routes and the inbox. Each declares its access (the platform route sweep fails one
// that doesn't). Making a request is `platform.self` here because each kind needs its own permission, which the service
// checks with the catalogue's step-up rule; deciding is `platform.approval.decide`, with step-up by its catalogue entry.
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { PlatformOps } from '@univarse/contracts';
import type { FastifyRequest } from 'fastify';
import { parse } from '../../shared/http/validate.js';
import { CurrentPlatformActor, RequirePlatformPermission, requestMeta } from '../identity/access.js';
import type { PlatformActor } from '../identity/types.js';
import { PlatformInboxView } from '../inbox/inbox.service.js';
import { PlatformApprovals } from './approvals.service.js';

@Controller('api/platform/v1/approvals')
export class PlatformApprovalsController {
  constructor(private readonly approvals: PlatformApprovals) {}

  @Get()
  @RequirePlatformPermission('platform.self')
  async list(@CurrentPlatformActor() actor: PlatformActor) {
    return { data: await this.approvals.list(actor) };
  }

  @Post()
  @RequirePlatformPermission('platform.self')
  @HttpCode(201)
  request(@CurrentPlatformActor() actor: PlatformActor, @Body() body: unknown, @Req() req: FastifyRequest) {
    return this.approvals.request(actor, parse(PlatformOps.requestApproval.body, body), requestMeta(req));
  }

  @Get(':id')
  @RequirePlatformPermission('platform.self')
  get(@CurrentPlatformActor() actor: PlatformActor, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.approvals.get(actor, id);
  }

  @Post(':id/approve')
  @RequirePlatformPermission('platform.approval.decide')
  @HttpCode(200)
  approve(@CurrentPlatformActor() actor: PlatformActor, @Param('id', new ParseUUIDPipe()) id: string, @Body() body: unknown, @Req() req: FastifyRequest) {
    return this.approvals.approve(actor, id, parse(PlatformOps.approve.body, body).payloadHash, requestMeta(req));
  }

  @Post(':id/reject')
  @RequirePlatformPermission('platform.approval.decide')
  @HttpCode(200)
  reject(@CurrentPlatformActor() actor: PlatformActor, @Param('id', new ParseUUIDPipe()) id: string, @Req() req: FastifyRequest) {
    return this.approvals.reject(actor, id, requestMeta(req));
  }

  @Post(':id/cancel')
  @RequirePlatformPermission('platform.self')
  @HttpCode(200)
  cancel(@CurrentPlatformActor() actor: PlatformActor, @Param('id', new ParseUUIDPipe()) id: string, @Req() req: FastifyRequest) {
    return this.approvals.cancel(actor, id, requestMeta(req));
  }
}

@Controller('api/platform/v1/inbox')
export class PlatformInboxController {
  constructor(private readonly inbox: PlatformInboxView) {}

  @Get()
  @RequirePlatformPermission('platform.self')
  read(@CurrentPlatformActor() actor: PlatformActor) {
    return this.inbox.read(actor);
  }
}
