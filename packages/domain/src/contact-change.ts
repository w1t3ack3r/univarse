/**
 * Spec 0032: changing an account's address, the same rules for platform staff and institutions' users (Q1). An address
 * is what a password reset goes to, so whoever can change it can take the account over. Pure.
 */
export const CONTACT_CODE_TTL_MS = 15 * 60_000;
export const CONTACT_CODE_MAX_ATTEMPTS = 5;
/** Q3: per account, and the same per new address. */
export const CONTACT_REQUESTS_PER_HOUR = 3;
export const CONTACT_UNDO_WINDOW_MS = 72 * 3_600_000;
const HOUR_MS = 3_600_000;

export type ContactChangeKind = 'SELF' | 'ADMIN' | 'COMMAND';

/**
 * Q7: a change someone else started takes the person's own password too, so no administrator can take an account
 * over alone. A member changing their own has already stepped up (Q2).
 */
export const needsPassword = (kind: ContactChangeKind): boolean => kind !== 'SELF';

/** Q8: never on a member's own change: an intruder would tick it, and silence the only person who can undo. */
export const mayMarkOldAddressWrong = (kind: ContactChangeKind): boolean => kind !== 'SELF';

/** Q3: whether another request may start, given how many were made in the last hour. */
export const withinRequestLimit = (recent: number): boolean => recent < CONTACT_REQUESTS_PER_HOUR;

/** Q6: when an undo stops working. */
export const undoDeadline = (confirmedAt: Date): Date => new Date(confirmedAt.getTime() + CONTACT_UNDO_WINDOW_MS);

/**
 * Q12: the moment a change's addresses go. A confirmed one holds them for its undo window; an unconfirmed one for the
 * hour the request limit counts.
 */
export const blankAt = (change: { readonly confirmedAt: Date | null; readonly expiresAt: Date }): Date =>
  change.confirmedAt ? undoDeadline(change.confirmedAt) : new Date(change.expiresAt.getTime() + HOUR_MS);

/** Q6: `samuel@mail.example.com` as `s•••@m•••.com`: enough to recognise, too little for a stranger to learn it. */
export function maskAddress(address: string): string {
  const at = address.lastIndexOf('@');
  if (at < 1) return '•••';
  const domain = address.slice(at + 1);
  const dot = domain.lastIndexOf('.');
  const tld = dot >= 0 ? domain.slice(dot) : '';
  return `${address.charAt(0)}•••@${domain.charAt(0)}•••${tld}`;
}
