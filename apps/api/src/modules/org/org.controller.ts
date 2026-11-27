// Spec 0042 (P2-S1): the org tree's routes. Each declares its permission; the unit routes are scoped (Q13): the guard
// admits a caller holding the permission somewhere, and the use case decides against the loaded unit (404 if out).
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { OrgOps } from '@univarse/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { Contract } from '../../openapi/contract.js';
import { ProblemError } from '../../shared/errors/problem.js';
import { etagOf, requireIfMatch } from '../../shared/http/etag.js';
import { parse } from '../../shared/http/validate.js';
import { CurrentTenant } from '../../shared/tenancy/tenant.guard.js';
import type { TenantContext } from '../../shared/tenancy/tenant-resolver.service.js';
import {
  CurrentActor,
  RequirePermission,
  RequireScopedPermission,
} from '../identity/access.guard.js';
import type { Actor } from '../identity/actor.js';
import { Product } from '../products/product.guard.js';
import { OrgUnitService, type UnitView } from './org-units.service.js';
import { UnitTypeService } from './unit-types.service.js';

const meta = (req: FastifyRequest) => ({
  ip: req.ip,
  userAgent: req.headers['user-agent'],
  requestId: req.id,
});
const IdempotencyKey = z.uuid();

/** Q-A2: required on create. A missing or malformed key is refused before anything is read. */
function idempotencyKey(req: FastifyRequest): string {
  const raw = req.headers['idempotency-key'];
  const parsed = IdempotencyKey.safeParse(Array.isArray(raw) ? undefined : raw);
  if (!parsed.success) {
    throw Object.assign(
      new ProblemError(400, 'request.invalid', 'An Idempotency-Key header (a UUID) is required'),
      {
        errors: [{ path: 'Idempotency-Key', code: 'required', message: 'A UUID is required' }],
      },
    );
  }
  return parsed.data;
}

const withEtag = (reply: FastifyReply, view: UnitView) => {
  void reply.header('etag', etagOf(view.version));
  return view;
};

@Controller('api/v1/org')
@Product('core')
export class OrgController {
  constructor(
    private readonly units: OrgUnitService,
    private readonly types: UnitTypeService,
  ) {}

