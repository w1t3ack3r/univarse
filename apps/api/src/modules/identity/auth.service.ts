import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../config/config.js';
import { ShardRegistry } from '../../shared/db/db.module.js';
import { ProblemError } from '../../shared/errors/problem.js';
import { MAILER, type Mailer } from '../../shared/infra/mailer.js';
import { RateLimiter } from '../../shared/infra/rate-limiter.js';
import type { TenantContext } from '../../shared/tenancy/tenant-resolver.service.js';
import { hashPassword, needsRehash, passwordProblems, verifyAgainstDummy, verifyPassword } from './password.js';
import { SessionService, type SessionMeta } from './session.service.js';
import { hashOneTimeCode, newOneTimeCode, normaliseIdentifier, safeEqual } from './tokens.js';

const ACTIVATION_TTL_MS = 15 * 60_000;
const MAX_CODE_ATTEMPTS = 5;
const LOCK_AFTER_FAILURES = 10;
const LOCK_MS = 15 * 60_000;

const invalidCredentials = () => new ProblemError(401, 'auth.invalid_credentials', 'Invalid username or password');
const invalidActivation = () => new ProblemError(400, 'auth.activation_invalid', 'Invalid or expired activation code');

@Injectable()
export class AuthService {
  private readonly logger = new Logger('Auth');

