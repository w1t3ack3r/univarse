// Spec 0028: the console's sign-in, account and staff routes, under /api/platform/v1. Each declares its access (the
// platform route sweep fails one that doesn't); validation is the contract's zod schema; writes pass the CSRF guard.
import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Req, Res } from '@nestjs/common';
import { PLATFORM_ROLE_PERMISSIONS, isPlatformRole } from '@univarse/domain';
import { PlatformOps } from '@univarse/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { parse } from '../../shared/http/validate.js';
import { CurrentPlatformActor, PlatformPublic, PlatformRateLimit, PlatformSession, RequirePlatformPermission, RequirePlatformStepUp, requestMeta } from './access.js';
import { PlatformIdentity, sessionState } from './identity.service.js';
import { PlatformStaff } from './staff.service.js';
import {
  CHALLENGE_COOKIE,
  challengeCookie,
  clearedChallengeCookie,
  clearedSessionCookie,
  DEVICE_COOKIE,
  deviceCookie,
  readCookie,
  sessionCookie,
  type PlatformActor,
} from './types.js';

/** Sign-in routes: a person types these, a script hammers them. Per address, per minute (Q9). */
const AUTH_RATE = 20;

@Controller('api/platform/v1/auth')
export class PlatformAuthController {
  constructor(private readonly identity: PlatformIdentity) {}

  @Post('activate')
  @PlatformPublic()
  @PlatformRateLimit(AUTH_RATE)
  @HttpCode(200)
  async activate(@Body() body: unknown, @Req() req: FastifyRequest, @Res({ passthrough: true }) res: FastifyReply) {
    const { token } = await this.identity.activate(parse(PlatformOps.activate.body, body), requestMeta(req));
    res.header('set-cookie', sessionCookie(token));
    return { next: 'enrol' as const };
  }

  @Post('login')
  @PlatformPublic()
  @PlatformRateLimit(AUTH_RATE)
  @HttpCode(200)
  async login(@Body() body: unknown, @Req() req: FastifyRequest, @Res({ passthrough: true }) res: FastifyReply) {
    const outcome = await this.identity.login(parse(PlatformOps.login.body, body), requestMeta(req));
    if (outcome.next === 'mfa') res.header('set-cookie', challengeCookie(outcome.challenge));
    else res.header('set-cookie', sessionCookie(outcome.token));
    return { next: outcome.next };
  }

  @Post('mfa')
  @PlatformPublic()
  @PlatformRateLimit(AUTH_RATE)
  @HttpCode(200)
  async verify(@Body() body: unknown, @Req() req: FastifyRequest, @Res({ passthrough: true }) res: FastifyReply) {
    const input = parse(PlatformOps.verifyMfa.body, body);
    const challenge = readCookie(req.headers.cookie, CHALLENGE_COOKIE);
    const issued = await this.identity.verify(challenge ?? '', input, readCookie(req.headers.cookie, DEVICE_COOKIE), requestMeta(req));
    res.header('set-cookie', [sessionCookie(issued.token), clearedChallengeCookie(), ...(issued.deviceId ? [deviceCookie(issued.deviceId)] : [])]);
    return { next: 'home' as const };
  }

  @Post('password-reset/request')
  @PlatformPublic()
  @PlatformRateLimit(AUTH_RATE)
  @HttpCode(202)
  async requestReset(@Body() body: unknown, @Req() req: FastifyRequest) {
    await this.identity.requestPasswordReset(parse(PlatformOps.requestPasswordReset.body, body).email, requestMeta(req));
    return { message: 'If an active account matches, a reset code has been sent to its email address.' };
  }

  @Post('password-reset/confirm')
  @PlatformPublic()
  @PlatformRateLimit(AUTH_RATE)
  @HttpCode(204)
  async confirmReset(@Body() body: unknown, @Req() req: FastifyRequest) {
    await this.identity.confirmPasswordReset(parse(PlatformOps.confirmPasswordReset.body, body), requestMeta(req));
  }

  @Post('logout')
  @PlatformSession()
  @HttpCode(204)
  async logout(@CurrentPlatformActor() actor: PlatformActor, @Req() req: FastifyRequest, @Res({ passthrough: true }) res: FastifyReply) {
    await this.identity.logout(actor, requestMeta(req));
    res.header('set-cookie', clearedSessionCookie());
  }
}

@Controller('api/platform/v1/me')
export class PlatformAccountController {
  constructor(private readonly identity: PlatformIdentity) {}

  @Get()
  @PlatformSession()
  me(@CurrentPlatformActor() actor: PlatformActor) {
    const state = sessionState(actor);
    return {
      id: actor.userId,
      email: actor.email,
      displayName: actor.displayName,
      role: actor.role,
      state,
      permissions: state === 'full' && isPlatformRole(actor.role) ? [...PLATFORM_ROLE_PERMISSIONS[actor.role]] : [],
    };
  }

