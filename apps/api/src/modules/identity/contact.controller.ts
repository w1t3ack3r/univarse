// Spec 0032: the institutions' address routes. Every one declares its product and its access.
import { Body, Controller, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import { ContactOps } from '@univarse/contracts';
import type { FastifyRequest } from 'fastify';
import { Contract } from '../../openapi/contract.js';
import { ProblemError } from '../../shared/errors/problem.js';
import { parse } from '../../shared/http/validate.js';
import { CurrentTenant } from '../../shared/tenancy/tenant.guard.js';
import type { TenantContext } from '../../shared/tenancy/tenant-resolver.service.js';
import { Product } from '../products/product.guard.js';
import { Authenticated, CurrentActor, Public, RequirePermission, RequireStepUp } from './access.guard.js';
import type { Actor } from './actor.js';
import { ContactService, type ContactMeta } from './contact.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const meta = (req: FastifyRequest): ContactMeta => ({ ip: req.ip, userAgent: req.headers['user-agent'], requestId: req.id });

@Controller('api/v1')
@Product('core')
export class ContactController {
  constructor(private readonly contact: ContactService) {}

  @Contract(ContactOps.pendingContactChange)
  @Get('auth/email')
  @Authenticated()
  async pending(@CurrentTenant() tenant: TenantContext, @CurrentActor() actor: Actor) {
    return this.contact.status(tenant, actor);
  }

  /** Q2, Q4: the same answer whatever the address. */
  @Contract(ContactOps.requestContactChange)
  @Post('auth/email')
  @Authenticated()
  @RequireStepUp()
  @HttpCode(202)
  async request(@CurrentTenant() tenant: TenantContext, @CurrentActor() actor: Actor, @Body() body: unknown, @Req() req: FastifyRequest) {
    await this.contact.requestOwn(tenant, actor, parse(ContactOps.requestContactChange.body, body).email, meta(req));
    return { message: 'A code has been sent to the new address.' };
  }

  @Contract(ContactOps.confirmContactChange)
  @Post('auth/email/confirm')
  @Authenticated()
  @HttpCode(204)
  async confirm(@CurrentTenant() tenant: TenantContext, @CurrentActor() actor: Actor, @Body() body: unknown, @Req() req: FastifyRequest) {
    await this.contact.confirmOwn(tenant, actor, parse(ContactOps.confirmContactChange.body, body).code, meta(req));
  }

  /** Q7: signed out: a correction is for someone who can't sign in. */
  @Contract(ContactOps.confirmContactCorrection)
  @Post('auth/contact-change/confirm')
  @Public()
  @HttpCode(204)
  async confirmCorrection(@CurrentTenant() tenant: TenantContext, @Body() body: unknown, @Req() req: FastifyRequest) {
    await this.contact.confirmCorrection(tenant, parse(ContactOps.confirmContactCorrection.body, body), meta(req));
  }

  /** Q6: signed out, by a code in the mail to the old address. */
  @Contract(ContactOps.undoContactChange)
  @Post('auth/contact-change/undo')
  @Public()
  @HttpCode(204)
  async undo(@CurrentTenant() tenant: TenantContext, @Body() body: unknown, @Req() req: FastifyRequest) {
    await this.contact.undo(tenant, parse(ContactOps.undoContactChange.body, body), meta(req));
  }

  /** Q7, Q8, Q9: `identity.user.contact.manage` requires a step-up by its declaration. */
  @Contract(ContactOps.correctContact)
  @Post('users/:id/email')
  @RequirePermission('identity.user.contact.manage')
  @HttpCode(202)
  async correct(@CurrentTenant() tenant: TenantContext, @CurrentActor() actor: Actor, @Param('id') id: string, @Body() body: unknown, @Req() req: FastifyRequest) {
    if (!UUID.test(id)) throw new ProblemError(404, 'resource.not_found', 'Not found');
    await this.contact.correct(tenant, actor, id, parse(ContactOps.correctContact.body, body), meta(req));
    return { message: 'A code has been sent to the new address.' };
  }
}
