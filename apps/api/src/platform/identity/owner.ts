// Spec 0028 Q5, Q14 (spec 0025 A4, spec 0026 T27): the only ways an OWNER comes to exist, or is recovered, without
// another OWNER: a command the owner runs on this machine. It never takes or prints a password: it creates the member
// (or clears their password and factor), and the activation code goes by email, through the console's outbox.
import type { PlatformClient } from '@univarse/db';
import { addressTaken, openContactChange } from './contact.service.js';
import { platformAudit } from './audit.js';
import type { PlatformCredentials } from './credentials.js';
import { enqueueMail } from './mail.js';
import { activationMail, STAFF_LOCK } from './staff.service.js';

export type OwnerOutcome = { ok: true; memberId: string } | { ok: false; problem: string };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Q5: the first OWNER. Refused once any OWNER exists, active or not: every later member is invited by one. */
export async function createFirstOwner(db: PlatformClient, creds: PlatformCredentials, input: { email: string; displayName: string }): Promise<OwnerOutcome> {
  const email = input.email.trim().toLowerCase();
  const displayName = input.displayName.trim();
  if (!EMAIL.test(email) || email.length > 254) return { ok: false, problem: 'that is not an email address' };
  if (displayName.length < 2 || displayName.length > 80) return { ok: false, problem: 'the name must be 2 to 80 characters' };
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${STAFF_LOCK})`;
    if ((await tx.platformUser.count({ where: { role: 'OWNER' } })) > 0) return { ok: false as const, problem: 'an OWNER already exists: invite new staff from the console, or use --recover' };
    if (await tx.platformUser.findUnique({ where: { email }, select: { id: true } })) return { ok: false as const, problem: 'a member with that email already exists' };
    const { id } = await tx.platformUser.create({ data: { email, displayName, role: 'OWNER' }, select: { id: true } });
    const code = await creds.issueCode(tx, id, 'ACTIVATION');
    await platformAudit(tx, { actorId: null, action: 'platform.owner.created', metadata: { memberId: id, via: 'cli' } });
    await enqueueMail(tx, activationMail(email, code, 'You are the first owner of the UniVarse platform console.'));
    return { ok: true as const, memberId: id };
  });
}

/**
 * Spec 0032 Q10: an OWNER whose address can't be reached, and no other OWNER to correct it. On the machine, audited with
 * no actor. Activated: a code to the new address, finished with their password. Not yet: the address changes now.
 */
export async function correctOwnerEmail(db: PlatformClient, creds: PlatformCredentials, input: { email: string; newEmail: string; oldAddressWrong: boolean }): Promise<OwnerOutcome> {
  const email = input.email.trim().toLowerCase();
  const newEmail = input.newEmail.trim().toLowerCase();
  if (!EMAIL.test(newEmail) || newEmail.length > 254) return { ok: false, problem: 'the new address is not an email address' };
  if (email === newEmail) return { ok: false, problem: 'that is already the address on this account' };
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${STAFF_LOCK})`;
    const owner = await tx.platformUser.findUnique({ where: { email } });
    if (!owner || owner.role !== 'OWNER' || !owner.isActive) return { ok: false as const, problem: 'no active OWNER has that email' };
    if (await addressTaken(tx, newEmail, owner.id)) return { ok: false as const, problem: 'a member with the new address already exists' };
    if (!owner.passwordHash) {
      await tx.platformUser.update({ where: { id: owner.id }, data: { email: newEmail, emailVerifiedAt: null } });
      const code = await creds.issueCode(tx, owner.id, 'ACTIVATION');
      await platformAudit(tx, { actorId: null, action: 'platform.contact.corrected_unactivated', metadata: { memberId: owner.id, via: 'cli' } });
      await enqueueMail(tx, activationMail(newEmail, code, 'Your address on the UniVarse platform console was corrected from the command line on the platform machine.'));
      return { ok: true as const, memberId: owner.id };
    }
    await openContactChange(tx, creds, { user: owner, newAddress: newEmail, kind: 'COMMAND', requestedBy: null, oldAddressWrong: input.oldAddressWrong });
    return { ok: true as const, memberId: owner.id };
  });
}

/**
 * Q14: an OWNER who lost both the authenticator and the recovery codes. Their password and factor are cleared, every
 * session ends, the account is unlocked, and a new activation code is sent. Only for an OWNER: anyone else is reset by
 * an OWNER in the console.
 */
export async function recoverOwner(db: PlatformClient, creds: PlatformCredentials, emailInput: string): Promise<OwnerOutcome> {
  const email = emailInput.trim().toLowerCase();
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${STAFF_LOCK})`;
    const owner = await tx.platformUser.findUnique({ where: { email } });
    if (!owner || owner.role !== 'OWNER') return { ok: false as const, problem: 'no OWNER has that email' };
    await tx.platformUser.update({ where: { id: owner.id }, data: { passwordHash: null, isActive: true, failedLoginCount: 0, lockedUntil: null } });
    await creds.retireFactor(tx, owner.id);
    const ended = await tx.platformSession.updateMany({ where: { userId: owner.id, revokedAt: null }, data: { revokedAt: new Date(), revokeReason: 'owner_recovered' } });
    const code = await creds.issueCode(tx, owner.id, 'ACTIVATION');
    await platformAudit(tx, { actorId: null, action: 'platform.owner.recovered', metadata: { memberId: owner.id, via: 'cli', sessionsEnded: ended.count } });
    await enqueueMail(tx, activationMail(email, code, 'Your UniVarse console owner account was reset from the command line on the platform machine: your password and authenticator were cleared.'));
    return { ok: true as const, memberId: owner.id };
  });
}
