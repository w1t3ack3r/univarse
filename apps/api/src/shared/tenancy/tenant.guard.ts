import {
  createParamDecorator,
  Injectable,
  SetMetadata,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { ProblemError } from '../errors/problem.js';
import { TenantResolver, type TenantContext } from './tenant-resolver.service.js';

const NO_TENANT = 'univarse:no-tenant';
/** Marks routes that run without a tenant (health checks, platform API). */
export const NoTenant = () => SetMetadata(NO_TENANT, true);

declare module 'fastify' {
  interface FastifyRequest {
    tenant?: TenantContext;
  }
}

/** Status → whether tenant-facing requests are served. */
const SERVABLE = new Set(['ACTIVE', 'ONBOARDING']);

/**
 * Global guard: every route is tenant-scoped unless marked @NoTenant().
 * Unknown / unverified hosts → 404. Suspended → 423 (docs/05 §1).
 */
@Injectable()
export class TenantGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly resolver: TenantResolver,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>(NO_TENANT, [ctx.getHandler(), ctx.getClass()])) return true;

    const req = ctx.switchToHttp().getRequest<FastifyRequest>();
    const tenant = await this.resolver.resolveHost(req.hostname);
    if (!tenant) throw new ProblemError(404, 'tenant.not_found', 'Institution not found');
    if (tenant.status === 'SUSPENDED') {
      throw new ProblemError(423, 'tenant.suspended', 'Institution suspended', 'This institution is temporarily unavailable. Please contact your ICT unit.');
    }
    if (!SERVABLE.has(tenant.status)) throw new ProblemError(404, 'tenant.not_found', 'Institution not found');

    req.tenant = tenant;
    return true;
  }
}

/** Injects the resolved tenant into a handler. Throws if used on a @NoTenant() route. */
export const CurrentTenant = createParamDecorator((_: unknown, ctx: ExecutionContext): TenantContext => {
  const tenant = ctx.switchToHttp().getRequest<FastifyRequest>().tenant;
  if (!tenant) throw new Error('CurrentTenant used on a route without tenant resolution');
  return tenant;
});
