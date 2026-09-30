import {
  createParamDecorator,
  Injectable,
  Logger,
  SetMetadata,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Permission } from '@univarse/contracts';
import type { FastifyRequest } from 'fastify';
import { ProblemError } from '../../shared/errors/problem.js';
import { NO_TENANT } from '../../shared/tenancy/tenant.guard.js';
import { canInstitutionWide, isPrivileged, type Actor } from './actor.js';
import { readSessionCookie, SessionService } from './session.service.js';

const ACCESS = 'univarse:access';
type Access = { kind: 'public' } | { kind: 'authenticated' } | { kind: 'permission'; permission: Permission };

/** Anyone on the tenant host (login, activation, public profile). */
export const Public = () => SetMetadata(ACCESS, { kind: 'public' } satisfies Access);
/** Any signed-in member of this tenant (e.g. /me, logout). */
export const Authenticated = () => SetMetadata(ACCESS, { kind: 'authenticated' } satisfies Access);
/** Signed-in member holding the permission institution-wide. */
export const RequirePermission = (permission: Permission) =>
  SetMetadata(ACCESS, { kind: 'permission', permission } satisfies Access);

declare module 'fastify' {
  interface FastifyRequest {
    actor?: Actor;
  }
}

/**
 * Deny-by-default access guard (docs/08 §4). Runs after TenantGuard.
 * A route with no access declaration is refused and logged as a bug.
 */
@Injectable()
export class AccessGuard implements CanActivate {
  private readonly logger = new Logger('Access');

  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(NO_TENANT, targets)) return true;

    const access = this.reflector.getAllAndOverride<Access | undefined>(ACCESS, targets);
    const req = ctx.switchToHttp().getRequest<FastifyRequest>();
    if (!access) {
      this.logger.error(`Route without access declaration: ${req.method} ${req.routeOptions.url}`);
      throw new ProblemError(403, 'auth.forbidden', 'Forbidden');
    }
    if (access.kind === 'public') return true;

    const token = readSessionCookie(req.headers.cookie);
    const actor = token && req.tenant ? await this.sessions.authenticate(req.tenant, token, req.id) : null;
    if (!actor) throw new ProblemError(401, 'auth.unauthenticated', 'Authentication required');
    req.actor = actor;

    if (access.kind === 'permission') {
      if (!canInstitutionWide(actor, access.permission)) {
        throw new ProblemError(403, 'auth.forbidden', 'Forbidden');
      }
      if (isPrivileged(access.permission) && !actor.mfaAt) {
        throw new ProblemError(403, 'auth.mfa_required', 'Multi-factor authentication required');
      }
    }
    return true;
  }
}

export const CurrentActor = createParamDecorator((_: unknown, ctx: ExecutionContext): Actor => {
  const actor = ctx.switchToHttp().getRequest<FastifyRequest>().actor;
  if (!actor) throw new Error('CurrentActor used on a route that is not authenticated');
  return actor;
});
