import { Injectable, Logger } from '@nestjs/common';
import { isPermission } from '@univarse/contracts';
import type { TenantTx } from '@univarse/db';
import { AuditWriter } from '../../shared/audit/audit-writer.js';
import { ShardRegistry } from '../../shared/db/db.module.js';
import { ProblemError } from '../../shared/errors/problem.js';
import type { TenantContext } from '../../shared/tenancy/tenant-resolver.service.js';
import { SESSION_LIFETIMES, sessionClassFor, type Actor, type Grant, type SessionClass } from './actor.js';
import { newSessionToken, sha256 } from './tokens.js';

export const SESSION_COOKIE = '__Host-uv_sid';
/** MFA login challenge (spec 0001 M4): 5 minutes, grants nothing except /auth/mfa/verify. */
export const CHALLENGE_COOKIE = '__Host-uv_mfa';
const MAX_ACTIVE_SESSIONS = 5;
/** Don't write last_seen on every request; 60s granularity is enough for idle timeouts. */
const TOUCH_INTERVAL_MS = 60_000;

export interface SessionFlags {
  mfaAt?: Date | null;
  restricted?: boolean;
  stepUpAt?: Date | null;
}

export interface SessionMeta {
  readonly ip: string;
  readonly userAgent: string | undefined;
  /** Correlates audit events with request logs (spec 0002 A7). */
  readonly requestId?: string;
}

@Injectable()
export class SessionService {
  private readonly logger = new Logger('Sessions');

  constructor(
    private readonly shards: ShardRegistry,
    private readonly audit: AuditWriter,
  ) {}

  /** Audit fields shared by session-related events. */
  static auditMeta(meta: SessionMeta | undefined) {
    return { ip: meta?.ip ?? null, userAgent: meta?.userAgent ?? null, requestId: meta?.requestId ?? null };
  }

  /** Grants currently in force for a user (role assignments within their validity window). */
  async loadGrants(tx: TenantTx, userId: string, now = new Date()): Promise<{ grants: Grant[]; roleKeys: string[] }> {
    const assignments = await tx.roleAssignment.findMany({
      where: {
        userId,
        revokedAt: null,
        validFrom: { lte: now },
        OR: [{ validTo: null }, { validTo: { gt: now } }],
      },
      include: { role: true },
    });
    const grants = assignments.flatMap((a) =>
      a.role.permissions.filter(isPermission).map((permission) => ({
        permission,
        scopeType: a.scopeType,
        scopeId: a.scopeId,
        roleKey: a.role.key,
      })),
    );
    return { grants, roleKeys: assignments.map((a) => a.role.key) };
  }

  /** Creates a session (new token every login ⇒ no session fixation) and trims old ones. */
  async create(
    tenant: TenantContext,
    userId: string,
    meta: SessionMeta,
    opts: SessionFlags = {},
    /** If set, an audit event with this action is written in the same transaction (spec 0002 A1/A7). */
    auditAction?: string,
  ): Promise<{ token: string; maxAgeSec: number }> {
    return this.shards.tx(tenant.shardId, tenant.tenantId, async (tx) => {
      const created = await this.insert(tx, tenant.tenantId, userId, meta, opts);
      if (auditAction) {
        await this.audit.write(tx, tenant.tenantId, {
          actorType: 'USER',
          actorId: userId,
          action: auditAction,
          entityType: 'session',
          entityId: created.sessionId,
          after: { mfa: opts.mfaAt != null, restricted: opts.restricted ?? false },
          ...SessionService.auditMeta(meta),
        });
      }
      return { token: created.token, maxAgeSec: created.maxAgeSec };
    });
  }

