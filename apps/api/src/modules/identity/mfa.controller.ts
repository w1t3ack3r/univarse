import { Body, Controller, HttpCode, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ProblemError } from '../../shared/errors/problem.js';
import { withMinimumDuration } from '../../shared/http/timing.js';
import { parse } from '../../shared/http/validate.js';
import { RateLimiter } from '../../shared/infra/rate-limiter.js';
import { CurrentTenant } from '../../shared/tenancy/tenant.guard.js';
import type { TenantContext } from '../../shared/tenancy/tenant-resolver.service.js';
import { AllowRestricted, Authenticated, CurrentActor, Public, RequireStepUp } from './access.guard.js';
import type { Actor } from './actor.js';
import { MfaService } from './mfa.service.js';
import { CHALLENGE_COOKIE, clearedChallengeCookie, readSessionCookie, sessionCookie } from './session.service.js';

const Verify = z.union([
  z.object({ code: z.string().regex(/^\d{6}$/) }).strict(),
  z.object({ recoveryCode: z.string().trim().min(10).max(20) }).strict(),
]);
const Enrol = z.object({ password: z.string().min(1).max(256) }).strict();
const Confirm = z.object({ code: z.string().regex(/^\d{6}$/) }).strict();
const StepUp = z
  .object({
    password: z.string().min(1).max(256),
    code: z.string().regex(/^\d{6}$/).optional(),
    recoveryCode: z.string().trim().min(10).max(20).optional(),
  })
  .strict()
  .refine((v) => !(v.code && v.recoveryCode), 'Send either code or recoveryCode, not both');

/** Response-time floor for verify (M13): unknown challenge vs wrong code vs bad recovery code. */
const VERIFY_FLOOR_MS = 400;

const meta = (req: FastifyRequest) => ({ ip: req.ip, userAgent: req.headers['user-agent'] });

/**
 * Spec 0001 Parts M and S. MFA-management endpoints exist only behind @RequireStepUp() (M9a, M15′).
 */
@Controller('api/v1/auth/mfa')
export class MfaController {
  constructor(
    private readonly mfa: MfaService,
    private readonly limiter: RateLimiter,
  ) {}

  private async limit(key: string, limit: number, windowSec: number) {
    const r = await this.limiter.hit(key, [{ limit, windowSec }]);
    if (!r.allowed) {
      throw Object.assign(new ProblemError(429, 'request.rate_limited', 'Too many attempts. Try again later.'), {
        retryAfterSec: r.retryAfterSec,
      });
    }
  }

  @Post('verify')
  @Public()
  @HttpCode(200)
  async verify(
    @CurrentTenant() tenant: TenantContext,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const input = parse(Verify, body);
    await this.limit(`${tenant.tenantId}:mfa-verify:ip:${req.ip}`, 30, 900);
    const challenge = readSessionCookie(req.headers.cookie, CHALLENGE_COOKIE);
    const result = await withMinimumDuration(VERIFY_FLOOR_MS, async () => {
      if (!challenge) throw new ProblemError(401, 'auth.mfa_invalid', 'Invalid or expired verification code');
      return this.mfa.verify(tenant, challenge, input, meta(req));
    });
    void reply.header('set-cookie', [sessionCookie(result.token, result.maxAgeSec), clearedChallengeCookie()]);
    return { user: result.user };
  }

  /**
   * S1–S8, S11, S12. NOT @AllowRestricted: an enrolment-only session can't step up (S8).
   * Shares login's per-IP+user rate-limit bucket (S5).
   */
  @Post('step-up')
  @Authenticated()
  @HttpCode(200)
  async stepUp(
    @CurrentTenant() tenant: TenantContext,
    @CurrentActor() actor: Actor,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const input = parse(StepUp, body);
    await this.limit(`${tenant.tenantId}:login:ipid:${req.ip}:${actor.username}`, 5, 60);
    const session = await withMinimumDuration(VERIFY_FLOOR_MS, () => this.mfa.stepUp(tenant, actor, input, meta(req)));
    void reply.header('set-cookie', sessionCookie(session.token, session.maxAgeSec));
    return { stepUp: true };
  }

  /** M9a/M9c/M9d. The response rotates the session; privileged users come back enrolment-only. */
  @Post('totp/disable')
  @Authenticated()
  @RequireStepUp()
  @HttpCode(200)
  async disable(
    @CurrentTenant() tenant: TenantContext,
    @CurrentActor() actor: Actor,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const result = await this.mfa.disable(tenant, actor, meta(req));
    void reply.header('set-cookie', sessionCookie(result.token, result.maxAgeSec));
    return { mfa: false, ...(result.mfaEnrolmentRequired ? { mfaEnrolmentRequired: true } : {}) };
  }

  /** M9a/M9b. */
  @Post('recovery-codes/regenerate')
  @Authenticated()
  @RequireStepUp()
  @HttpCode(200)
  async regenerate(@CurrentTenant() tenant: TenantContext, @CurrentActor() actor: Actor) {
    return { recoveryCodes: await this.mfa.regenerateRecoveryCodes(tenant, actor) };
  }

  @Post('totp/enrol')
  @Authenticated()
  @AllowRestricted()
  @HttpCode(200)
  async enrol(@CurrentTenant() tenant: TenantContext, @CurrentActor() actor: Actor, @Body() body: unknown) {
    await this.limit(`${tenant.tenantId}:mfa-enrol:user:${actor.userId}`, 5, 900);
    return this.mfa.beginEnrolment(tenant, actor, parse(Enrol, body).password);
  }

  @Post('totp/confirm')
  @Authenticated()
  @AllowRestricted()
  @HttpCode(200)
  async confirm(
    @CurrentTenant() tenant: TenantContext,
    @CurrentActor() actor: Actor,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    await this.limit(`${tenant.tenantId}:mfa-confirm:user:${actor.userId}`, 10, 900);
    const result = await this.mfa.confirmEnrolment(tenant, actor, parse(Confirm, body).code, meta(req));
    void reply.header('set-cookie', sessionCookie(result.token, result.maxAgeSec));
    // Shown exactly once (M3). The client must make the user save them.
    return { recoveryCodes: result.recoveryCodes };
  }
}
