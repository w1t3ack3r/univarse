// Spec 0020 BK3, B-6 to B-9, D14 (BK14's fourth case): one backup, its order and locks, and every way it stops.
// The set is written for real (SetWriter, sealing, the index) into a temporary destination; the sources are fakes.
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { acquireLedgerLock } from '../ledger/lock.js';
import { takeBackup, type BackupDeps } from './backup.js';
import { unseal } from './seal.js';
import { INDEX, listSets, MANIFEST, SETS } from './set.js';

const SECRET = 'stack-secret-value-0123456789abcdef';
const START = { lsn: '0/5000028', timeline: 1, startWal: '000000010000000000000005' };

async function* chunks(...parts: string[]) {
  await Promise.resolve();
  for (const p of parts) yield Buffer.from(p);
}

function fakes(over: Partial<BackupDeps> = {}) {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  const dest = mkdtempSync(join(tmpdir(), 'uv-backup-'));
  const events: string[] = [];
  let held = 0;
  const deps: BackupDeps = {
    lockRegistry: () => (events.push('lock registry'), held++, { release: () => (events.push('release registry'), held--) }),
    lockLedger: () => (events.push('lock ledger'), Promise.resolve({ release: () => events.push('release ledger') })),
    publicKey: () => publicKey,
    destination: () => dest,
    prepareDestination: () => events.push('prepare'),
    ledgerDestinations: () => ({ ok: true, paths: ['/primary'] }),
    externalRule: () => null,
    shipWal: () => (events.push('ship wal'), Promise.resolve({ shipped: 2, skipped: 0, lines: ['WAL: 2 shipped'] })),
    baseBackup: () => {
      let ended = false;
      return {
        stream: (async function* () {
          events.push('pg_basebackup');
          yield* chunks('base', 'backup');
          ended = true;
        })(),
        start: () => {
          if (!ended) throw new Error('start read before the stream ended');
          return START;
        },
      };
    },
    vaultSnapshot: () => (events.push('vault'), chunks('raft-snapshot')),
    cleanFiles: () => (events.push('files'), (async function* () {
      await Promise.resolve();
      yield { name: 'tenant/a.pdf', data: Buffer.from('pdf') };
    })()),
    stackParts: () => (events.push('stack'), [{ name: 'secrets.json', data: Buffer.from(`{"postgresSuperuser":"${SECRET}"}`) }]),
    facts: () => (events.push('facts'), Promise.resolve({ platform: { lsn: '0/6000000', chain: { seq: '9', hash: 'ab' } } })),
    snapshotLedger: () => (events.push('snapshot ledger'), {
      ok: true,
      snapshot: { ledgerId: 'L', generation: 1, attempt: null, seq: 4, hash: 'h4', destinations: 2 },
      entries: [{ name: 'L/gen-0001/ledger.jsonl', data: Buffer.from('{}\n') }],
    }),
    deployed: () => ({ UNIVARSE_API_IMAGE: 'localhost:5000/api@sha256:1' }),
    versions: () => ({ postgres: 'postgres:18@sha256:x' }),
    prune: () => (events.push('prune'), []),
    now: () => new Date('2026-10-24T02:00:00Z'),
    log: () => undefined,
    ...over,
  };
  return { deps, dest, events, privateKey, held: () => held };
}

