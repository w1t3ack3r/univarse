// Spec 0020 B2-5, B2-6, BK6: the restore's order, its stops, and the teardown on every failure, with scripted steps.
import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Entry } from '../ledger/chain.js';
import type { OpenedSet } from './artifact.js';
import type { DecryptReport, Facts } from './checks.js';
import { restore, WAL_WAIT, type RestoreDeps, type RestoreRequest } from './engine.js';

const FACTS: Facts = {
  platform: { lsn: '0/5000060', chain: { seq: '9', hash: 'aa' }, counts: { tenant: '2' } },
  tenants: { 't-1': { slug: 'demo-uni', chain: { seq: '3', hash: 'bb' }, counts: { student: '4' } } },
};
// The set starts in segment …04; its facts' position is in segment …05.
const SET = {
  index: { setId: '20261026T020000Z-ab12', files: [{ name: 'manifest.seal', size: 1, sha256: 'x' }] },
  manifest: {
    format: 'univarse-backup-manifest-v1',
    setId: '20261026T020000Z-ab12',
    createdAt: '2026-10-26T02:00:00.000Z',
    versions: {},
    deployed: { UNIVARSE_API_IMAGE: 'api@sha256:1' },
    postgres: { startLsn: '0/4000028', timeline: 1, startWal: '000000010000000000000004' },
    facts: FACTS,
    ledger: { ledgerId: 'L', generation: 1, seq: 3, hash: 'h' },
    artifacts: [],
  },
  dir: '/sets/x',
} as unknown as OpenedSet;

const decrypt = (x: Record<string, DecryptReport[string]['status']>): DecryptReport => Object.fromEntries(Object.entries(x).map(([k, s]) => [k, { status: s, sampled: 3 }]));
/** A ledger whose one accepted destruction is the drill tenant's, committed after the set's head (seq 3). */
const DRILL = 'shred-drill-20261026';
const ENTRIES = [
  { type: 'genesis', ledgerId: 'L', generation: 1, destinations: [], v: 1, seq: 1, at: '', prev: '', hash: '' },
  { type: 'pending', op: 'o1', tenant: { id: 'd', slug: DRILL }, kind: 'TENANT', versions: [1], requestedAt: '', preconditions: {}, v: 1, seq: 4, at: '', prev: '', hash: '' },
  { type: 'committed', op: 'o1', versions: [1], destroyedAt: '', auditSeq: '1', by: 'destroy', v: 1, seq: 5, at: '', prev: '', hash: '' },
] as unknown as Entry[];

type Over = Partial<RestoreDeps>;
function scripted(over: Over = {}) {
  const calls: string[] = [];
  let decrypts = 0;
  let clock = Date.parse('2026-10-26T03:00:00Z');
  const t = (name: string) => calls.push(name);
  const deps: RestoreDeps = {
    log: () => undefined,
    now: () => new Date((clock += 1000)),
    openKey: () => (t('openKey'), generateKeyPairSync('x25519').privateKey),
    openSet: () => (t('openSet'), Promise.resolve({ ok: true as const, set: SET })),
    prepareTarget: () => (t('prepareTarget'), Promise.resolve([])),
    realHeads: () => (t('realHeads'), { ok: true as const, key: 'heads-1' }),
    lockRegistry: () => (t('lock'), { release: () => t('unlock') }),
    verifyRelease: () => (t('verifyRelease'), { ok: true as const, images: {}, record: 'releases/2026-10-25-e6a0066.json' }),
    configure: () => (t('configure'), Promise.resolve([])),
    shippedWal: () => (t('shippedWal'), ['000000010000000000000004', '000000010000000000000005']),
    shipWal: () => (t('shipWal'), Promise.resolve([])),
    sleep: () => (t('sleep'), Promise.resolve()),
    newestShippedAt: () => new Date('2026-10-26T02:55:00Z'),
    restorePostgres: () => (t('restorePostgres'), Promise.resolve([])),
    restoreVault: () => (t('restoreVault'), Promise.resolve([])),
    vaultTokens: () => (t('vaultTokens'), { ok: true, lines: [] }),
    restoreFiles: () => (t('restoreFiles'), Promise.resolve({ objects: 2, problems: [] })),
    start: (s) => (t(`start:${s.join(',')}`), []),
    migrateCheck: () => (t('migrateCheck'), { ok: true, lines: [] }),
    facts: () => (t('facts'), { ok: true, value: FACTS, lines: [] }),
    verifyChains: (c) => (t(c ? 'chains@checkpoint' : 'chains'), { ok: true, value: { ok: true, problems: [] }, lines: [] }),
    verifyUnwrap: () => (t('unwrap'), { ok: true, value: { ok: true, keys: 3, unwrapped: 3 }, lines: [] }),
    verifyDecrypt: () => (t('decrypt'), { ok: true, value: decrypts++ === 0 ? decrypt({ [DRILL]: 'ok', 'demo-uni': 'ok' }) : decrypt({ [DRILL]: 'key_destroyed', 'demo-uni': 'ok' }), lines: [] }),
    recover: () => (t('recover'), Promise.resolve({ ok: true, lines: ['op o1 (shred-drill): re-applied after a restore'], entries: ENTRIES })),
    teardown: () => (t('teardown'), ['torn down']),
    memory: () => ({ stop: () => 900 }),
    ...over,
  };
  return { deps, calls };
}

