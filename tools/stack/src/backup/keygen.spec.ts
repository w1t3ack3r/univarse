// Spec 0020 BK9: the backup private key is never written into the stack directory, the repository, a ledger destination
// or the backup destination; keygen never overwrites; nothing secret is printed.
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonical, keyPathProblem, within } from './config.js';
import { keygen, PASSPHRASE_VAR, writeNew } from './keygen.js';
import { loadPrivateKey, loadPublicKey, type PrivateKeyFile } from './seal.js';

const PASS = 'a passphrase long enough for the test';

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'uv-keygen-'));
  const dirs = { stack: join(root, 'stack'), repo: join(root, 'repo'), ledger: join(root, 'ledger'), external: join(root, 'usb', 'ledger'), backups: join(root, 'backups'), offline: join(root, 'offline') };
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
  const roots = [
    { what: 'the stack directory', path: dirs.stack },
    { what: 'the repository', path: dirs.repo },
    { what: "the ledger's primary destination", path: dirs.ledger },
    { what: 'ledger destination dest-1', path: dirs.external },
    { what: 'the backup destination', path: dirs.backups },
  ];
  return { root, dirs, roots, pub: join(dirs.repo, 'infra', 'backup', 'backup.pub') };
}

describe('keyPathProblem', () => {
  const s = sandbox();
  for (const [name, inside] of [
    ['the stack directory', join(s.dirs.stack, 'backup.key')],
    ['the repository', join(s.dirs.repo, 'infra', 'backup', 'backup.key')],
    ["the ledger's primary", join(s.dirs.ledger, 'k')],
    ['an external ledger destination', join(s.dirs.external, 'deep', 'k')],
    ['the backup destination (beside the backups)', join(s.dirs.backups, 'backup.key')],
    ['a root itself', s.dirs.backups],
  ] as const)
    it(`refuses ${name}`, () => expect(keyPathProblem(inside, s.roots)).toMatch(/may not be written inside/));

  it('refuses a path that reaches a forbidden root through a link', () => {
    const link = join(s.root, 'innocent');
    symlinkSync(s.dirs.backups, link);
    expect(keyPathProblem(join(link, 'backup.key'), s.roots)).toMatch(/the backup destination/);
  });

  it('accepts offline media, a sibling whose name only starts like a root, and refuses a relative path', () => {
    expect(keyPathProblem(join(s.dirs.offline, 'backup.key'), s.roots)).toBeNull();
    expect(keyPathProblem(`${s.dirs.backups}-offline/k`, s.roots)).toBeNull();
    expect(keyPathProblem('backup.key', s.roots)).toMatch(/absolute/);
  });

  it('compares case-insensitively on Windows only', () => {
    expect(within('/A/B/c', '/a/b', 'win32')).toBe(true);
    expect(within('/A/B/c', '/a/b', 'linux')).toBe(false);
    expect(canonical('/X/Y', 'win32')).toBe('/x/y');
  });
});

describe('keygen', () => {
  it('writes an encrypted private key offline and the public key for the repository, printing no secret', () => {
    const s = sandbox();
    const out = join(s.dirs.offline, 'univarse-backup.key');
    const r = keygen(out, { [PASSPHRASE_VAR]: PASS }, s.roots, s.pub);
    expect(r.ok).toBe(true);
    const file = JSON.parse(readFileSync(out, 'utf8')) as PrivateKeyFile;
    const priv = loadPrivateKey(file, PASS);
    const pubPem = readFileSync(s.pub, 'utf8');
    loadPublicKey(pubPem);
    const printed = r.lines.join('\n');
    expect(printed).toContain(`sha256:${file.fingerprint}`);
    const raw = priv.export({ type: 'pkcs8', format: 'der' }).subarray(-32);
    for (const secret of [PASS, file.ciphertext, raw.toString('hex'), raw.toString('base64')]) expect(printed).not.toContain(secret);
  });

  it('refuses beside the backups, and writes nothing', () => {
    const s = sandbox();
    const r = keygen(join(s.dirs.backups, 'k'), { [PASSPHRASE_VAR]: PASS }, s.roots, s.pub);
    expect(r.ok).toBe(false);
    expect(() => readFileSync(s.pub)).toThrow();
  });

  it('never overwrites a key file, nor replaces the public key', () => {
    const s = sandbox();
    const out = join(s.dirs.offline, 'k');
    writeFileSync(out, 'old');
    expect(keygen(out, { [PASSPHRASE_VAR]: PASS }, s.roots, s.pub).lines.join()).toMatch(/never overwrites/);
    expect(readFileSync(out, 'utf8')).toBe('old');
    const s2 = sandbox();
    mkdirSync(join(s2.dirs.repo, 'infra', 'backup'), { recursive: true });
    writeFileSync(s2.pub, 'existing');
    expect(keygen(join(s2.dirs.offline, 'k'), { [PASSPHRASE_VAR]: PASS }, s2.roots, s2.pub).lines.join()).toMatch(/key rotation/);
    expect(readFileSync(s2.pub, 'utf8')).toBe('existing');
  });

  it('writeNew refuses an existing file even when the check before it raced', () => {
    const s = sandbox();
    const out = join(s.dirs.offline, 'raced');
    writeFileSync(out, 'other');
    expect(() => writeNew(out, 'new')).toThrow(/EEXIST/);
    expect(readFileSync(out, 'utf8')).toBe('other');
  });

  it('refuses without a passphrase, or with a short one', () => {
    const s = sandbox();
    expect(keygen(join(s.dirs.offline, 'k'), {}, s.roots, s.pub).lines.join()).toMatch(new RegExp(PASSPHRASE_VAR));
    expect(() => keygen(join(s.dirs.offline, 'k2'), { [PASSPHRASE_VAR]: 'short' }, s.roots, s.pub)).toThrow(/at least 16/);
  });
});