  @Contract(OrgOps.listOrgUnits)
  @Get('units')
  @RequireScopedPermission('org.unit.view')
  list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentActor() actor: Actor,
    @Query() query: unknown,
  ) {
    return this.units.list(tenant, actor, parse(OrgOps.listOrgUnits.query, query));
  }

  @Contract(OrgOps.getOrgUnit)
  @Get('units/:id')
  @RequireScopedPermission('org.unit.view')
  async get(
    @CurrentTenant() tenant: TenantContext,
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return withEtag(reply, await this.units.view(tenant, actor, id));
  }

  @Contract(OrgOps.getOrgUnitHistory)
  @Get('units/:id/history')
  @RequireScopedPermission('org.unit.view')
  history(
    @CurrentTenant() tenant: TenantContext,
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
  ) {
    return this.units.history(tenant, actor, id);
  }

  @Contract(OrgOps.createOrgUnit)
  @Post('units')
  @RequireScopedPermission('org.unit.manage')
  async create(
    @CurrentTenant() tenant: TenantContext,
    @CurrentActor() actor: Actor,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const key = idempotencyKey(req);
    const { view, replayed } = await this.units.create(
      tenant,
      actor,
      parse(OrgOps.createOrgUnit.body, body),
      key,
      meta(req),
    );
    void reply.status(201);
    if (replayed) void reply.header('idempotent-replayed', 'true');
    return withEtag(reply, view);
  }

  @Contract(OrgOps.updateOrgUnit)
  @Patch('units/:id')
  @RequireScopedPermission('org.unit.manage')
  async update(
    @CurrentTenant() tenant: TenantContext,
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const parsed = parse(OrgOps.updateOrgUnit.body, body);
    return withEtag(
      reply,
      await this.units.update(
        tenant,
        actor,
        id,
        requireIfMatch(req.headers['if-match']),
        parsed,
        meta(req),
      ),
    );
  }

  @Contract(OrgOps.moveOrgUnit)
  @Post('units/:id/move')
  @HttpCode(200)
  @RequireScopedPermission('org.unit.restructure')
  async move(
    @CurrentTenant() tenant: TenantContext,
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const parsed = parse(OrgOps.moveOrgUnit.body, body);
    return withEtag(
      reply,
      await this.units.move(
        tenant,
        actor,
        id,
        requireIfMatch(req.headers['if-match']),
        parsed,
        meta(req),
      ),
    );
  }

  @Contract(OrgOps.deactivateOrgUnit)
  @Post('units/:id/deactivate')
  @HttpCode(200)
  @RequireScopedPermission('org.unit.manage')
  async deactivate(
    @CurrentTenant() tenant: TenantContext,
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const parsed = parse(OrgOps.deactivateOrgUnit.body, body);
    return withEtag(
      reply,
      await this.units.setState(
        tenant,
        actor,
        id,
        requireIfMatch(req.headers['if-match']),
        'deactivate',
        parsed,
        meta(req),
      ),
    );
  }

  @Contract(OrgOps.archiveOrgUnit)
  @Post('units/:id/archive')
  @HttpCode(200)
  @RequireScopedPermission('org.unit.restructure')
  async archive(
    @CurrentTenant() tenant: TenantContext,
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const parsed = parse(OrgOps.archiveOrgUnit.body, body);
    return withEtag(
      reply,
      await this.units.setState(
        tenant,
        actor,
        id,
        requireIfMatch(req.headers['if-match']),
        'archive',
        parsed,
        meta(req),
      ),
    );
  }

  /** From inactive needs `org.unit.manage`; from archived, `org.unit.restructure` (checked on the loaded unit). */
  @Contract(OrgOps.reactivateOrgUnit)
  @Post('units/:id/reactivate')
  @HttpCode(200)
  @RequireScopedPermission('org.unit.manage')
  async reactivate(
    @CurrentTenant() tenant: TenantContext,
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const parsed = parse(OrgOps.reactivateOrgUnit.body, body);
    return withEtag(
      reply,
      await this.units.setState(
        tenant,
        actor,
        id,
        requireIfMatch(req.headers['if-match']),
        'reactivate',
        parsed,
        meta(req),
      ),
    );
  }

  @Contract(OrgOps.changeOrgUnitCode)
  @Post('units/:id/code')
  @HttpCode(200)
  @RequireScopedPermission('org.unit.restructure')
  async changeCode(
    @CurrentTenant() tenant: TenantContext,
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const parsed = parse(OrgOps.changeOrgUnitCode.body, body);
    return withEtag(
      reply,
      await this.units.changeCode(
        tenant,
        actor,
        id,
        requireIfMatch(req.headers['if-match']),
        parsed,
        meta(req),
      ),
    );
  }

  @Contract(OrgOps.listUnitTypes)
  @Get('unit-types')
  @RequireScopedPermission('org.unit.view')
  listTypes(@CurrentTenant() tenant: TenantContext, @CurrentActor() actor: Actor) {
    return this.types.list(tenant, actor);
  }

  @Contract(OrgOps.saveUnitType)
  @Put('unit-types/:key')
  @RequirePermission('org.unit_type.manage')
  async saveType(
    @CurrentTenant() tenant: TenantContext,
    @CurrentActor() actor: Actor,
    @Param('key') key: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const parsed = parse(OrgOps.saveUnitType.body, body);
    const view = await this.types.save(
      tenant,
      actor,
      key,
      requireIfMatch(req.headers['if-match']),
      parsed,
      meta(req),
    );
    void reply.header('etag', etagOf(view.version));
    return view;
  }
}
