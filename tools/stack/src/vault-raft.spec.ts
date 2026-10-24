// Spec 0020 D4, B-4: the storage states the deploy acts on, and the one-time migration's order, checks and marker.
// Docker is scripted: each call is recorded, and Vault's answers come from a small model of its state.
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Runner } from './docker.js';
import { BACKUP_POLICY, BACKUP_POLICY_HCL, configure } from './vault.js';
import { FILE_VOLUME, migrateRaft, RAFT_VOLUME, storageProblem, vaultStorage, type KekShape, type MigrateDeps } from './vault-raft.js';

const KEK: KekShape = { type: 'aes256-gcm96', derived: true, latest_version: 2, min_decryption_version: 1, keys: { '1': 1, '2': 2 } };

interface World {
  raft: boolean;
  file: boolean;
  storage: 'file' | 'raft';
  sealed: boolean;
  running: boolean;
  kek: KekShape;
  /** What decrypting the probe returns on Raft (null: it fails). */
  probeOnRaft: 'same' | 'other' | null;
  migrateOk: boolean;
  /** The migrate command exits 0 but never says it migrated everything. */
  migrateSilent?: boolean;
}

function scripted(over: Partial<World> = {}) {
  const w: World = { raft: false, file: true, storage: 'file', sealed: false, running: true, kek: KEK, probeOnRaft: 'same', migrateOk: true, ...over };
  const calls: string[] = [];
  let probe = '';
  const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
  const run: Runner = (args, opts = {}) => {
    const a = [...args];
    if (a[0] === 'volume' && a[1] === 'inspect') return { status: (a[2] === RAFT_VOLUME ? true : w.file || w.raft) ? 0 : 1, stdout: '', stderr: '' };
    if (a[0] === 'run' && a.includes('test')) {
      const vol = a[a.indexOf('-v') + 1]?.split(':')[0];
      return { status: (vol === RAFT_VOLUME ? w.raft : w.file) ? 0 : 1, stdout: '', stderr: '' };
    }
    if (a[0] === 'run' && a.includes('find /r -mindepth 1 -delete')) {
      calls.push('empty raft');
      w.raft = false;
      return ok();
    }
    if (a[0] === 'volume' && (a[1] === 'create' || a[1] === 'rm')) {
      calls.push(`volume ${a[1]} ${a.at(-1) ?? ''}`);
      return ok();
    }
    if (a[0] === 'run' && (a.at(-1) ?? '').includes('cp -a /src/. /dst/')) {
      calls.push(`copy ${a.filter((x) => x.includes(':/src') || x.includes(':/dst')).join(' ')}`);
      return ok();
    }
    if (a[0] === 'run' && a.includes('migrate')) {
      calls.push(`migrate ${a.filter((x) => x.endsWith(':/vault/file') || x.endsWith(':/vault/file:ro')).join(' ')}`);
      if (!w.migrateOk) return { status: 2, stdout: '', stderr: 'Error migrating: error setting migration lock: permission denied' };
      w.raft = true;
      return ok(w.migrateSilent ? 'copied key: path=core/x' : 'Success! All of the keys have been migrated.');
    }
    if (a[0] === 'exec') {
      const v = a.slice(a.indexOf('vault') + 1);
      const token = opts.env?.VAULT_TOKEN;
      if (v[0] === 'status') return { status: w.sealed ? 2 : 0, stdout: JSON.stringify({ initialized: true, sealed: w.sealed, storage_type: w.storage }), stderr: '' };
      if (v[0] === 'write' && v[2] === 'sys/unseal') {
        calls.push('unseal');
        w.sealed = false;
        return ok('{}');
      }
      if (v[0] === 'read' && v.includes('transit/keys/univarse-kek')) {
        calls.push(`read kek (${token ?? ''})`);
        return ok(JSON.stringify({ data: w.kek }));
      }
      if (v[2] === 'transit/encrypt/univarse-kek') {
        calls.push(`encrypt (${token ?? ''})`);
        probe = opts.input ?? '';
        return ok(JSON.stringify({ data: { ciphertext: 'vault:v2:probe' } }));
      }
      if (v[2] === 'transit/decrypt/univarse-kek') {
        calls.push(`decrypt (${token ?? ''})`);
        if (w.probeOnRaft === null) return { status: 2, stdout: '', stderr: 'denied' };
        return ok(JSON.stringify({ data: { plaintext: w.probeOnRaft === 'same' ? probe : 'b3RoZXI=' } }));
      }
    }
    throw new Error(`unscripted: docker ${a.join(' ')}`);
  };
  const dir = mkdtempSync(join(tmpdir(), 'uv-raft-'));
  writeFileSync(join(dir, 'vault-init.json'), JSON.stringify({ unsealKey: 'uk', rootToken: 'ROOT', appToken: 'APP' }));
  const deps: MigrateDeps = {
    run,
    dir,
    target: { container: 'v', tls: false },
    compose: (c) => {
      calls.push(`compose ${c.join(' ')}`);
      if (c[0] === 'stop') w.running = false;
      if (c[0] === 'up') {
        w.running = true;
        w.storage = 'raft';
        w.sealed = true;
      }
      return { status: 0 };
    },
    verifyUnwrap: () => (calls.push('verify-unwrap'), { ok: true, lines: ['3 data keys unwrap'] }),
    ensureDataVolumes: () => void calls.push('ensureDataVolumes'),
    log: () => undefined,
  };
  return { w, calls, deps, dir, marker: join(dir, 'vault-raft.json'), pending: join(dir, 'vault-raft.pending.json') };
}

