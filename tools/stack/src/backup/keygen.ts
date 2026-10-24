// Spec 0020 D5, B-5, BK9: `pnpm stack:backup keygen --out <path>`, once, offline. The private key file goes where the
// owner says, never inside the stack directory, the repository, a ledger destination or the backup destination; it
// is created new (never overwriting) and encrypted with UNIVARSE_BACKUP_KEY_PASSPHRASE. The public key is written to
// infra/backup/backup.pub for the owner to commit. Only the fingerprint and the two paths are printed.
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { destinationsOf } from '../ledger/chain.js';
import { generationOfRecord } from '../ledger/ledger.js';
import { readCopy } from '../ledger/store.js';
import { PRIMARY } from '../keys.js';
import { REPO, STACK_DIR } from '../config.js';
import { keyPathProblem, loadSettings, PUBLIC_KEY_FILE } from './config.js';
import { generateBackupKey } from './seal.js';

export const PASSPHRASE_VAR = 'UNIVARSE_BACKUP_KEY_PASSPHRASE';

/** Every place the private key must not go: the fixed ones, and each destination the ledger's primary names. */
export function forbiddenRoots(): { what: string; path: string }[] {
  const roots = [
    { what: 'the stack directory', path: STACK_DIR },
    { what: 'the repository', path: REPO },
    { what: "the ledger's primary destination", path: PRIMARY.path },
    { what: 'the backup destination', path: loadSettings().destination },
  ];
  // Best effort: a ledger that can't be read here still has its primary refused above.
  const at = generationOfRecord(PRIMARY);
  if (at.ok) {
    const copy = readCopy(PRIMARY, undefined, at.at);
    if (copy.state === 'ok') for (const d of destinationsOf(copy.entries)) roots.push({ what: `ledger destination ${d.id}`, path: d.path });
  }
  return roots;
}

/** Creates `path` exclusively, writes, fsyncs; mode 0600 where the OS has modes (Windows: the folder's permissions). */
export function writeNew(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, 'wx', 0o600);
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export interface KeygenResult {
  readonly ok: boolean;
  readonly lines: string[];
}

export function keygen(out: string | undefined, env: NodeJS.ProcessEnv = process.env, roots = forbiddenRoots(), publicFile = PUBLIC_KEY_FILE): KeygenResult {
  if (!out) return { ok: false, lines: ['usage: pnpm stack:backup keygen --out <absolute path for the private key, offline media>'] };
  const problem = keyPathProblem(out, roots);
  if (problem) return { ok: false, lines: [problem] };
  if (existsSync(out)) return { ok: false, lines: [`${out} exists: keygen never overwrites a key`] };
  if (existsSync(publicFile))
    return { ok: false, lines: [`${publicFile} exists: a backup key is already in place. Replacing it is a key rotation, which is not this command`] };
  const passphrase = env[PASSPHRASE_VAR];
  if (!passphrase) return { ok: false, lines: [`set ${PASSPHRASE_VAR} (at least 16 characters) first; it is never printed`] };
  const key = generateBackupKey(passphrase);
  writeNew(out, `${JSON.stringify(key.privateFile, null, 2)}\n`);
  writeNew(publicFile, key.publicPem);
  return {
    ok: true,
    lines: [
      `private key written to ${out} (encrypted with your passphrase). Keep two copies offline, as with the signing key: a lost key makes every backup unreadable.`,
      `public key written to ${publicFile}: commit it.`,
      `fingerprint sha256:${key.fingerprint}`,
    ],
  };
}
