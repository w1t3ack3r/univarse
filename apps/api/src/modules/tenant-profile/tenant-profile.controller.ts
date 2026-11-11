import { Controller, Get, Query, Req, Res } from '@nestjs/common';
import { textColorOn } from '@univarse/domain';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ProblemError } from '../../shared/errors/problem.js';
import { IMMUTABLE_IMAGE } from '../../shared/http/fastify-hooks.js';
import { parse } from '../../shared/http/validate.js';
import { TenantOps } from '@univarse/contracts';
import { Contract } from '../../openapi/contract.js';
import { Public } from '../identity/access.guard.js';
import { CurrentTenant } from '../../shared/tenancy/tenant.guard.js';
import type { TenantContext } from '../../shared/tenancy/tenant-resolver.service.js';
import { Product } from '../products/product.guard.js';
import { TenantLogos } from './tenant-logo.service.js';

/** Public branding/profile for the tenant serving this host (docs/11 §1). No personal data. */
@Controller('api/v1/tenant')
@Product('core')
export class TenantProfileController {
  constructor(private readonly logos: TenantLogos) {}

  @Contract(TenantOps.publicProfile)
  @Get('public-profile')
  @Public()
  profile(@CurrentTenant() tenant: TenantContext) {
    const primaryColor = tenant.primaryColor;
    return {
      slug: tenant.slug,
      shortName: tenant.shortName,
      legalName: tenant.legalName,
      type: tenant.type,
      branding: { primaryColor, textColor: primaryColor ? textColorOn(primaryColor) : null, logoSha256: tenant.logoSha256 },
    };
  }

  /**
   * Spec 0033 Q11: only this host's institution's logo, as its checked type. The global hook adds nosniff and the CSP;
   * the hash is the ETag, so a browser that has it gets 304. Asked for under its current hash, the browser may keep it:
   * a new logo has a new hash, so a new URL. Any other `v` is served, but never cached.
   */
  @Contract(TenantOps.tenantLogo)
  @Get('logo')
  @Public()
  async logo(@CurrentTenant() tenant: TenantContext, @Query() query: unknown, @Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    const { v } = parse(TenantOps.tenantLogo.query, query);
    const logo = await this.logos.forTenant(tenant);
    if (!logo) throw new ProblemError(404, 'resource.not_found', 'Not found');
    const etag = `"${logo.sha256}"`;
    void reply.header('etag', etag);
    if (req.headers['if-none-match'] === etag) {
      void reply.code(304);
      return '';
    }
    void reply.header('content-type', logo.mime).header('content-length', String(logo.bytes.length));
    if (v === logo.sha256) void reply.header('cache-control', IMMUTABLE_IMAGE);
    return Buffer.from(logo.bytes);
  }
}
