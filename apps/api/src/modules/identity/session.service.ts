import { Injectable, Logger } from '@nestjs/common';
import { isPermission } from '@univarse/contracts';
import type { TenantTx } from '@univarse/db';
import { ShardRegistry } from '../../shared/db/db.module.js';
import type { TenantContext } from '../../shared/tenancy/tenant-resolver.service.js';
import { SESSION_LIFETIMES, sessionClassFor, type Actor, type Grant, type SessionClass } from './actor.js';
import { newSessionToken, sha256 } from './tokens.js';

export const SESSION_COOKIE = '__Host-uv_sid';
const MAX_ACTIVE_SESSIONS = 5;
/** Don't write last_seen on every request; 60s granularity is enough for idle timeouts. */
const TOUCH_INTERVAL_MS = 60_000;

export interface SessionMeta {
  readonly ip: string;
  readonly userAgent: string | undefined;
}

@Injectable()
export class SessionService {
  private readonly logger = new Logger('Sessions');

  constructor(private readonly shards: ShardRegistry) {}

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
  async create(tenant: TenantContext, userId: string, meta: SessionMeta): Promise<{ token: string; maxAgeSec: number }> {
    const token = newSessionToken();
    const now = new Date();
    const maxAgeSec = await this.shards.tx(tenant.shardId, tenant.tenantId, async (tx) => {
      const { grants, roleKeys } = await this.loadGrants(tx, userId, now);
      const life = SESSION_LIFETIMES[sessionClassFor(roleKeys, grants)];
      await tx.session.create({
        data: {
          tenantId: tenant.tenantId,
          userId,
          tokenHash: sha256(token),
          idleExpiresAt: new Date(now.getTime() + life.idleMin * 60_000),
          absoluteExpiresAt: new Date(now.getTime() + life.absoluteHours * 3_600_000),
          ip: meta.ip,
          userAgent: meta.userAgent?.slice(0, 512) ?? null,
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
      return life.absoluteHours * 3600;
    });
    return { token, maxAgeSec };
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
        grants,
      };
    });
  }

  async revoke(tenant: TenantContext, sessionId: string, reason: string): Promise<void> {
    const db = await this.shards.forTenant(tenant.shardId, tenant.tenantId);
    await db.session.updateMany({ where: { id: sessionId, revokedAt: null }, data: { revokedAt: new Date(), revokeReason: reason } });
  }
}

export function sessionCookie(token: string, maxAgeSec: number): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSec}`;
}

export const clearedSessionCookie = (): string => `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

export function readSessionCookie(header: string | undefined): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === SESSION_COOKIE) {
      const value = rest.join('=');
      return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
    }
  }
  return null;
}
