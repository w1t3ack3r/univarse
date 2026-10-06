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
import { canInstitutionWide, hasFreshStepUp, isPrivileged, requiresStepUp, type Actor } from './actor.js';
import { readSessionCookie, SessionService } from './session.service.js';

const ACCESS = 'univarse:access';
export type Access = { kind: 'public' } | { kind: 'authenticated' } | { kind: 'permission'; permission: Permission };

/** Anyone on the tenant host (login, activation, public profile). */
export const Public = () => SetMetadata(ACCESS, { kind: 'public' } satisfies Access);
/** Any signed-in member of this tenant (e.g. /me, logout). */
export const Authenticated = () => SetMetadata(ACCESS, { kind: 'authenticated' } satisfies Access);
const ALLOW_RESTRICTED = 'univarse:allow-restricted';
const REQUIRE_STEP_UP = 'univarse:require-step-up';
/** Requires a step-up on THIS session within the last 5 minutes (spec 0001 S1). Combine with @Authenticated(). */
export const RequireStepUp = () => SetMetadata(REQUIRE_STEP_UP, true);
/** Reachable from an enrolment-only (restricted) session: MFA enrolment, logout, /me (spec 0001 M8). */
export const AllowRestricted = () => SetMetadata(ALLOW_RESTRICTED, true);

/** Signed-in member holding the permission institution-wide. */
export const RequirePermission = (permission: Permission) =>
  SetMetadata(ACCESS, { kind: 'permission', permission } satisfies Access);

/**
 * What AccessGuard will enforce for a handler, read from the same metadata with the same precedence
 * (handler over class). Used by the OpenAPI generator (spec 0011 OA5), so the document can't drift.
 */
export function routeAccess(handler: object, controller: object): { access: Access | undefined; explicitStepUp: boolean; allowRestricted: boolean } {
  const read = (key: string): unknown => Reflect.getMetadata(key, handler) ?? Reflect.getMetadata(key, controller);
  return { access: read(ACCESS) as Access | undefined, explicitStepUp: read(REQUIRE_STEP_UP) === true, allowRestricted: read(ALLOW_RESTRICTED) === true };
}

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
    const explicitStepUp = this.reflector.getAllAndOverride<boolean | undefined>(REQUIRE_STEP_UP, targets) === true;
    if (access.kind === 'public') {
      // Step-up on a public route can never be satisfied; refuse rather than silently skip it.
      if (explicitStepUp) {
        this.logger.error(`@RequireStepUp() on a public route: ${req.method} ${req.routeOptions.url}`);
        throw new ProblemError(403, 'auth.forbidden', 'Forbidden');
      }
      return true;
    }

    const token = readSessionCookie(req.headers.cookie);
    const actor = token && req.tenant ? await this.sessions.authenticate(req.tenant, token, req.id) : null;
    if (!actor) throw new ProblemError(401, 'auth.unauthenticated', 'Authentication required');
    req.actor = actor;

    if (actor.restricted && !this.reflector.getAllAndOverride<boolean>(ALLOW_RESTRICTED, targets)) {
      throw new ProblemError(403, 'auth.mfa_enrolment_required', 'Set up multi-factor authentication to continue');
    }

    if (access.kind === 'permission') enforcePermission(actor, access.permission);
    // S1: explicit @RequireStepUp() (a permission flagged stepUp is enforced above).
    if (explicitStepUp) enforceStepUp(actor);
    return true;
  }
}

/**
 * The permission checks of a `@RequirePermission` route, for permissions only known at run time
 * (e.g. a setting's own manage permission, spec 0007 ST4): held institution-wide, MFA if privileged,
 * and a fresh step-up if the catalog flags it (S9).
 */
export function enforcePermission(actor: Actor, permission: Permission): void {
  if (!canInstitutionWide(actor, permission)) throw new ProblemError(403, 'auth.forbidden', 'Forbidden');
  if (isPrivileged(permission) && !actor.mfaAt) {
    throw new ProblemError(403, 'auth.mfa_required', 'Multi-factor authentication required');
  }
  if (requiresStepUp(permission)) enforceStepUp(actor);
}

function enforceStepUp(actor: Actor): void {
  if (!hasFreshStepUp(actor, new Date())) throw new ProblemError(428, 'auth.step_up_required', 'Confirm your identity to continue');
}

export const CurrentActor = createParamDecorator((_: unknown, ctx: ExecutionContext): Actor => {
  const actor = ctx.switchToHttp().getRequest<FastifyRequest>().actor;
  if (!actor) throw new Error('CurrentActor used on a route that is not authenticated');
  return actor;
});
