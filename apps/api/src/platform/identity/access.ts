// Spec 0028 Q12 (spec 0025 A5): every platform route declares its access, and this guard is the only thing that
// reads it. Deny by default: a route with no declaration answers 404 and is logged as a bug (the platform route sweep
// fails it first). A refusal is 404, exactly as an unknown route answers; a member holding the permission is told only
// what to do next (enrol, or step up). The member is read from the session on every request.
import { createParamDecorator, Injectable, Logger, SetMetadata, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { evaluatePlatform, hasFreshPlatformStepUp, type PlatformPermission } from '@univarse/domain';
import type { FastifyRequest } from 'fastify';
import { ProblemError } from '../../shared/errors/problem.js';
import { setLogContext } from '../../shared/observability/context.js';
import { securityFields } from '../../shared/observability/security.js';
import { PlatformSessions } from './sessions.js';
import { readCookie, SESSION_COOKIE, type PlatformActor, type RequestMeta } from './types.js';

const ACCESS = 'univarse:platform-access';
const STEP_UP = 'univarse:platform-step-up';
const RATE = 'univarse:platform-rate';

export type PlatformAccess =
  | { readonly kind: 'public' }
  /** Any live session, whatever its state (enrolment, the recovery codes, signing out). The service checks the state. */
  | { readonly kind: 'session' }
  | { readonly kind: 'permission'; readonly permission: PlatformPermission };

/** Anyone allowed through the walls: activation, sign-in, the second factor, password reset, health. */
export const PlatformPublic = () => SetMetadata(ACCESS, { kind: 'public' } satisfies PlatformAccess);
/** Any live session, even an enrolment-only one. */
export const PlatformSession = () => SetMetadata(ACCESS, { kind: 'session' } satisfies PlatformAccess);
/** A full session whose member's role grants the permission (and a fresh step-up, if the catalogue flags it). */
export const RequirePlatformPermission = (permission: PlatformPermission) => SetMetadata(ACCESS, { kind: 'permission', permission } satisfies PlatformAccess);
/** Q11: a step-up on this session within the window, on top of the permission. */
export const RequirePlatformStepUp = () => SetMetadata(STEP_UP, true);
/** Q9: at most `perMinute` requests a minute from one address to this route. */
export const PlatformRateLimit = (perMinute: number) => SetMetadata(RATE, perMinute);

/** What the guard will enforce for a handler: the platform route sweep reads it. */
export function platformRouteAccess(handler: object, controller: object): { access: PlatformAccess | undefined; stepUp: boolean; ratePerMinute: number | undefined } {
  const read = (key: string): unknown => Reflect.getMetadata(key, handler) ?? Reflect.getMetadata(key, controller);
  return { access: read(ACCESS) as PlatformAccess | undefined, stepUp: read(STEP_UP) === true, ratePerMinute: read(RATE) as number | undefined };
}

declare module 'fastify' {
  interface FastifyRequest {
    platformActor?: PlatformActor;
  }
}

export const CurrentPlatformActor = createParamDecorator((_: unknown, ctx: ExecutionContext): PlatformActor => {
  const actor = ctx.switchToHttp().getRequest<FastifyRequest>().platformActor;
  if (!actor) throw new ProblemError(401, 'auth.unauthenticated', 'Authentication required');
  return actor;
});

export const requestMeta = (req: FastifyRequest): RequestMeta => ({ ip: req.ip, userAgent: req.headers['user-agent'], requestId: req.id });

export const hidden = () => new ProblemError(404, 'resource.not_found', 'Not found');

/**
 * Q9: a fixed one-minute window per (route, address), in this process's memory. The platform API holds no Valkey
 * credential (spec 0027 P-A2) and runs as one process; a second instance needs a shared limit (docs/10).
 */
export class AddressLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Whether one more request is allowed; counts it if so. */
  take(key: string, perMinute: number): boolean {
    const t = this.now();
    const w = this.windows.get(key);
    if (!w || t - w.start >= 60_000) {
      if (this.windows.size > 10_000) this.sweep(t);
      this.windows.set(key, { start: t, count: 1 });
      return true;
    }
    if (w.count >= perMinute) return false;
    w.count += 1;
    return true;
  }

  private sweep(t: number): void {
    for (const [k, w] of this.windows) if (t - w.start >= 60_000) this.windows.delete(k);
  }
}

@Injectable()
export class PlatformAccessGuard implements CanActivate {
  private readonly logger = new Logger('PlatformAccess');
  private readonly limiter = new AddressLimiter();

  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: PlatformSessions,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    const req = ctx.switchToHttp().getRequest<FastifyRequest>();
    const access = this.reflector.getAllAndOverride<PlatformAccess | undefined>(ACCESS, targets);
    const route = req.routeOptions.url ?? null;
    if (!access) {
      this.logger.error(securityFields('platform.route_undeclared', { method: req.method, route }), 'Platform route without an access declaration');
      throw hidden();
    }
    const perMinute = this.reflector.getAllAndOverride<number | undefined>(RATE, targets);
    if (perMinute !== undefined && !this.limiter.take(`${req.method} ${String(route)} ${req.ip}`, perMinute)) {
      this.logger.warn(securityFields('platform.rate_limited', { method: req.method, route }), 'Platform request rate-limited');
      throw new ProblemError(429, 'request.rate_limited', 'Too many requests');
    }
    const stepUp = this.reflector.getAllAndOverride<boolean | undefined>(STEP_UP, targets) === true;
    if (access.kind === 'public') {
      // A step-up on a public route could never be satisfied: refuse rather than skip it.
      if (stepUp) throw hidden();
      return true;
    }
    const token = readCookie(req.headers.cookie, SESSION_COOKIE);
    const actor = token ? await this.sessions.authenticate(token, req.id) : null;
    if (!actor) throw new ProblemError(401, 'auth.unauthenticated', 'Authentication required');
    req.platformActor = actor;
    setLogContext({ userId: actor.userId });
    if (access.kind === 'permission') {
      const decision = evaluatePlatform(actor, access.permission);
      if (!decision.allowed) {
        if (decision.reason === 'hidden') throw hidden();
        if (decision.reason === 'enrolment_required') throw new ProblemError(403, 'auth.mfa_enrolment_required', 'Set up two-factor sign-in to continue');
        throw new ProblemError(428, 'auth.step_up_required', 'Confirm your identity to continue');
      }
    }
    if (stepUp && !hasFreshPlatformStepUp(actor)) throw new ProblemError(428, 'auth.step_up_required', 'Confirm your identity to continue');
    return true;
  }
}