describe('takeBackup', () => {
  it('in order, under the registry lock, with the ledger lock only around the ledger; a complete, sealed set', async () => {
    const f = fakes();
    const r = await takeBackup(f.deps);
    expect(r.ok).toBe(true);
    expect(f.events).toEqual([
      'lock registry',
      'prepare',
      'ship wal',
      'pg_basebackup',
      'vault',
      'files',
      'stack',
      'facts',
      'lock ledger',
      'snapshot ledger',
      'release ledger',
      'prune',
      'release registry',
    ]);
    const dir = join(f.dest, SETS, r.setId ?? '');
    expect(readdirSync(dir).sort()).toEqual([INDEX, 'files.tar.seal', 'ledger.tar.seal', MANIFEST, 'postgres.tar.seal', 'stack.tar.seal', 'vault.snap.seal'].sort());
    const manifest = JSON.parse((await unseal(readFileSync(join(dir, MANIFEST)), f.privateKey)).toString()) as Record<string, unknown>;
    expect(manifest).toMatchObject({
      format: 'univarse-backup-manifest-v1',
      postgres: { startLsn: START.lsn, timeline: START.timeline, startWal: START.startWal },
      facts: { platform: { lsn: '0/6000000', chain: { seq: '9', hash: 'ab' } } },
      ledger: { seq: 4, hash: 'h4' },
      deployed: { UNIVARSE_API_IMAGE: 'localhost:5000/api@sha256:1' },
    });
    expect(listSets(f.dest)[0]?.index?.startWal).toBe(START.startWal);
    // BK3/BK9: no secret in clear on disk, nor in what the command says.
    for (const name of readdirSync(dir)) expect([name, readFileSync(join(dir, name)).includes(SECRET)]).toEqual([name, false]);
    expect(r.lines.join('\n')).not.toContain(SECRET);
  });

  const refusals: [string, Partial<BackupDeps>, RegExp][] = [
    ['no public key', { publicKey: () => null }, /keygen/],
    ["the ledger's destinations can't be read", { ledgerDestinations: () => ({ ok: false, problems: ['configured destination dest-1 is missing'] }) }, /no set is taken[\s\S]*dest-1/],
    ['the external-drive rule', { externalRule: () => 'that drive must hold a ledger destination too' }, /must hold a ledger destination/],
  ];
  for (const [name, over, why] of refusals)
    it(`refuses (${name}) before writing anything, and releases the lock`, async () => {
      const f = fakes(over);
      const r = await takeBackup(f.deps);
      expect(r.ok).toBe(false);
      expect(r.lines.join('\n')).toMatch(why);
      expect(f.events).toEqual(['lock registry', 'release registry']);
      expect(existsSync(join(f.dest, SETS))).toBe(false);
    });

  const stops: [string, Partial<BackupDeps>, RegExp][] = [
    ['pg_basebackup fails', {
      baseBackup: () => ({
        stream: (async function* () {
          await Promise.resolve();
          yield Buffer.from('partial');
          throw new Error('docker compose exited 1: pg_basebackup: error: connection failed');
        })(),
        start: () => START,
      }),
    }, /connection failed/],
    ["the ledger can't be snapshot", { snapshotLedger: () => ({ ok: false, problems: ['the ledger changed while it was copied'] }) }, /changed while it was copied/],
    ['the facts job fails', { facts: () => Promise.reject(new Error('the keys job exited 1')) }, /keys job exited 1/],
  ];
  for (const [name, over, why] of stops)
    it(`stops when ${name}: the set has no index (ignored), nothing is pruned, both locks released`, async () => {
      const f = fakes(over);
      const r = await takeBackup(f.deps);
      expect(r.ok).toBe(false);
      expect(r.lines.join('\n')).toMatch(why);
      expect(listSets(f.dest).every((s) => s.index === null)).toBe(true);
      expect(f.events).not.toContain('prune');
      expect(f.events.at(-1)).toBe('release registry');
      expect(f.events.filter((e) => e === 'lock ledger').length).toBe(f.events.filter((e) => e === 'release ledger').length);
      expect(f.held()).toBe(0);
    });

  it('[BK14] a backup during a destruction waits for the ledger lock, then snapshots what the destruction left', async () => {
    const root = mkdtempSync(join(tmpdir(), 'uv-backup-lock-'));
    const destruction = await acquireLedgerLock(root, 'destroy', { log: () => undefined });
    const f = fakes({ lockLedger: (holder) => acquireLedgerLock(root, holder, { waitMs: 10_000, pollMs: 20, log: () => undefined }) });
    let snapshotAt = 0;
    const snapshot = f.deps.snapshotLedger.bind(f.deps);
    f.deps.snapshotLedger = () => ((snapshotAt = Date.now()), snapshot());
    const backup = takeBackup(f.deps);
    await new Promise((r) => setTimeout(r, 300));
    const releasedAt = Date.now();
    destruction.release();
    expect((await backup).ok).toBe(true);
    expect(snapshotAt).toBeGreaterThanOrEqual(releasedAt);
  });
});
