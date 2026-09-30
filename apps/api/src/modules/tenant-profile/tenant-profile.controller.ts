import { Controller, Get } from '@nestjs/common';
import { Public } from '../identity/access.guard.js';
import { CurrentTenant } from '../../shared/tenancy/tenant.guard.js';
import type { TenantContext } from '../../shared/tenancy/tenant-resolver.service.js';

/** Public branding/profile for the tenant serving this host (docs/11 §1). No personal data. */
@Controller('api/v1/tenant')
export class TenantProfileController {
  @Get('public-profile')
  @Public()
  profile(@CurrentTenant() tenant: TenantContext) {
    return { slug: tenant.slug, shortName: tenant.shortName, legalName: tenant.legalName, type: tenant.type };
  }
}
