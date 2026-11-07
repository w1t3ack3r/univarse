// Spec 0032: changing a user's address, the institutions' side. The same rules as the console's (packages/domain's
// contact-change.ts), in this tenant's own table, with the addresses under its own field encryption (Q1, Q12). Whoever
// can change an address can take the account over, so nothing changes until the new one is proven, the old one is told
// and can undo it, and an administrator's correction also takes the person's password. A username never changes
// (Q14), so the signed-out pages find the account by it. No address reaches an audit row, a log line, a URL or an error.
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { FieldCrypto } from '@univarse/crypto';
import type { TenantTx } from '@univarse/db';
import { CONTACT_CODE_MAX_ATTEMPTS, CONTACT_CODE_TTL_MS, mayMarkOldAddressWrong, maskAddress, needsPassword, undoDeadline, withinRequestLimit, type ContactChangeKind as AnyKind } from '@univarse/domain';
import { APP_CONFIG, type AppConfig } from '../../config/config.js';
import { AuditWriter } from '../../shared/audit/audit-writer.js';
import { ShardRegistry } from '../../shared/db/db.module.js';
import { ProblemError } from '../../shared/errors/problem.js';
import { withMinimumDuration } from '../../shared/http/timing.js';
import { bucketName, securityFields } from '../../shared/observability/security.js';
import { RateLimiter } from '../../shared/infra/rate-limiter.js';
import { Outbox } from '../../shared/outbox/outbox.js';
import type { TenantContext } from '../../shared/tenancy/tenant-resolver.service.js';
import type { Actor } from './actor.js';
import { OneTimeCodeService } from './one-time-code.service.js';
import { verifyAgainstDummy, verifyPassword } from './password.js';
import { hashOneTimeCode, newOneTimeCode, normaliseIdentifier, safeEqual } from './tokens.js';
import { base32Encode } from './totp.js';

const HOUR_MS = 3_600_000;
/** The owner's command is the console's alone (Q10). */
type ContactChangeKind = Exclude<AnyKind, 'COMMAND'>;
/** Above the slowest path, so a taken address and a free one take the same time (Q4), as login's and reset's floors. */
const FLOOR_MS = 400;
/** Signed-out confirm and undo: per address, as the reset's confirm is. */
const PUBLIC_LIMIT = [{ limit: 30, windowSec: 900 }];

const invalidCode = () => new ProblemError(400, 'contact.code_invalid', 'Invalid or expired code');
const invalidUndo = () => new ProblemError(400, 'contact.undo_invalid', 'Invalid or expired undo code');
const tooMany = () => Object.assign(new ProblemError(429, 'contact.too_many', 'Too many address changes. Try again in an hour.'), { retryAfterSec: 3600 });
const sameAddress = () => new ProblemError(422, 'contact.same_address', 'That is already the address on this account');
const notFound = () => new ProblemError(404, 'resource.not_found', 'Not found');

/** Binds a ciphertext to its tenant, row and side: an address copied onto another row won't decrypt. */
export const contactAad = (tenantId: string, id: string, side: 'new' | 'old') => `${tenantId}:contact_change:${id}:${side}`;

/** "ABCDE-FGHJK": an undo lives 72 hours and works signed out, so it's longer than a code. Q-A2. */
const newUndoCode = () => {
  const s = base32Encode(randomBytes(7)).slice(0, 10);
  return `${s.slice(0, 5)}-${s.slice(5)}`;
};
const normaliseUndo = (c: string) => c.toUpperCase().replace(/[^A-Z2-7]/g, '');

export interface ContactMeta {
  readonly ip: string;
  readonly userAgent?: string | undefined;
  readonly requestId?: string | undefined;
}

interface PendingRow {
  id: string;
  userId: string;
  kind: ContactChangeKind;
  newAddressEnc: string | null;
  newAddressHash: Uint8Array | null;
  oldAddressWrong: boolean;
  codeHash: Uint8Array | null;
}

