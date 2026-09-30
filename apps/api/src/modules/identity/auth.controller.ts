import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { parse } from '../../shared/http/validate.js';
import { CurrentTenant } from '../../shared/tenancy/tenant.guard.js';
import type { TenantContext } from '../../shared/tenancy/tenant-resolver.service.js';
import { Authenticated, CurrentActor, Public } from './access.guard.js';
import type { Actor } from './actor.js';
import { AuthService } from './auth.service.js';
import { clearedSessionCookie, sessionCookie, SessionService } from './session.service.js';

const Identifier = z.string().trim().min(1).max(254);
const RequestActivation = z.object({ username: Identifier }).strict();
const ConfirmActivation = z
  .object({ username: Identifier, code: z.string().regex(/^\d{6}$/), password: z.string().min(1).max(256) })
  .strict();
const Login = z.object({ username: Identifier, password: z.string().min(1).max(256) }).strict();

const meta = (req: FastifyRequest) => ({ ip: req.ip, userAgent: req.headers['user-agent'] });

@Controller('api/v1/auth')
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
    void reply.header('set-cookie', sessionCookie(result.token, result.maxAgeSec));
    return { user: result.user };
  }

  @Post('logout')
  @Authenticated()
  @HttpCode(204)
  async logout(
    @CurrentTenant() tenant: TenantContext,
    @CurrentActor() actor: Actor,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    await this.sessions.revoke(tenant, actor.sessionId, 'logout');
    void reply.header('set-cookie', clearedSessionCookie());
  }

  @Get('me')
  @Authenticated()
  me(@CurrentActor() actor: Actor) {
    return {
      id: actor.userId,
      username: actor.username,
      displayName: actor.displayName,
      mfa: actor.mfaAt !== null,
      permissions: [...new Set(actor.grants.filter((g) => g.scopeType === 'INSTITUTION').map((g) => g.permission))].sort(),
    };
  }
}