  /** Inserts a session inside the caller's transaction. Flags are set explicitly, never copied. */
  private async insert(
    tx: TenantTx,
    tenantId: string,
    userId: string,
    meta: SessionMeta,
    opts: SessionFlags,
  ): Promise<{ token: string; maxAgeSec: number; sessionId: string }> {
    const token = newSessionToken();
    const now = new Date();
    const { grants, roleKeys } = await this.loadGrants(tx, userId, now);
    const life = SESSION_LIFETIMES[sessionClassFor(roleKeys, grants)];
    const { id: sessionId } = await tx.session.create({
      select: { id: true },
      data: {
        tenantId,
        userId,
        tokenHash: sha256(token),
        idleExpiresAt: new Date(now.getTime() + life.idleMin * 60_000),
        absoluteExpiresAt: new Date(now.getTime() + life.absoluteHours * 3_600_000),
        ip: meta.ip,
        userAgent: meta.userAgent?.slice(0, 512) ?? null,
        mfaAt: opts.mfaAt ?? null,
        restricted: opts.restricted ?? false,
        stepUpAt: opts.stepUpAt ?? null,
      },
    });
    const active = await tx.session.findMany({
      where: { userId, revokedAt: null, absoluteExpiresAt: { gt: now } },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    const excess = active.slice(MAX_ACTIVE_SESSIONS).map((s) => s.id);
    if (excess.length > 0) {
      await tx.session.updateMany({ where: { id: { in: excess } }, data: { revokedAt: now, revokeReason: 'max_sessions' } });
    }
    return { token, maxAgeSec: life.absoluteHours * 3600, sessionId };
  }

  /**
   * Resolves a session token to an Actor for THIS tenant. The lookup runs under the tenant's RLS
   * context, so a token issued by another institution is simply not found (membership check).
   */
  async authenticate(tenant: TenantContext, token: string, requestId: string): Promise<Actor | null> {
    const now = new Date();
    return this.shards.tx(tenant.shardId, tenant.tenantId, async (tx) => {
      const session = await tx.session.findUnique({
        where: { tenantId_tokenHash: { tenantId: tenant.tenantId, tokenHash: sha256(token) } },
        include: { user: true },
      });
      if (!session) {
        // Unknown, forged, or another tenant's token. Security signal — never log the token.
        this.logger.warn(`Invalid session token presented tenant=${tenant.slug} requestId=${requestId}`);
        return null;
      }
      const expired = session.idleExpiresAt <= now || session.absoluteExpiresAt <= now;
      if (session.revokedAt || expired || session.user.status !== 'ACTIVE') return null;

      const { grants, roleKeys } = await this.loadGrants(tx, session.userId, now);
      if (now.getTime() - session.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
        const life = SESSION_LIFETIMES[sessionClassFor(roleKeys, grants) satisfies SessionClass];
        const idle = new Date(Math.min(now.getTime() + life.idleMin * 60_000, session.absoluteExpiresAt.getTime()));
        await tx.session.update({ where: { id: session.id }, data: { lastSeenAt: now, idleExpiresAt: idle } });
      }
      return {
        tenantId: tenant.tenantId,
        userId: session.userId,
        sessionId: session.id,
        username: session.user.username,
        displayName: session.user.displayName,
        mfaAt: session.mfaAt,
        restricted: session.restricted,
        stepUpAt: session.stepUpAt,
        grants,
      };
    });
  }

  /**
   * Revokes the current session and issues a new token with new flags, inside the CALLER's
   * transaction (S3, S6, M9d) so the credential check, the revoke and the new session commit or
   * roll back together. The revoke is conditional: if the session was revoked or expired meanwhile
   * (logout, password reset, a disable on another device, a parallel rotation) this throws and the
   * transaction rolls back, so a dead session can never be resurrected as an elevated one.
   */
  async rotate(
    tx: TenantTx,
    tenantId: string,
    current: { sessionId: string; userId: string },
    meta: SessionMeta,
    reason: string,
    flags: SessionFlags,
  ): Promise<{ token: string; maxAgeSec: number }> {
    await this.assertLive(tx, current.sessionId, reason);
    return this.insert(tx, tenantId, current.userId, meta, flags);
  }

  /**
   * Atomically retires the current session if it is still live; otherwise throws 401 so the
   * caller's transaction rolls back. Pass `reason = null` to only lock and check it.
   */
  async assertLive(tx: TenantTx, sessionId: string, reason: string | null): Promise<void> {
    const now = new Date();
    const live = { id: sessionId, revokedAt: null, idleExpiresAt: { gt: now }, absoluteExpiresAt: { gt: now } };
    const n =
      reason === null
        ? await tx.session.updateMany({ where: live, data: { lastSeenAt: now } }) // row lock + liveness check
        : await tx.session.updateMany({ where: live, data: { revokedAt: now, revokeReason: reason } });
    if (n.count !== 1) throw new ProblemError(401, 'auth.unauthenticated', 'Authentication required');
  }

  async revoke(
    tenant: TenantContext,
    sessionId: string,
    reason: string,
    audit?: { actorId: string; action: string; meta?: SessionMeta },
  ): Promise<void> {
    await this.shards.tx(tenant.shardId, tenant.tenantId, async (tx) => {
      const revoked = await tx.session.updateMany({
        where: { id: sessionId, revokedAt: null },
        data: { revokedAt: new Date(), revokeReason: reason },
      });
      if (audit && revoked.count === 1) {
        await this.audit.write(tx, tenant.tenantId, {
          actorType: 'USER',
          actorId: audit.actorId,
          action: audit.action,
          entityType: 'session',
          entityId: sessionId,
          reason,
          ...SessionService.auditMeta(audit.meta),
        });
      }
    });
  }
}

export function sessionCookie(token: string, maxAgeSec: number): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSec}`;
}

export const clearedSessionCookie = (): string => `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

export const challengeCookie = (token: string): string =>
  `${CHALLENGE_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=300`;
export const clearedChallengeCookie = (): string => `${CHALLENGE_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

export function readSessionCookie(header: string | undefined, cookieName: string = SESSION_COOKIE): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === cookieName) {
      const value = rest.join('=');
      return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
    }
  }
  return null;
}
