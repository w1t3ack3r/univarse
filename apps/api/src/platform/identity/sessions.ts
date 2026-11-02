// Spec 0028 Q8: console sessions. Only the token's hash is stored; 15 minutes idle and 8 hours absolute; at most 3
// live sessions per member (a fourth ends the oldest); a new token at sign-in and at every step-up. A session is
// read on every request, with its member, so a deactivation or a revocation takes effect on the next request.
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { PlatformClient } from '@univarse/db';
import { ProblemError } from '../../shared/errors/problem.js';
import { securityFields } from '../../shared/observability/security.js';
import { newSessionToken, sha256 } from '../../modules/identity/tokens.js';
import { CONSOLE_DB } from '../platform-config.js';
import { ABSOLUTE_MS, IDLE_MS, MAX_SESSIONS, type PlatformActor, type PlatformTx, type RequestMeta } from './types.js';

/** Don't write last_seen on every request: a minute's granularity is enough for a 15-minute idle limit. */
const TOUCH_INTERVAL_MS = 60_000;

export interface SessionFlags {
  readonly mfaAt: Date | null;
  readonly restricted: boolean;
  readonly stepUpAt?: Date | null;
}

const unauthenticated = () => new ProblemError(401, 'auth.unauthenticated', 'Authentication required');

@Injectable()
export class PlatformSessions {
  private readonly logger = new Logger('PlatformSessions');

  constructor(@Inject(CONSOLE_DB) private readonly db: PlatformClient) {}

  /** A new session inside the caller's transaction; flags are set explicitly, never copied. Trims to MAX_SESSIONS. */
  async create(tx: PlatformTx, userId: string, meta: RequestMeta, flags: SessionFlags): Promise<{ token: string; sessionId: string }> {
    const token = newSessionToken();
    const now = new Date();
    const { id: sessionId } = await tx.platformSession.create({
      select: { id: true },
      data: {
        userId,
        tokenHash: sha256(token),
        idleExpiresAt: new Date(now.getTime() + IDLE_MS),
        absoluteExpiresAt: new Date(now.getTime() + ABSOLUTE_MS),
        mfaAt: flags.mfaAt,
        restricted: flags.restricted,
        stepUpAt: flags.stepUpAt ?? null,
        ip: meta.ip,
        userAgent: meta.userAgent?.slice(0, 512) ?? null,
      },
    });
    const live = await tx.platformSession.findMany({
      where: { userId, revokedAt: null, idleExpiresAt: { gt: now }, absoluteExpiresAt: { gt: now } },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    const excess = live.slice(MAX_SESSIONS).map((s) => s.id);
    if (excess.length > 0) await tx.platformSession.updateMany({ where: { id: { in: excess } }, data: { revokedAt: now, revokeReason: 'max_sessions' } });
    return { token, sessionId };
  }

  /** The member behind a session token, or null: unknown, revoked, expired, or the member deactivated. */
  async authenticate(token: string, requestId: string): Promise<PlatformActor | null> {
    const now = new Date();
    const session = await this.db.platformSession.findUnique({ where: { tokenHash: sha256(token) }, include: { user: true } });
    if (!session) {
      this.logger.warn(securityFields('platform.session.invalid_token', { presentedRequestId: requestId }), 'Invalid console session token presented');
      return null;
    }
    if (session.revokedAt || session.idleExpiresAt <= now || session.absoluteExpiresAt <= now || !session.user.isActive) return null;
    if (now.getTime() - session.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
      const idle = new Date(Math.min(now.getTime() + IDLE_MS, session.absoluteExpiresAt.getTime()));
      await this.db.platformSession.updateMany({ where: { id: session.id, revokedAt: null }, data: { lastSeenAt: now, idleExpiresAt: idle } });
    }
    return {
      userId: session.userId,
      sessionId: session.id,
      email: session.user.email,
      displayName: session.user.displayName,
      role: session.user.role,
      isActive: session.user.isActive,
      mfaAt: session.mfaAt,
      restricted: session.restricted,
      stepUpAt: session.stepUpAt,
    };
  }

  /**
   * Retires the current session if it is still live, else throws 401 so the caller's transaction rolls back: a
   * session that died meanwhile is never turned into a new one.
   */
  async retire(tx: PlatformTx, sessionId: string, reason: string): Promise<void> {
    const now = new Date();
    const n = await tx.platformSession.updateMany({
      where: { id: sessionId, revokedAt: null, idleExpiresAt: { gt: now }, absoluteExpiresAt: { gt: now } },
      data: { revokedAt: now, revokeReason: reason },
    });
    if (n.count !== 1) throw unauthenticated();
  }

  /** Retires the current session and issues a new one with new flags, in the caller's transaction. */
  async rotate(tx: PlatformTx, current: PlatformActor, meta: RequestMeta, reason: string, flags: SessionFlags): Promise<{ token: string; sessionId: string }> {
    await this.retire(tx, current.sessionId, reason);
    return this.create(tx, current.userId, meta, flags);
  }

  /** Ends every live session of a member (but `except`), in the caller's transaction. Returns how many. */
  async endAll(tx: PlatformTx, userId: string, reason: string, except?: string): Promise<number> {
    const n = await tx.platformSession.updateMany({
      where: { userId, revokedAt: null, ...(except ? { id: { not: except } } : {}) },
      data: { revokedAt: new Date(), revokeReason: reason },
    });
    return n.count;
  }
}
