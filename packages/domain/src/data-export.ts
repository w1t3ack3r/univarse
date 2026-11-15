// Spec 0038 Q7, Q8 (PR B): the institution's full export, as rules. Pure: the API makes the passphrase with its own
// randomness, the worker builds the archive, and these decide what's allowed, when, and what the archive's names are.

export const EXPORT_STATES = ['REQUESTED', 'BUILDING', 'READY', 'FAILED', 'EXPIRED'] as const;
export type ExportState = (typeof EXPORT_STATES)[number];

/** Q8: a ready export is kept for 7 days, then deleted. */
export const EXPORT_TTL_DAYS = 7;
/** Q7: at most one a day. */
export const EXPORT_COOLDOWN_HOURS = 24;
/** Q-B5's job: tried three times, then FAILED. */
export const EXPORT_MAX_ATTEMPTS = 3;

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** Q7: the institution statuses at which an export may be requested (and downloaded): the ones served. */
export const exportableStatus = (status: string): boolean => status === 'ACTIVE' || status === 'ONBOARDING' || status === 'OFFBOARDING';

/** Q-B5: why a new request is refused now, or null. `history` is the institution's earlier exports. */
export function exportRequestProblem(
  history: readonly { state: ExportState; requestedAt: Date }[],
  now: Date,
): 'export.in_progress' | 'export.too_soon' | null {
  if (history.some((e) => e.state === 'REQUESTED' || e.state === 'BUILDING')) return 'export.in_progress';
  const since = now.getTime() - EXPORT_COOLDOWN_HOURS * HOUR_MS;
  // A failed export doesn't count: the failure was ours, and it shouldn't cost the institution a day.
  if (history.some((e) => e.state !== 'FAILED' && e.requestedAt.getTime() > since)) return 'export.too_soon';
  return null;
}

/** When the next request is allowed after `history` (for the page), or null if it's allowed now. */
export function nextExportAllowedAt(history: readonly { state: ExportState; requestedAt: Date }[], now: Date): Date | null {
  if (exportRequestProblem(history, now) !== 'export.too_soon') return null;
  const last = Math.max(...history.filter((e) => e.state !== 'FAILED').map((e) => e.requestedAt.getTime()));
  return new Date(last + EXPORT_COOLDOWN_HOURS * HOUR_MS);
}

/** Q8: when a ready export is deleted. */
export const exportExpiresAt = (readyAt: Date): Date => new Date(readyAt.getTime() + EXPORT_TTL_DAYS * DAY_MS);

/** A ready export may be downloaded until it expires. */
export const exportDownloadable = (e: { state: ExportState; expiresAt: Date | null }, now: Date): boolean =>
  e.state === 'READY' && e.expiresAt !== null && now.getTime() < e.expiresAt.getTime();

/** Q-B4: Crockford's base-32 alphabet: no I, L, O or U, so it reads aloud and types without confusion. */
export const PASSPHRASE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const PASSPHRASE_GROUPS = 6;
export const PASSPHRASE_GROUP_LENGTH = 5;

/**
 * Q-B4: the passphrase from 30 random bytes, one character a byte's low 5 bits (32 symbols, so no bias): 150 bits,
 * in six groups of five.
 */
export function passphraseFrom(random: Uint8Array): string {
  const n = PASSPHRASE_GROUPS * PASSPHRASE_GROUP_LENGTH;
  if (random.length < n) throw new Error(`passphraseFrom needs ${String(n)} random bytes`);
  const chars = Array.from(random.subarray(0, n), (b) => PASSPHRASE_ALPHABET[b & 31] ?? '');
  const groups: string[] = [];
  for (let i = 0; i < n; i += PASSPHRASE_GROUP_LENGTH) groups.push(chars.slice(i, i + PASSPHRASE_GROUP_LENGTH).join(''));
  return groups.join('-');
}

export const PASSPHRASE_PATTERN = /^[0-9A-HJKMNP-TV-Z]{5}(?:-[0-9A-HJKMNP-TV-Z]{5}){5}$/;

/**
 * Q-B2: a file's name inside the archive, `files/{fileId}/{name}`: the uploaded name, kept readable but never a path.
 * Separators, control characters and characters Windows refuses become `_`; dots alone, or a name left empty, become
 * `file`. At most 120 characters, the extension kept.
 */
export function archiveFileName(fileId: string, originalName: string): string {
  // eslint-disable-next-line no-control-regex -- control characters are exactly what this replaces
  let name = originalName.normalize('NFC').replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '_').trim();
  name = name.replace(/^\.+/, '').replace(/[. ]+$/, '');
  if (!name || /^_+$/.test(name)) name = 'file';
  if (name.length > 120) {
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 && name.length - dot <= 10 ? name.slice(dot) : '';
    name = name.slice(0, 120 - ext.length) + ext;
  }
  if (!/^[0-9a-f-]{36}$/.test(fileId)) throw new Error('archiveFileName: not a file id');
  return `files/${fileId}/${name}`;
}
