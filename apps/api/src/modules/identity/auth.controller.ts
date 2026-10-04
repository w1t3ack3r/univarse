import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { parse } from '../../shared/http/validate.js';
import { CurrentTenant } from '../../shared/tenancy/tenant.guard.js';
import type { TenantContext } from '../../shared/tenancy/tenant-resolver.service.js';
import { AllowRestricted, Authenticated, CurrentActor, Public } from './access.guard.js';
import type { Actor } from './actor.js';
import { AuthService } from './auth.service.js';
import { challengeCookie, clearedSessionCookie, sessionCookie, SessionService } from './session.service.js';
import { Product } from '../products/product.guard.js';

const Identifier = z.string().trim().min(1).max(254);
/** Shared by activation and reset: both take an identifier, then identifier + code + new password. */
const RequestActivation = z.object({ username: Identifier }).strict();
const ConfirmActivation = z
  .object({ username: Identifier, code: z.string().regex(/^\d{6}$/), password: z.string().min(1).max(256) })
  .strict();
const Login = z.object({ username: Identifier, password: z.string().min(1).max(256) }).strict();
/** S2: password, plus a TOTP code or a recovery code for MFA users (never both). */
const StepUp = z
  .object({
    password: z.string().min(1).max(256),
    code: z.string().regex(/^\d{6}$/).optional(),
    recoveryCode: z.string().trim().min(10).max(20).optional(),
  })
  .strict()
  .refine((v) => !(v.code && v.recoveryCode), 'Send either code or recoveryCode, not both');

const meta = (req: FastifyRequest) => ({ ip: req.ip, userAgent: req.headers['user-agent'], requestId: req.id });

@Controller('api/v1/auth')
@Product('core')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
  ) {}

  @Post('activation/request')
  @Public()
  @HttpCode(202)
  async requestActivation(@CurrentTenant() tenant: TenantContext, @Body() body: unknown, @Req() req: FastifyRequest) {
    const input = parse(RequestActivation, body);
    await this.auth.requestActivation(tenant, input.username, req.ip);
    return { message: 'If an account is awaiting activation, a code has been sent to its email address.' };
  }

  @Post('activation/confirm')
  @Public()
  @HttpCode(204)
  async confirmActivation(@CurrentTenant() tenant: TenantContext, @Body() body: unknown, @Req() req: FastifyRequest) {
    await this.auth.confirmActivation(tenant, parse(ConfirmActivation, body), req.ip);
  }

  @Post('password-reset/request')
  @Public()
  @HttpCode(202)
  async requestReset(@CurrentTenant() tenant: TenantContext, @Body() body: unknown, @Req() req: FastifyRequest) {
    const input = parse(RequestActivation, body);
    await this.auth.requestPasswordReset(tenant, input.username, req.ip);
    return { message: 'If an active account matches, a reset code has been sent to its email address.' };
  }

  @Post('password-reset/confirm')
  @Public()
  @HttpCode(204)
  async confirmReset(@CurrentTenant() tenant: TenantContext, @Body() body: unknown, @Req() req: FastifyRequest) {
    await this.auth.confirmPasswordReset(tenant, parse(ConfirmActivation, body), req.ip);
  }

  @Post('login')
  @Public()
  @HttpCode(200)
  async login(
    @CurrentTenant() tenant: TenantContext,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const result = await this.auth.login(tenant, parse(Login, body), meta(req));
    if (result.kind === 'mfa_challenge') {
      // M4: no session yet — only a short-lived challenge cookie usable at /auth/mfa/verify.
      void reply.header('set-cookie', challengeCookie(result.challengeToken));
      return { mfaRequired: true };
    }
    void reply.header('set-cookie', sessionCookie(result.token, result.maxAgeSec));
    return { user: result.user, ...(result.mfaEnrolmentRequired ? { mfaEnrolmentRequired: true } : {}) };
  }

  /** S1–S8, S11, S12. NOT @AllowRestricted: an enrolment-only session can't step up (S8). */
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
    const session = await this.auth.stepUp(tenant, actor, parse(StepUp, body), meta(req));
    // S3: the old token is already revoked; this cookie replaces it.
    void reply.header('set-cookie', sessionCookie(session.token, session.maxAgeSec));
    return { stepUp: true };
  }

  @Post('logout')
  @Authenticated()
  @AllowRestricted()
  @HttpCode(204)
  async logout(
    @CurrentTenant() tenant: TenantContext,
    @CurrentActor() actor: Actor,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    await this.sessions.revoke(tenant, actor.sessionId, 'logout', { actorId: actor.userId, action: 'auth.logout', meta: meta(req) });
    void reply.header('set-cookie', clearedSessionCookie());
  }

  @Get('me')
  @Authenticated()
  @AllowRestricted()
  me(@CurrentActor() actor: Actor) {
    return {
      id: actor.userId,
      username: actor.username,
      displayName: actor.displayName,
      mfa: actor.mfaAt !== null,
      restricted: actor.restricted,
      permissions: [...new Set(actor.grants.filter((g) => g.scopeType === 'INSTITUTION').map((g) => g.permission))].sort(),
    };
  }
}
