// Spec 0037 Q9: notices' routes. Each declares its permission (the platform route sweep fails one that doesn't).
// Reading is `platform.tenant.read`; drafting, publishing and withdrawing are `platform.notice.publish`, with a
// step-up by its catalogue entry. Editing and publishing take `If-Match`, so what's published is what was read.
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, Req, Res } from '@nestjs/common';
import { PlatformOps, type PlatformNotice } from '@univarse/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { requireIfMatch } from '../../shared/http/etag.js';
import { parse } from '../../shared/http/validate.js';
import { CurrentPlatformActor, RequirePlatformPermission, requestMeta } from '../identity/access.js';
import type { PlatformActor } from '../identity/types.js';
import { PlatformNotices } from './notices.service.js';

const tagged = (res: FastifyReply, n: PlatformNotice) => {
  void res.header('etag', `"v${String(n.version)}"`);
  return n;
};

@Controller('api/platform/v1/notices')
export class PlatformNoticesController {
  constructor(private readonly notices: PlatformNotices) {}

  @Get()
  @RequirePlatformPermission('platform.tenant.read')
  list(@Query() query: unknown) {
    return this.notices.list(parse(PlatformOps.notices.query, query).status);
  }

  @Get(':id')
  @RequirePlatformPermission('platform.tenant.read')
  async get(@Param('id', new ParseUUIDPipe()) id: string, @Res({ passthrough: true }) res: FastifyReply) {
    return tagged(res, await this.notices.get(id));
  }

  @Post()
  @RequirePlatformPermission('platform.notice.publish')
  @HttpCode(201)
  async create(@CurrentPlatformActor() actor: PlatformActor, @Body() body: unknown, @Req() req: FastifyRequest, @Res({ passthrough: true }) res: FastifyReply) {
    return tagged(res, await this.notices.create(actor, parse(PlatformOps.noticeDraft.body, body), requestMeta(req)));
  }

  @Put(':id')
  @RequirePlatformPermission('platform.notice.publish')
  async update(@Param('id', new ParseUUIDPipe()) id: string, @Body() body: unknown, @Req() req: FastifyRequest, @Res({ passthrough: true }) res: FastifyReply) {
    return tagged(res, await this.notices.update(id, requireIfMatch(req.headers['if-match']), parse(PlatformOps.noticeDraft.body, body)));
  }

  @Post(':id/publish')
  @RequirePlatformPermission('platform.notice.publish')
  @HttpCode(200)
  async publish(@CurrentPlatformActor() actor: PlatformActor, @Param('id', new ParseUUIDPipe()) id: string, @Req() req: FastifyRequest, @Res({ passthrough: true }) res: FastifyReply) {
    return tagged(res, await this.notices.publish(actor, id, requireIfMatch(req.headers['if-match']), requestMeta(req)));
  }

  @Post(':id/withdraw')
  @RequirePlatformPermission('platform.notice.publish')
  @HttpCode(200)
  async withdraw(@CurrentPlatformActor() actor: PlatformActor, @Param('id', new ParseUUIDPipe()) id: string, @Req() req: FastifyRequest, @Res({ passthrough: true }) res: FastifyReply) {
    return tagged(res, await this.notices.withdraw(actor, id, requestMeta(req)));
  }
}