  constructor(
    private readonly shards: ShardRegistry,
    private readonly sessions: SessionService,
    private readonly limiter: RateLimiter,
    @Inject(MAILER) private readonly mailer: Mailer,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private async limit(key: string, rules: { limit: number; windowSec: number }[]): Promise<void> {
    const r = await this.limiter.hit(key, rules);
    if (!r.allowed) {
      throw Object.assign(new ProblemError(429, 'request.rate_limited', 'Too many attempts. Try again later.'), {
        retryAfterSec: r.retryAfterSec,
      });
    }
  }

  /** Step 1 of activation: email a 6-digit code. Always answers the same way (no enumeration). */
  async requestActivation(tenant: TenantContext, rawUsername: string, ip: string): Promise<void> {
    const id = normaliseIdentifier(rawUsername);
    await this.limit(`${tenant.tenantId}:act-req:ip:${ip}`, [{ limit: 20, windowSec: 900 }]);
    await this.limit(`${tenant.tenantId}:act-req:id:${id.value}`, [{ limit: 3, windowSec: 900 }]);

    const code = newOneTimeCode();
    const email = await this.shards.tx(tenant.shardId, tenant.tenantId, async (tx) => {
      const user = await tx.userAccount.findFirst({
        where: id.kind === 'email' ? { email: id.value } : { username: id.value },
      });
      if (!user || user.status !== 'PENDING_ACTIVATION' || !user.email) return null;
      const now = new Date();
      // Only the newest code is valid.
      await tx.oneTimeToken.updateMany({
        where: { userId: user.id, purpose: 'ACTIVATION', usedAt: null },
        data: { usedAt: now },
      });
      await tx.oneTimeToken.create({
        data: {
          tenantId: tenant.tenantId,
          userId: user.id,
          purpose: 'ACTIVATION',
          channel: 'EMAIL',
          tokenHash: hashOneTimeCode(this.config.SESSION_PEPPER, user.id, 'ACTIVATION', code),
          expiresAt: new Date(now.getTime() + ACTIVATION_TTL_MS),
        },
      });
      return user.email;
    });

    if (email) {
      await this.mailer.send({
        to: email,
        subject: `${tenant.shortName}: your UniVarse activation code`,
        text: `Your activation code is ${code}. It expires in 15 minutes.\n\nIf you did not request this, ignore this email.`,
      });
    }
  }

  /** Step 2: verify code, set password, activate. */
  async confirmActivation(
    tenant: TenantContext,
    input: { username: string; code: string; password: string },
    ip: string,
  ): Promise<void> {
    const id = normaliseIdentifier(input.username);
    await this.limit(`${tenant.tenantId}:act-confirm:ip:${ip}`, [{ limit: 30, windowSec: 900 }]);

    await this.shards.tx(tenant.shardId, tenant.tenantId, async (tx) => {
      const now = new Date();
      const user = await tx.userAccount.findFirst({
        where: id.kind === 'email' ? { email: id.value } : { username: id.value },
        include: { roleAssignments: { include: { role: true } } },
      });
      if (!user || user.status !== 'PENDING_ACTIVATION') throw invalidActivation();
      const token = await tx.oneTimeToken.findFirst({
        where: { userId: user.id, purpose: 'ACTIVATION', usedAt: null, expiresAt: { gt: now } },
        orderBy: { createdAt: 'desc' },
      });
      if (!token || token.attempts >= MAX_CODE_ATTEMPTS) throw invalidActivation();

      const expected = hashOneTimeCode(this.config.SESSION_PEPPER, user.id, 'ACTIVATION', input.code);
      if (!safeEqual(expected, token.tokenHash)) {
        await tx.oneTimeToken.update({ where: { id: token.id }, data: { attempts: { increment: 1 } } });
        return 'WRONG_CODE' as const;
      }

      const isStaff = user.roleAssignments.some((a) => a.role.key !== 'STUDENT' && a.role.key !== 'APPLICANT');
      const problems = passwordProblems(input.password, {
        minLength: isStaff ? 12 : 8,
        context: [user.username, user.displayName, user.email ?? '', tenant.shortName, tenant.slug],
      });
      if (problems.length > 0) {
        throw Object.assign(new ProblemError(422, 'auth.password_rejected', 'Password does not meet the policy'), {
          errors: problems.map((p) => ({ path: 'password', code: p, message: p.replaceAll('_', ' ') })),
        });
      }

      await tx.userAccount.update({
        where: { id: user.id },
        data: { passwordHash: await hashPassword(input.password), status: 'ACTIVE', failedLoginCount: 0 },
      });
      await tx.oneTimeToken.update({ where: { id: token.id }, data: { usedAt: now } });
      return 'OK' as const;
    }).then((outcome) => {
      // Attempt counter must persist, so the wrong-code error is thrown after commit.
      if (outcome === 'WRONG_CODE') throw invalidActivation();
    });
  }

  async login(
    tenant: TenantContext,
    input: { username: string; password: string },
    meta: SessionMeta,
  ): Promise<{ token: string; maxAgeSec: number; user: { id: string; username: string; displayName: string } }> {
    const id = normaliseIdentifier(input.username);
    await this.limit(`${tenant.tenantId}:login:ip:${meta.ip}`, [{ limit: 50, windowSec: 60 }]);
    await this.limit(`${tenant.tenantId}:login:ipid:${meta.ip}:${id.value}`, [
      { limit: 5, windowSec: 60 },
      { limit: 20, windowSec: 3600 },
    ]);

    const db = await this.shards.forTenant(tenant.shardId, tenant.tenantId);
    const user = await db.userAccount.findFirst({ where: id.kind === 'email' ? { email: id.value } : { username: id.value } });
    const now = new Date();

    if (!user?.passwordHash || user.status !== 'ACTIVE') {
      await verifyAgainstDummy(input.password);
      throw invalidCredentials();
    }
    if (user.lockedUntil && user.lockedUntil > now) {
      await verifyAgainstDummy(input.password);
      throw invalidCredentials();
    }

    if (!(await verifyPassword(input.password, user.passwordHash))) {
      // Atomic increment: parallel guesses can't under-count.
      const { failedLoginCount } = await db.userAccount.update({
        where: { id: user.id },
        data: { failedLoginCount: { increment: 1 } },
        select: { failedLoginCount: true },
      });
      if (failedLoginCount >= LOCK_AFTER_FAILURES) {
        await db.userAccount.update({
          where: { id: user.id },
          data: { failedLoginCount: 0, lockedUntil: new Date(now.getTime() + LOCK_MS) },
        });
        this.logger.warn(`Account locked after repeated failures tenant=${tenant.slug} user=${user.id}`);
      }
      throw invalidCredentials();
    }

    await db.userAccount.update({
      where: { id: user.id },
      data: {
        failedLoginCount: 0,
        lockedUntil: null,
        lastLoginAt: now,
        ...(needsRehash(user.passwordHash) ? { passwordHash: await hashPassword(input.password) } : {}),
      },
    });
    const { token, maxAgeSec } = await this.sessions.create(tenant, user.id, meta);
    return { token, maxAgeSec, user: { id: user.id, username: user.username, displayName: user.displayName } };
  }
}
