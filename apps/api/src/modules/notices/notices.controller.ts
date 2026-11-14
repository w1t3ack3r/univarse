// Spec 0037 Q10: the institution's notice banners. The public list carries only maintenance (it shows on the sign-in
// page); the signed-in list adds announcements and release notes for IT Admins. Dismissing is per person.
import { Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { TenantOps } from '@univarse/contracts';
import { Contract } from '../../openapi/contract.js';
import { ProblemError } from '../../shared/errors/problem.js';
import { CurrentTenant } from '../../shared/tenancy/tenant.guard.js';
import type { TenantContext } from '../../shared/tenancy/tenant-resolver.service.js';
import type { Actor } from '../identity/actor.js';
import { Authenticated, CurrentActor, Public } from '../identity/access.guard.js';
import { Product } from '../products/product.guard.js';
import { IncidentBoard } from './incident-board.service.js';
import { NoticeBoard } from './notice-board.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Controller()
@Product('core')
export class NoticesController {
  constructor(
    private readonly board: NoticeBoard,
    private readonly incidents: IncidentBoard,
  ) {}

  @Contract(TenantOps.publicNotices)
  @Get('api/v1/tenant/notices')
  @Public()
  async everyone(@CurrentTenant() tenant: TenantContext) {
    return { data: await this.board.forEveryone(tenant) };
  }

  /** Spec 0037 Q14: incidents affecting this institution, for everyone there (its sign-in page and its workspace). */
  @Contract(TenantOps.publicIncidents)
  @Get('api/v1/tenant/incidents')
  @Public()
  async incidentsHere(@CurrentTenant() tenant: TenantContext) {
    return { data: await this.incidents.forTenant(tenant) };
  }

  @Contract(TenantOps.myNotices)
  @Get('api/v1/notices')
  @Authenticated()
  async mine(@CurrentTenant() tenant: TenantContext, @CurrentActor() actor: Actor) {
    return { data: await this.board.forActor(tenant, actor) };
  }

  @Contract(TenantOps.dismissNotice)
  @Post('api/v1/notices/:id/dismiss')
  @Authenticated()
  @HttpCode(204)
  async dismiss(@CurrentTenant() tenant: TenantContext, @CurrentActor() actor: Actor, @Param('id') id: string) {
    // Spec 0010 FU2's rule: a malformed id is answered exactly as an unknown one.
    if (!UUID.test(id)) throw new ProblemError(404, 'resource.not_found', 'Not found');
    await this.board.dismiss(tenant, actor, id);
  }
}