const req: RestoreRequest = { mode: 'rehearsal', drill: DRILL };

describe('[B2-6] the rehearsal, in order', () => {
  it('passes every check, in the plan\'s order, tears down, and releases the lock last', async () => {
    const { deps, calls } = scripted();
    const r = await restore(req, deps);
    expect(r.ok).toBe(true);
    expect(calls).toEqual([
      'openKey', 'openSet', 'realHeads', 'lock', 'prepareTarget', 'verifyRelease', 'configure',
      'shipWal', 'shippedWal', 'restorePostgres', 'restoreVault', 'vaultTokens', 'restoreFiles', 'start:pgbouncer,valkey',
      'migrateCheck', 'chains@checkpoint', 'facts', 'unwrap', 'decrypt', 'recover', 'decrypt', 'unwrap', 'chains', 'realHeads',
      'teardown', 'unlock',
    ]);
    expect(r.record?.checks.map((c) => c.name)).toEqual([
      'files', 'migrations and RLS', 'audit chains at the checkpoint', 'row counts', 'data keys unwrap', 'recovery',
      'control: decryption before recovery', 'decryption after recovery', 'data keys unwrap after recovery', 'audit chains after recovery',
      'the real ledger unchanged',
    ]);
    // The newest shipped segment is from 02:55:00; the scripted clock reads 03:00:01 at the start (it ticks per call).
    expect(r.record?.rpoSeconds).toBe(301);
    expect(r.record?.peakMemoryMb).toBe(900);
    expect(r.lines.at(-1)).toBe('torn down');
  });

  it('a wrong key stops before anything is created: no lock, no target, no teardown', async () => {
    const { deps, calls } = scripted({ openKey: () => { throw new Error('the backup key does not open: wrong passphrase, or the file was changed'); } });
    const r = await restore(req, deps);
    expect(r.ok).toBe(false);
    expect(calls).toEqual([]);
    expect(r.lines.join('\n')).toMatch(/STOP: the backup key does not open/);
  });

  it('--to before the set was taken is refused before anything is created', async () => {
    const { deps, calls } = scripted();
    const r = await restore({ ...req, to: new Date('2026-10-26T01:59:00Z') }, deps);
    expect(r.ok).toBe(false);
    expect(r.lines.join('\n')).toMatch(/is before set .* was taken/);
    expect(calls).toEqual(['openKey', 'openSet']);
  });

  it('a release that doesn\'t verify stops it, and the target is still torn down', async () => {
    const { deps, calls } = scripted({ verifyRelease: () => ({ ok: false, problems: ['no release record names these digests: `images:prune` may have removed it'] }) });
    const r = await restore(req, deps);
    expect(r.ok).toBe(false);
    expect(calls.slice(-2)).toEqual(['teardown', 'unlock']);
    expect(calls).not.toContain('configure');
  });
});

describe('[BK6] every failure tears the rehearsal down', () => {
  const failures: [string, Over][] = [
    ['configure', { configure: () => Promise.resolve(['the set has no secrets.json']) }],
    ['postgres', { restorePostgres: () => Promise.resolve(['target not reached']) }],
    ['vault', { restoreVault: () => Promise.reject(new Error('the snapshot did not restore')) }],
    ['tokens', { vaultTokens: () => ({ ok: false, lines: [] }) }],
    ['files', { restoreFiles: () => Promise.resolve({ objects: 1, problems: ['a.bin: read back differs'] }) }],
    ['migrations', { migrateCheck: () => ({ ok: false, lines: ['pending migration'] }) }],
    ['counts', { facts: () => ({ ok: true, value: { ...FACTS, platform: { ...FACTS.platform, counts: { tenant: '1' } } }, lines: [] }) }],
    ['recovery', { recover: () => Promise.resolve({ ok: false, lines: ['STOP: …'], entries: ENTRIES }) }],
    ['a thrown step', { start: () => { throw new Error('docker is gone'); } }],
  ];
  it.each(failures)('%s', async (_n, over) => {
    const { deps, calls } = scripted(over);
    const r = await restore(req, deps);
    expect(r.ok).toBe(false);
    expect(calls.slice(-2)).toEqual(['teardown', 'unlock']);
    expect(r.lines.some((l) => l.startsWith('STOP: '))).toBe(true);
    expect(r.lines.at(-1)).toBe('torn down');
  });

  it('the teardown is skipped when it is the mutation: this test would see the volumes left (BK10)', async () => {
    const { deps, calls } = scripted({ restorePostgres: () => Promise.resolve(['x']) });
    await restore(req, deps);
    expect(calls.filter((c) => c === 'teardown')).toHaveLength(1);
  });
});