  @Post('mfa/enrol')
  @PlatformSession()
  @HttpCode(200)
  beginEnrolment(@CurrentPlatformActor() actor: PlatformActor, @Req() req: FastifyRequest) {
    return this.identity.beginEnrolment(actor, requestMeta(req));
  }

  @Post('mfa/enrol/confirm')
  @PlatformSession()
  @PlatformRateLimit(AUTH_RATE)
  @HttpCode(200)
  async confirmEnrolment(@CurrentPlatformActor() actor: PlatformActor, @Body() body: unknown, @Req() req: FastifyRequest, @Res({ passthrough: true }) res: FastifyReply) {
    const { token, recoveryCodes } = await this.identity.confirmEnrolment(actor, parse(PlatformOps.confirmEnrolment.body, body).code, requestMeta(req));
    res.header('set-cookie', sessionCookie(token));
    return { recoveryCodes };
  }

  @Post('mfa/recovery-codes/saved')
  @PlatformSession()
  @HttpCode(204)
  async acknowledge(@CurrentPlatformActor() actor: PlatformActor, @Req() req: FastifyRequest, @Res({ passthrough: true }) res: FastifyReply) {
    const { token } = await this.identity.acknowledgeRecoveryCodes(actor, requestMeta(req));
    res.header('set-cookie', sessionCookie(token));
  }

  @Post('step-up')
  @RequirePlatformPermission('platform.self')
  @PlatformRateLimit(AUTH_RATE)
  @HttpCode(204)
  async stepUp(@CurrentPlatformActor() actor: PlatformActor, @Body() body: unknown, @Req() req: FastifyRequest, @Res({ passthrough: true }) res: FastifyReply) {
    const { token } = await this.identity.stepUp(actor, parse(PlatformOps.stepUp.body, body), requestMeta(req));
    res.header('set-cookie', sessionCookie(token));
  }

  @Post('mfa/recovery-codes')
  @RequirePlatformPermission('platform.self')
  @RequirePlatformStepUp()
  @HttpCode(200)
  async regenerate(@CurrentPlatformActor() actor: PlatformActor, @Req() req: FastifyRequest) {
    return { recoveryCodes: await this.identity.regenerateRecoveryCodes(actor, requestMeta(req)) };
  }

  @Get('sessions')
  @RequirePlatformPermission('platform.self')
  async sessions(@CurrentPlatformActor() actor: PlatformActor) {
    return { data: await this.identity.listSessions(actor) };
  }

  @Delete('sessions/:id')
  @RequirePlatformPermission('platform.self')
  @HttpCode(204)
  async endSession(@CurrentPlatformActor() actor: PlatformActor, @Param('id', new ParseUUIDPipe()) id: string, @Req() req: FastifyRequest) {
    await this.identity.endSession(actor, id, requestMeta(req));
  }
}

@Controller('api/platform/v1/staff')
export class PlatformStaffController {
  constructor(private readonly staff: PlatformStaff) {}

  @Get()
  @RequirePlatformPermission('platform.staff.read')
  async list() {
    return { data: await this.staff.list() };
  }

  @Post()
  @RequirePlatformPermission('platform.staff.manage')
  @HttpCode(201)
  invite(@CurrentPlatformActor() actor: PlatformActor, @Body() body: unknown, @Req() req: FastifyRequest) {
    return this.staff.invite(actor, parse(PlatformOps.invite.body, body), requestMeta(req));
  }

  @Post(':id/role')
  @RequirePlatformPermission('platform.staff.manage')
  @HttpCode(200)
  changeRole(@CurrentPlatformActor() actor: PlatformActor, @Param('id', new ParseUUIDPipe()) id: string, @Body() body: unknown, @Req() req: FastifyRequest) {
    return this.staff.changeRole(actor, id, parse(PlatformOps.changeRole.body, body).role, requestMeta(req));
  }

  @Post(':id/deactivate')
  @RequirePlatformPermission('platform.staff.manage')
  @HttpCode(200)
  deactivate(@CurrentPlatformActor() actor: PlatformActor, @Param('id', new ParseUUIDPipe()) id: string, @Req() req: FastifyRequest) {
    return this.staff.deactivate(actor, id, requestMeta(req));
  }

  @Post(':id/reinstate')
  @RequirePlatformPermission('platform.staff.manage')
  @HttpCode(200)
  reinstate(@CurrentPlatformActor() actor: PlatformActor, @Param('id', new ParseUUIDPipe()) id: string, @Req() req: FastifyRequest) {
    return this.staff.reinstate(actor, id, requestMeta(req));
  }

  @Post(':id/mfa-reset')
  @RequirePlatformPermission('platform.staff.manage')
  @HttpCode(200)
  resetMfa(@CurrentPlatformActor() actor: PlatformActor, @Param('id', new ParseUUIDPipe()) id: string, @Req() req: FastifyRequest) {
    return this.staff.resetMfa(actor, id, requestMeta(req));
  }
}