describe('vaultStorage', () => {
  const cases: [Partial<World>, boolean, string][] = [
    [{ raft: false, file: false }, false, 'fresh'],
    [{ raft: false, file: true }, false, 'unmigrated'],
    [{ raft: true, file: true }, false, 'unverified'],
    [{ raft: true, file: true }, true, 'raft'],
    [{ raft: true, file: false }, false, 'raft'], // born on Raft
  ];
  for (const [world, marker, expected] of cases)
    it(`raft ${String(world.raft)}, file ${String(world.file)}, marker ${String(marker)}: ${expected}`, () => {
      const s = scripted(world);
      if (marker) writeFileSync(s.marker, '{}');
      expect(vaultStorage(s.deps.run, s.dir)).toBe(expected);
    });

  it('checks each volume as the vault user that owns it, read-only and with no network', () => {
    const seen: (readonly string[])[] = [];
    const s = scripted();
    const run: Runner = (args, opts) => {
      if (args[0] === 'run') seen.push(args);
      return s.deps.run(args, opts);
    };
    vaultStorage(run, s.dir);
    expect(seen.length).toBe(2);
    for (const a of seen) expect(a).toEqual(expect.arrayContaining(['--user', '100:1000', '--network', 'none', '--read-only', '--cap-drop', 'ALL']));
  });

  it('only unmigrated and unverified are problems, each naming the migration', () => {
    expect(storageProblem('raft')).toBeNull();
    expect(storageProblem('fresh')).toBeNull();
    expect(storageProblem('unmigrated')).toMatch(/migrate-raft/);
    expect(storageProblem('unverified')).toMatch(/migrate-raft/);
  });
});