describe('[B2-7] waiting for the target\'s WAL', () => {
  it('ships and waits while only the newest segment is missing, then goes on', async () => {
    let n = 0;
    const { deps, calls } = scripted({ shippedWal: () => (n++ < 2 ? ['000000010000000000000004'] : ['000000010000000000000004', '000000010000000000000005']) });
    expect((await restore(req, deps)).ok).toBe(true);
    expect(calls.filter((c) => c === 'sleep')).toHaveLength(2);
    expect(calls.filter((c) => c === 'shipWal')).toHaveLength(3);
  });

  it('gives up after six minutes, saying to run it again', async () => {
    const { deps, calls } = scripted({ shippedWal: () => ['000000010000000000000004'] });
    const r = await restore(req, deps);
    expect(r.ok).toBe(false);
    expect(r.lines.join('\n')).toMatch(/hasn't been archived yet .*run this again in a few minutes/);
    expect(calls.filter((c) => c === 'sleep')).toHaveLength(WAL_WAIT.forMs / WAL_WAIT.everyMs);
    expect(calls).not.toContain('restorePostgres');
  });

  it('a gap stops at once, without waiting (BK10: a WAL gap accepted)', async () => {
    const { deps, calls } = scripted({ shippedWal: () => ['000000010000000000000004', '000000010000000000000006'] });
    const r = await restore(req, deps);
    expect(r.lines.join('\n')).toMatch(/WAL segment 000000010000000000000005 is missing/);
    expect(calls).not.toContain('sleep');
  });

  it('a time target needs no segment position, and its counts are reported, not compared', async () => {
    const { deps } = scripted({ facts: () => ({ ok: true, value: { ...FACTS, platform: { ...FACTS.platform, counts: { tenant: '3' } } }, lines: [] }) });
    const r = await restore({ ...req, to: new Date('2026-10-26T02:30:00Z') }, deps);
    expect(r.ok).toBe(true);
    expect(r.record?.checks.map((c) => c.name)).not.toContain('row counts');
    expect(r.lines.join('\n')).toMatch(/reported, not compared/);
  });
});

describe('[D11] the drill\'s expectations, and the real ledger', () => {
  it('a drill tenant still decrypting after recovery fails the rehearsal (BK7: the drill passing without re-application)', async () => {
    const { deps } = scripted({ verifyDecrypt: () => ({ ok: true, value: decrypt({ [DRILL]: 'ok', 'demo-uni': 'ok' }), lines: [] }) });
    const r = await restore(req, deps);
    expect(r.ok).toBe(false);
    expect(r.lines.join('\n')).toMatch(/FAIL decryption after recovery: shred-drill-20261026: its destruction was accepted/);
  });

  it('a control that doesn\'t decrypt fails (BK10: the control not required to decrypt)', async () => {
    let n = 0;
    const { deps } = scripted({ verifyDecrypt: () => ({ ok: true, value: n++ === 0 ? decrypt({ [DRILL]: 'key_destroyed', 'demo-uni': 'ok' }) : decrypt({ [DRILL]: 'key_destroyed', 'demo-uni': 'ok' }), lines: [] }) });
    const r = await restore(req, deps);
    expect(r.ok).toBe(false);
    expect(r.lines.join('\n')).toMatch(/FAIL control: decryption before recovery: .*proves nothing/);
  });

  it('a rehearsal that changed the real ledger fails (BK10: the real ledger written by a rehearsal)', async () => {
    let n = 0;
    const { deps } = scripted({ realHeads: () => ({ ok: true, key: n++ === 0 ? 'heads-1' : 'heads-2' }) });
    const r = await restore(req, deps);
    expect(r.ok).toBe(false);
    expect(r.lines.join('\n')).toMatch(/FAIL the real ledger unchanged: its heads changed during the rehearsal/);
  });

  it('a real restore never reads the real heads as a rehearsal check (it uses the real ledger itself)', async () => {
    const { deps, calls } = scripted();
    const r = await restore({ mode: 'restore' }, deps);
    expect(r.ok).toBe(true);
    expect(calls).not.toContain('realHeads');
  });
});
