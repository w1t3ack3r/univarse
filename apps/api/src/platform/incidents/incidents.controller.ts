// Spec 0037 Q13: incidents' routes. Each declares its permission (the platform route sweep fails one that doesn't).
// Reading is `platform.tenant.read`; opening, updating and the follow-up are `platform.incident.manage`, with a step-up
// by its catalogue entry. An update and the follow-up take `If-Match`: what's posted follows what was read.
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, Req, Res } from '@nestjs/common';
import { PlatformOps, type PlatformIncident } from '@univarse/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { requireIfMatch } from '../../shared/http/etag.js';
import { parse } from '../../shared/http/validate.js';
import { CurrentPlatformActor, RequirePlatformPermission, requestMeta } from '../identity/access.js';
import type { PlatformActor } from '../identity/types.js';
import { PlatformIncidents } from './incidents.service.js';

const tagged = (res: FastifyReply, i: PlatformIncident) => {
  void res.header('etag', `"v${String(i.version)}"`);
  return i;
};

@Controller('api/platform/v1/incidents')
export class PlatformIncidentsController {
  constructor(private readonly incidents: PlatformIncidents) {}

  @Get()
  @RequirePlatformPermission('platform.tenant.read')
  list(@Query() query: unknown) {
    const { open } = parse(PlatformOps.incidents.query, query);
    return this.incidents.list(open === undefined ? undefined : open === 'true');
  }

  @Get(':id')
  @RequirePlatformPermission('platform.tenant.read')
  async get(@Param('id', new ParseUUIDPipe()) id: string, @Res({ passthrough: true }) res: FastifyReply) {
    return tagged(res, await this.incidents.get(id));
  }

  @Post()
  @RequirePlatformPermission('platform.incident.manage')
  @HttpCode(201)
  async open(@CurrentPlatformActor() actor: PlatformActor, @Body() body: unknown, @Req() req: FastifyRequest, @Res({ passthrough: true }) res: FastifyReply) {
    return tagged(res, await this.incidents.open(actor, parse(PlatformOps.openIncident.body, body), requestMeta(req)));
  }

  @Post(':id/updates')
  @RequirePlatformPermission('platform.incident.manage')
  @HttpCode(200)
  async update(@CurrentPlatformActor() actor: PlatformActor, @Param('id', new ParseUUIDPipe()) id: string, @Body() body: unknown, @Req() req: FastifyRequest, @Res({ passthrough: true }) res: FastifyReply) {
    return tagged(res, await this.incidents.postUpdate(actor, id, requireIfMatch(req.headers['if-match']), parse(PlatformOps.postIncidentUpdate.body, body), requestMeta(req)));
  }

  @Put(':id/followup')
  @RequirePlatformPermission('platform.incident.manage')
  async followup(@CurrentPlatformActor() actor: PlatformActor, @Param('id', new ParseUUIDPipe()) id: string, @Body() body: unknown, @Req() req: FastifyRequest, @Res({ passthrough: true }) res: FastifyReply) {
    return tagged(res, await this.incidents.followup(actor, id, requireIfMatch(req.headers['if-match']), parse(PlatformOps.incidentFollowup.body, body), requestMeta(req)));
  }
}