describe('migrateRaft', () => {
  it('records before, stops Vault, migrates from the read-only file storage, unseals, verifies, then writes the marker', () => {
    const s = scripted();
    const r = migrateRaft(s.deps);
    expect(r.ok).toBe(true);
    expect(s.calls).toEqual([
      'read kek (ROOT)',
      'encrypt (APP)',
      'compose stop vault',
      'ensureDataVolumes',
      'empty raft',
      `volume create ${RAFT_VOLUME}-source`,
      `copy ${FILE_VOLUME}:/src:ro ${RAFT_VOLUME}-source:/dst`,
      `migrate ${RAFT_VOLUME}-source:/vault/file`,
      `volume rm ${RAFT_VOLUME}-source`,
      'compose up -d --wait vault',
      'unseal',
      'read kek (ROOT)',
      'decrypt (APP)',
      'verify-unwrap',
    ]);
    expect(existsSync(s.marker)).toBe(true);
    expect(existsSync(s.pending)).toBe(false);
    expect(vaultStorage(s.deps.run, s.dir)).toBe('raft');
  });

  const failures: [string, Partial<World> | ((d: MigrateDeps) => MigrateDeps), RegExp][] = [
    ['the migrate command fails, naming Vault\'s error', { migrateOk: false }, /operator migrate failed \(exit 2\): Error migrating: error setting migration lock.*untouched/],
    ['the migrate command exits 0 without saying every key was migrated', { migrateSilent: true }, /operator migrate failed/],
    ["the KEK's metadata differs afterwards", { kek: { ...KEK, keys: { '1': 1 } } }, /metadata changed/],
    ["the probe doesn't decrypt", { probeOnRaft: null }, /probe doesn't decrypt/],
    ['the probe decrypts to something else', { probeOnRaft: 'other' }, /probe doesn't decrypt/],
    ['a data key does not unwrap', (d) => ({ ...d, verifyUnwrap: () => ({ ok: false, lines: ['demo-uni v2: unwrap failed'] }) }), /not every active data key unwraps/],
  ];
  for (const [name, change, reason] of failures)
    it(`${name}: no marker, so the deploy keeps refusing`, () => {
      const s = scripted(typeof change === 'function' ? {} : change);
      const deps = typeof change === 'function' ? change(s.deps) : s.deps;
      if (name.includes('metadata')) {
        // The metadata changes only after the migration.
        const before = s.w.kek;
        s.w.kek = KEK;
        const origCompose = deps.compose.bind(deps);
        deps.compose = (c) => {
          const out = origCompose(c);
          if (c[0] === 'up') s.w.kek = before;
          return out;
        };
      }
      const r = migrateRaft(deps);
      expect(r.ok).toBe(false);
      expect(r.lines.join('\n')).toMatch(reason);
      expect(existsSync(s.marker)).toBe(false);
      if (s.w.raft) expect(vaultStorage(s.deps.run, s.dir)).toBe('unverified');
    });

  it('the file storage is only ever mounted read-only, and the scratch copy is removed even when the migration fails', () => {
    for (const world of [{}, { migrateOk: false }]) {
      const s = scripted(world);
      const mounts: string[] = [];
      const run: Runner = (args, opts) => {
        for (const a of args) if (a.startsWith(`${FILE_VOLUME}:`)) mounts.push(a);
        return s.deps.run(args, opts);
      };
      migrateRaft({ ...s.deps, run });
      expect(mounts.length).toBeGreaterThan(0);
      for (const m of mounts) expect(m).toMatch(/:ro$/);
      expect(s.calls).toContain(`volume rm ${RAFT_VOLUME}-source`);
    }
  });

  it('a retry after a failed attempt compares with the first attempt\'s record, never with the half-copied Raft', () => {
    const s = scripted({ migrateOk: true, probeOnRaft: null });
    expect((migrateRaft(s.deps)).ok).toBe(false);
    const pending = JSON.parse(readFileSync(s.pending, 'utf8')) as { kek: KekShape; ciphertext: string };
    expect(pending.kek).toEqual(KEK);
    // Now Vault runs on the partial Raft; the retry must not read "before" from it.
    s.w.probeOnRaft = 'same';
    s.calls.length = 0;
    const r = migrateRaft(s.deps);
    expect(r.ok).toBe(true);
    expect(s.calls.slice(0, 7)).toEqual(['compose stop vault', 'ensureDataVolumes', 'empty raft', `volume create ${RAFT_VOLUME}-source`, `copy ${FILE_VOLUME}:/src:ro ${RAFT_VOLUME}-source:/dst`, `migrate ${RAFT_VOLUME}-source:/vault/file`, `volume rm ${RAFT_VOLUME}-source`]);
    expect(existsSync(s.pending)).toBe(false);
  });

  it('refuses when Vault is not running on its file storage, unsealed, and changes nothing', () => {
    for (const w of [{ sealed: true }, { storage: 'raft' as const }]) {
      const s = scripted(w);
      const r = migrateRaft(s.deps);
      expect(r.ok).toBe(false);
      expect(s.calls.filter((c) => c.startsWith('compose') || c.startsWith('migrate') || c === 'empty raft')).toEqual([]);
    }
  });

  it('nothing to do on Raft; nothing to migrate on a fresh stack', () => {
    const done = scripted({ raft: true, file: false });
    expect(migrateRaft(done.deps)).toMatchObject({ ok: true });
    expect(done.calls).toEqual([]);
    const fresh = scripted({ raft: false, file: false });
    expect((migrateRaft(fresh.deps)).ok).toBe(false);
    expect(fresh.calls).toEqual([]);
  });
});

describe('the backup policy and token (B-4)', () => {
  it('the policy reads Raft snapshots and nothing else', () => {
    expect(BACKUP_POLICY_HCL).toBe('path "sys/storage/raft/snapshot" { capabilities = ["read"] }\n');
  });

  it('configure writes the backup policy and creates its token once, saved beside the app token', () => {
    const dir = mkdtempSync(join(tmpdir(), 'uv-vault-'));
    writeFileSync(join(dir, 'vault-init.json'), JSON.stringify({ unsealKey: 'uk', rootToken: 'ROOT', appToken: 'APP' }));
    const writes: string[] = [];
    let created = 0;
    const run: Runner = (args, opts = {}) => {
      const v = args.slice(args.indexOf('vault') + 1);
      if (v[0] === 'audit' || v[0] === 'secrets') return { status: 0, stdout: JSON.stringify(v[0] === 'audit' ? { 'file/': {} } : { 'transit/': {} }), stderr: '' };
      if (v[0] === 'read') return { status: 0, stdout: '{}', stderr: '' };
      if (v[0] === 'policy') {
        writes.push(`${v[2] ?? ''}: ${opts.input ?? ''}`);
        return { status: 0, stdout: '', stderr: '' };
      }
      if (v[0] === 'token') {
        created++;
        expect(v).toEqual(expect.arrayContaining(['-policy', BACKUP_POLICY, '-no-default-policy', '-orphan']));
        return { status: 0, stdout: JSON.stringify({ auth: { client_token: 'BACKUP' } }), stderr: '' };
      }
      throw new Error(`unscripted ${v.join(' ')}`);
    };
    const target = { container: 'v', tls: false };
    expect(configure(run, dir, target).backupToken).toBe('BACKUP');
    expect(writes).toContain(`${BACKUP_POLICY}: ${BACKUP_POLICY_HCL}`);
    expect(JSON.parse(readFileSync(join(dir, 'vault-init.json'), 'utf8'))).toMatchObject({ appToken: 'APP', backupToken: 'BACKUP' });
    configure(run, dir, target);
    expect(created).toBe(1);
  });
});
