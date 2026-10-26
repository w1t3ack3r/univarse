// Spec 0020 D6, B-9: where backups go, and the paths a backup's private key must never be written to (D5, BK9).
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { writeOwnerOnly } from '../../../../packages/db/scripts/pgbouncer-config.js';
import { REPO, STACK_DIR } from '../config.js';

export const DEFAULT_DESTINATION = join(homedir(), '.univarse', 'backups');
export const PUBLIC_KEY_FILE = join(REPO, 'infra', 'backup', 'backup.pub');
const settingsFile = (dir = STACK_DIR) => join(dir, 'backup.json');

export interface BackupSettings {
  readonly destination: string;
}

/** The configured destination, or the default; the file holds a path only, no secret. */
export function loadSettings(dir = STACK_DIR): BackupSettings {
  const f = settingsFile(dir);
  if (!existsSync(f)) return { destination: DEFAULT_DESTINATION };
  const s = JSON.parse(readFileSync(f, 'utf8')) as Partial<BackupSettings>;
  if (typeof s.destination !== 'string' || !isAbsolute(s.destination)) throw new Error(`${f}: destination must be an absolute path`);
  // Normalised on reading too, so a path saved before saving normalised it (`D:\\univarse-backups`) reads as one.
  return { destination: resolve(s.destination) };
}

/** Saved normalised: a doubled separator (a shell's escaping, say) or a trailing one never reaches the file. */
export function saveSettings(settings: BackupSettings, dir = STACK_DIR): void {
  if (!isAbsolute(settings.destination)) throw new Error('the backup destination must be an absolute path');
  writeOwnerOnly(settingsFile(dir), `${JSON.stringify({ ...settings, destination: resolve(settings.destination) }, null, 2)}\n`);
}

/**
 * The path as the file system knows it: the nearest existing ancestor resolved through links (so a link into the stack
 * directory is caught), with the rest appended. On Windows, compared case-insensitively.
 */
export function canonical(p: string, platform: NodeJS.Platform = process.platform): string {
  let head = resolve(p);
  const rest: string[] = [];
  for (;;) {
    try {
      head = realpathSync.native(head);
      break;
    } catch {
      const up = dirname(head);
      if (up === head) break;
      rest.unshift(head.slice(up.length).replace(/^[\\/]/, ''));
      head = up;
    }
  }
  const full = rest.length ? join(head, ...rest) : head;
  return platform === 'win32' ? full.toLowerCase() : full;
}

/** True when `p` is `root` or inside it. */
export function within(p: string, root: string, platform: NodeJS.Platform = process.platform): boolean {
  const r = relative(canonical(root, platform), canonical(p, platform));
  return r === '' || (!r.startsWith('..') && !isAbsolute(r));
}

/**
 * BK9: why the private key may not go to `target`, or null. Never inside the stack directory, the repository, a ledger
 * destination or the backup destination: a stolen stack, checkout, ledger copy or set must not carry its own key.
 */
export function keyPathProblem(target: string, forbidden: readonly { readonly what: string; readonly path: string }[], platform: NodeJS.Platform = process.platform): string | null {
  if (!isAbsolute(target)) return 'give an absolute path for the private key';
  for (const f of forbidden) if (within(target, f.path, platform)) return `the private key may not be written inside ${f.what} (${f.path}): keep it offline, with the owner (spec 0020 D5)`;
  return null;
}