@Injectable()
export class ContactService {
  private readonly logger = new Logger('Contact');

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly shards: ShardRegistry,
    private readonly fieldCrypto: FieldCrypto,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
    private readonly codes: OneTimeCodeService,
    private readonly limiter: RateLimiter,
  ) {}

  private addressHash(tenantId: string, address: string): Uint8Array<ArrayBuffer> {
    return new Uint8Array(createHmac('sha256', this.config.SESSION_PEPPER).update(`${tenantId}:contact:${address}`).digest());
  }

  private codeHash(userId: string, address: string, code: string): Uint8Array<ArrayBuffer> {
    return hashOneTimeCode(this.config.SESSION_PEPPER, userId, `contact:${address}`, code);
  }

  private undoHash(userId: string, changeId: string, code: string): Uint8Array<ArrayBuffer> {
    return hashOneTimeCode(this.config.SESSION_PEPPER, userId, `contact-undo:${changeId}`, normaliseUndo(code));
  }

  /** Serialises this institution's address changes: two people can't race for one address. */
  private lock(tx: TenantTx, tenantId: string) {
    return tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`contact:${tenantId}`}, 0))`;
  }

  private async limitPublic(tenant: TenantContext, what: string, ip: string): Promise<void> {
    const key = `${tenant.tenantId}:contact-${what}:ip:${ip}`;
    const r = await this.limiter.hit(key, PUBLIC_LIMIT);
    if (r.allowed) return;
    this.logger.warn(securityFields('auth.rate_limited', { bucket: bucketName(key), retryAfterSec: r.retryAfterSec }), 'Rate limit exceeded');
    throw Object.assign(new ProblemError(429, 'request.rate_limited', 'Too many attempts. Try again later.'), { retryAfterSec: r.retryAfterSec });
  }

  /** In use by someone else, or held for the 72 hours an undo may need it back (Q6). */
  private async addressTaken(tx: TenantTx, tenantId: string, address: string, userId: string): Promise<boolean> {
    if (await tx.userAccount.findFirst({ where: { email: address, id: { not: userId } }, select: { id: true } })) return true;
    const held = await tx.contactChange.findFirst({ where: { oldAddressHash: this.addressHash(tenantId, address), status: 'CONFIRMED', undoUntil: { gt: new Date() }, userId: { not: userId } }, select: { id: true } });
    return held !== null;
  }

  /** One pending per account (Q3). A taken address gets a notice, and a code it never receives (Q4). */
  private async open(tx: TenantTx, tenant: TenantContext, change: { user: { id: string; username: string }; newAddress: string; kind: ContactChangeKind; requestedBy: string; oldAddressWrong: boolean }, meta: ContactMeta): Promise<void> {
    const { user, newAddress, kind } = change;
    const { tenantId } = tenant;
    const hash = this.addressHash(tenantId, newAddress);
    const since = new Date(Date.now() - HOUR_MS);
    const [mine, theirs] = await Promise.all([tx.contactChange.count({ where: { userId: user.id, createdAt: { gt: since } } }), tx.contactChange.count({ where: { newAddressHash: hash, createdAt: { gt: since } } })]);
    if (!withinRequestLimit(mine) || !withinRequestLimit(theirs)) throw tooMany();
    await tx.contactChange.updateMany({ where: { userId: user.id, status: 'PENDING' }, data: { status: 'REPLACED', codeHash: null } });
    const taken = await this.addressTaken(tx, tenantId, newAddress, user.id);
    const id = randomUUID();
    const code = newOneTimeCode();
    const oldAddressWrong = mayMarkOldAddressWrong(kind) && change.oldAddressWrong;
    await tx.contactChange.create({
      data: {
        id,
        tenantId,
        userId: user.id,
        kind,
        requestedBy: change.requestedBy,
        newAddressEnc: await this.fieldCrypto.encrypt(tenantId, Buffer.from(newAddress, 'utf8'), contactAad(tenantId, id, 'new')),
        newAddressHash: hash,
        oldAddressWrong,
        codeHash: this.codeHash(user.id, newAddress, code),
        expiresAt: new Date(Date.now() + CONTACT_CODE_TTL_MS),
      },
    });
    await this.audit.write(tx, tenantId, { actorType: 'USER', actorId: change.requestedBy, action: 'identity.email_change.requested', entityType: 'user_account', entityId: user.id, after: { changeId: id, kind, oldAddressWrong }, ip: meta.ip, userAgent: meta.userAgent ?? null, requestId: meta.requestId ?? null });
    await this.outbox.enqueueEmail(
      tx,
      tenantId,
      taken
        ? { to: newAddress, subject: `${tenant.shortName}: someone tried to use this address`, text: `Someone tried to move a UniVarse account at ${tenant.shortName} to this address, which is already in use. Nothing has changed, and you don't need to do anything.` }
        : {
            to: newAddress,
            subject: `${tenant.shortName}: confirm your new address`,
            text:
              kind === 'SELF'
                ? `Your code to confirm this address is ${code}. It expires in 15 minutes. Enter it in Your account in UniVarse.\n\nIf you did not ask for this, ignore this email.`
                : `Your address at ${tenant.shortName} is being corrected to this one. Your code is ${code}. It expires in 15 minutes. Open UniVarse, choose "Confirm a new address", and enter your matric or staff number, the code and your password.\n\nIf you did not expect this, ignore this email.`,
          },
    );
  }

  private pendingFor(tx: TenantTx, userId: string, kind?: ContactChangeKind) {
    return tx.contactChange.findFirst({ where: { userId, status: 'PENDING', expiresAt: { gt: new Date() }, ...(kind ? { kind } : {}) }, orderBy: { createdAt: 'desc' } });
  }

  /** The change a user has waiting, so the page can pick up after a reload. */
  async status(tenant: TenantContext, actor: Actor): Promise<{ address: string | null; pending: { address: string; expiresAt: string } | null }> {
    const { row, address } = await this.shards.tx(tenant.shardId, tenant.tenantId, async (tx) => ({
      row: await this.pendingFor(tx, actor.userId, 'SELF'),
      address: (await tx.userAccount.findUniqueOrThrow({ where: { id: actor.userId }, select: { email: true } })).email,
    }));
    if (!row?.newAddressEnc) return { address, pending: null };
    const pending = (await this.fieldCrypto.decrypt(tenant.tenantId, row.newAddressEnc, contactAad(tenant.tenantId, row.id, 'new'))).toString('utf8');
    return { address, pending: { address: pending, expiresAt: row.expiresAt.toISOString() } };
  }

  /** Q2: the guard has required a step-up. The same answer, in the same time, whatever the address (Q4). */
  requestOwn(tenant: TenantContext, actor: Actor, newAddress: string, meta: ContactMeta): Promise<void> {
    return withMinimumDuration(FLOOR_MS, () =>
      this.shards.tx(tenant.shardId, tenant.tenantId, async (tx) => {
        await this.lock(tx, tenant.tenantId);
        const user = await tx.userAccount.findUniqueOrThrow({ where: { id: actor.userId } });
        if (user.email === newAddress) throw sameAddress();
        await this.open(tx, tenant, { user, newAddress, kind: 'SELF', requestedBy: actor.userId, oldAddressWrong: false }, meta);
      }),
    );
  }

  private async spendAttempt(tx: TenantTx, id: string, now: Date): Promise<boolean> {
    const n = await tx.contactChange.updateMany({ where: { id, status: 'PENDING', expiresAt: { gt: now }, attempts: { lt: CONTACT_CODE_MAX_ATTEMPTS } }, data: { attempts: { increment: 1 } } });
    return n.count === 1;
  }

  private async addressOf(tenantId: string, row: PendingRow): Promise<string | null> {
    if (!row.newAddressEnc) return null;
    return (await this.fieldCrypto.decrypt(tenantId, row.newAddressEnc, contactAad(tenantId, row.id, 'new'))).toString('utf8');
  }

  private codeMatches(row: PendingRow, address: string | null, code: string): boolean {
    return address !== null && row.codeHash !== null && safeEqual(this.codeHash(row.userId, address, code), row.codeHash);
  }

  /** Q2, Q5: a code for this account's pending change. This session stays; every other ends. */
  async confirmOwn(tenant: TenantContext, actor: Actor, code: string, meta: ContactMeta): Promise<void> {
    const done = await this.shards.tx(tenant.shardId, tenant.tenantId, async (tx) => {
      await this.lock(tx, tenant.tenantId);
      const now = new Date();
      const row = await this.pendingFor(tx, actor.userId, 'SELF');
      if (!row || !(await this.spendAttempt(tx, row.id, now))) return false;
      const address = await this.addressOf(tenant.tenantId, row);
      if (!this.codeMatches(row, address, code) || !address) return false;
      return this.complete(tx, tenant, row, address, actor.sessionId, meta);
    });
    if (!done) throw invalidCode();
  }

  /**
   * Q7: signed out, because the person may have lost their old mailbox. The code and their password, both; either wrong
   * spends an attempt and answers alike. Failures don't count toward the sign-in lockout (Q-A8 on the console's side):
   * its mail goes to an address that may be a stranger's. Each change allows five.
   */
  async confirmCorrection(tenant: TenantContext, input: { username: string; code: string; password: string }, meta: ContactMeta): Promise<void> {
    await this.limitPublic(tenant, 'confirm', meta.ip);
    await withMinimumDuration(FLOOR_MS, async () => {
      const db = await this.shards.forTenant(tenant.shardId, tenant.tenantId);
      const id = normaliseIdentifier(input.username);
      const user = await db.userAccount.findFirst({ where: id.kind === 'email' ? { email: id.value } : { username: id.value } });
      const now = new Date();
      const row = user ? await this.shards.tx(tenant.shardId, tenant.tenantId, (tx) => this.pendingFor(tx, user.id)) : null;
      if (!user?.passwordHash || !row || !needsPassword(row.kind) || user.status !== 'ACTIVE' || user.passwordResetRequired || (user.lockedUntil && user.lockedUntil > now)) {
        await verifyAgainstDummy(input.password);
        throw invalidCode();
      }
      const passwordOk = await verifyPassword(input.password, user.passwordHash);
      const done = await this.shards.tx(tenant.shardId, tenant.tenantId, async (tx) => {
        await this.lock(tx, tenant.tenantId);
        if (!(await this.spendAttempt(tx, row.id, now))) return false;
        const address = await this.addressOf(tenant.tenantId, row);
        if (!passwordOk || !address || !this.codeMatches(row, address, input.code)) return false;
        return this.complete(tx, tenant, row, address, null, meta);
      });
      if (!done) throw invalidCode();
    });
  }

  /** Q5: one transaction. Returns false, changing nothing, if the address was taken after the code went out. */
  private async complete(tx: TenantTx, tenant: TenantContext, row: PendingRow, address: string, keepSession: string | null, meta: ContactMeta): Promise<boolean> {
    const { tenantId } = tenant;
    if (await this.addressTaken(tx, tenantId, address, row.userId)) return false;
    const user = await tx.userAccount.findUniqueOrThrow({ where: { id: row.userId } });
    const now = new Date();
    const old = user.email;
    const undoCode = old && !row.oldAddressWrong ? newUndoCode() : null;
    await tx.userAccount.update({ where: { id: user.id }, data: { email: address, emailVerifiedAt: now } });
    await tx.contactChange.update({
      where: { id: row.id },
      data: {
        status: 'CONFIRMED',
        oldAddressEnc: old ? await this.fieldCrypto.encrypt(tenantId, Buffer.from(old, 'utf8'), contactAad(tenantId, row.id, 'old')) : null,
        oldAddressHash: old ? this.addressHash(tenantId, old) : null,
        confirmedAt: now,
        codeHash: null,
        undoHash: undoCode ? this.undoHash(user.id, row.id, undoCode) : null,
        undoUntil: undoCode ? undoDeadline(now) : null,
      },
    });
    // What was issued for the old address dies with it: a reset code sent there must not outlive the change.
    await tx.oneTimeToken.updateMany({ where: { userId: user.id, usedAt: null }, data: { usedAt: now } });
    const { count: sessionsEnded } = await tx.session.updateMany({ where: { userId: user.id, revokedAt: null, ...(keepSession ? { id: { not: keepSession } } : {}) }, data: { revokedAt: now, revokeReason: 'email_changed' } });
    await this.audit.write(tx, tenantId, { actorType: 'USER', actorId: row.kind === 'SELF' ? user.id : null, action: 'identity.email_change.confirmed', entityType: 'user_account', entityId: user.id, after: { changeId: row.id, kind: row.kind, oldAddressWrong: row.oldAddressWrong, sessionsEnded }, ip: meta.ip, userAgent: meta.userAgent ?? null, requestId: meta.requestId ?? null });
    await this.outbox.enqueueEmail(tx, tenantId, { to: address, subject: `${tenant.shortName}: this is now your address`, text: `This is now the address of your UniVarse account at ${tenant.shortName}. Your other sessions were signed out.\n\nIf this was not you, contact your institution’s ICT unit immediately.` });
    if (old && undoCode) {
      await this.outbox.enqueueEmail(tx, tenantId, {
        to: old,
        subject: `${tenant.shortName}: your address was changed`,
        text: `The address of your UniVarse account at ${tenant.shortName} was changed to ${maskAddress(address)}, and your other sessions were signed out.\n\nIf this wasn't you, open UniVarse and choose "Undo an address change". Your undo code is ${undoCode}. It works for 72 hours.`,
      });
    }
    return true;
  }

  /**
   * Q6: restores the old address, ends every session, and makes the password useless until a reset replaces it. Later
   * changes can't be undone after this; earlier ones still can, so someone who moved the account twice can't use their
   * own undo to close the owner's.
   */
  async undo(tenant: TenantContext, input: { username: string; code: string }, meta: ContactMeta): Promise<void> {
    await this.limitPublic(tenant, 'undo', meta.ip);
    await withMinimumDuration(FLOOR_MS, async () => {
      const { tenantId } = tenant;
      const id = normaliseIdentifier(input.username);
      const undone = await this.shards.tx(tenant.shardId, tenantId, async (tx) => {
        await this.lock(tx, tenantId);
        const user = await tx.userAccount.findFirst({ where: id.kind === 'email' ? { email: id.value } : { username: id.value } });
        if (!user) return null;
        const now = new Date();
        const rows = await tx.contactChange.findMany({ where: { userId: user.id, status: 'CONFIRMED', undoUntil: { gt: now } }, orderBy: { confirmedAt: 'desc' } });
        // Each open undo has its own code: the one that matches says which change this is. Every try spends an attempt on all.
        const open = rows.filter((r) => r.undoHash && r.undoAttempts < CONTACT_CODE_MAX_ATTEMPTS);
        if (open.length === 0) return null;
        await tx.contactChange.updateMany({ where: { id: { in: open.map((r) => r.id) } }, data: { undoAttempts: { increment: 1 } } });
        const row = open.find((r) => r.undoHash && safeEqual(this.undoHash(user.id, r.id, input.code), r.undoHash));
        if (!row?.confirmedAt || !row.oldAddressEnc) return null;
        const old = (await this.fieldCrypto.decrypt(tenantId, row.oldAddressEnc, contactAad(tenantId, row.id, 'old'))).toString('utf8');
        await tx.userAccount.update({ where: { id: user.id }, data: { email: old, emailVerifiedAt: now, passwordResetRequired: true } });
        await tx.contactChange.update({ where: { id: row.id }, data: { status: 'UNDONE', undoneAt: now, undoHash: null, undoUntil: null } });
        await tx.contactChange.updateMany({ where: { userId: user.id, confirmedAt: { gt: row.confirmedAt } }, data: { undoHash: null, undoUntil: null } });
        await tx.contactChange.updateMany({ where: { userId: user.id, status: 'PENDING' }, data: { status: 'REPLACED', codeHash: null } });
        await tx.oneTimeToken.updateMany({ where: { userId: user.id, usedAt: null }, data: { usedAt: now } });
        await tx.mfaChallenge.updateMany({ where: { userId: user.id, usedAt: null, revokedAt: null }, data: { revokedAt: now } });
        const { count: sessionsEnded } = await tx.session.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: now, revokeReason: 'email_change_undone' } });
        await this.audit.write(tx, tenantId, { actorType: 'SYSTEM', actorId: null, action: 'identity.email_change.undone', entityType: 'user_account', entityId: user.id, after: { changeId: row.id, sessionsEnded }, ip: meta.ip, userAgent: meta.userAgent ?? null, requestId: meta.requestId ?? null });
        await this.outbox.enqueueEmail(tx, tenantId, { to: old, subject: `${tenant.shortName}: your address was restored`, text: `This address is back on your UniVarse account at ${tenant.shortName}, and every session was signed out. To sign in again, choose "Forgot your password?" and set a new one. Your old password no longer works.` });
        return user.id;
      });
      if (!undone) throw invalidUndo();
      this.logger.warn(securityFields('identity.email_change.undone', { tenantId, userId: undone }), 'An address change was undone');
    });
  }

  /**
   * Q7, Q8, Q9: an administrator with a fresh step-up. Not activated yet: the address changes now, and activation
   * proves it. Active: a change the person finishes with a code and their password. An administrator can see who holds
   * an address, so unlike a user's own request this may say it's taken. Another institution's user reads as absent.
   */
  async correct(tenant: TenantContext, actor: Actor, userId: string, input: { email: string; oldAddressWrong: boolean }, meta: ContactMeta): Promise<void> {
    if (userId === actor.userId) throw new ProblemError(409, 'contact.own_account', 'Change your own address in Your account');
    const { tenantId } = tenant;
    await this.shards.tx(tenant.shardId, tenantId, async (tx) => {
      await this.lock(tx, tenantId);
      const target = await tx.userAccount.findUnique({ where: { id: userId } });
      if (!target) throw notFound();
      if (target.status !== 'ACTIVE' && target.status !== 'PENDING_ACTIVATION') throw new ProblemError(409, 'contact.member_inactive', 'Restore their access first');
      if (target.email === input.email) throw sameAddress();
      if (await this.addressTaken(tx, tenantId, input.email, target.id)) throw new ProblemError(409, 'contact.address_taken', 'That address already belongs to someone');
      if (target.status === 'ACTIVE' && target.passwordHash) {
        await this.open(tx, tenant, { user: target, newAddress: input.email, kind: 'ADMIN', requestedBy: actor.userId, oldAddressWrong: input.oldAddressWrong }, meta);
        return;
      }
      await tx.userAccount.update({ where: { id: target.id }, data: { email: input.email, emailVerifiedAt: null } });
      const code = await this.codes.issue(tx, tenantId, target.id, 'ACTIVATION');
      await this.audit.write(tx, tenantId, { actorType: 'USER', actorId: actor.userId, action: 'identity.email_change.corrected_unactivated', entityType: 'user_account', entityId: target.id, ip: meta.ip, userAgent: meta.userAgent ?? null, requestId: meta.requestId ?? null });
      await this.outbox.enqueueEmail(tx, tenantId, { to: input.email, subject: `${tenant.shortName}: your UniVarse activation code`, text: `Your address at ${tenant.shortName} was corrected. Your activation code is ${code}. It expires in 15 minutes.` });
    });
  }
}
