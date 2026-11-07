// Spec 0031: the console's view of what happened. Each route declares its permission (the platform route sweep fails
// one that doesn't); out of scope is 404, as everywhere.
import { Body, Controller, Get, HttpCode, Post, Query, Req } from '@nestjs/common';
import { PlatformOps } from '@univarse/contracts';
import type { FastifyRequest } from 'fastify';
import { parse } from '../../shared/http/validate.js';
import { CurrentPlatformActor, PlatformRateLimit, RequirePlatformPermission, requestMeta } from '../identity/access.js';
import type { PlatformActor } from '../identity/types.js';
import { PlatformAccessReviews } from './access-review.js';
import { PlatformAuditLog } from './audit-log.js';
import { ChainVerification } from './chain-verification.js';
import { PlatformSecurityView } from './security-view.js';

@Controller('api/platform/v1/audit')
export class PlatformAuditController {
  constructor(
    private readonly log: PlatformAuditLog,
    private readonly chain: ChainVerification,
  ) {}

  /** A `GET` that writes: a new query is audited (Q3). */
  @Get()
  @RequirePlatformPermission('platform.audit.read')
  list(@CurrentPlatformActor() actor: PlatformActor, @Query() query: unknown, @Req() req: FastifyRequest) {
    return this.log.list(actor, parse(PlatformOps.audit.query, query), requestMeta(req));
  }

  @Get('verification')
  @RequirePlatformPermission('platform.audit.read')
  async verification() {
    const { runs, broken } = await this.chain.recent();
    const shown = await this.chain.named(runs);
    return { latest: shown[0] ?? null, recent: shown, broken };
  }

  @Post('verification')
  @RequirePlatformPermission('platform.audit.verify')
  @PlatformRateLimit(6)
  @HttpCode(202)
  async verify(@CurrentPlatformActor() actor: PlatformActor, @Req() req: FastifyRequest) {
    const run = await this.chain.start(actor, requestMeta(req));
    return (await this.chain.named([run]))[0];
  }
}

@Controller('api/platform/v1/security')
export class PlatformSecurityController {
  constructor(private readonly view: PlatformSecurityView) {}

  @Get()
  @RequirePlatformPermission('platform.security.read')
  summary(@Query() query: unknown) {
    return this.view.summary(parse(PlatformOps.security.query, query));
  }
}

@Controller('api/platform/v1/access-review')
export class PlatformAccessReviewController {
  constructor(private readonly reviews: PlatformAccessReviews) {}

  @Get()
  @RequirePlatformPermission('platform.access_review.read')
  current() {
    return this.reviews.current();
  }

  @Post()
  @RequirePlatformPermission('platform.access_review.attest')
  @HttpCode(201)
  attest(@CurrentPlatformActor() actor: PlatformActor, @Body() body: unknown, @Req() req: FastifyRequest) {
    return this.reviews.attest(actor, parse(PlatformOps.attestAccessReview.body, body), requestMeta(req));
  }
}
