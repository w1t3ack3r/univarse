// Spec 0020 B2-6, B2-9, B2-11: the restore's decisions at their edges (BK10's mutations: a count mismatch tolerated,
// the control not required to decrypt, the drill passing without the re-application).
import { describe, expect, it } from 'vitest';
import { afterProblems, checkpointOf, controlProblems, countProblems, destroyedTenants, type DecryptReport, type Facts } from './checks.js';

const facts = (over: Partial<Record<'platform' | 'tenant', Record<string, string>>> = {}): Facts => ({
  platform: { lsn: '0/3000060', chain: { seq: '7', hash: 'aa' }, counts: over.platform ?? { tenant: '2', platform_audit_event: '7' } },
  tenants: { 't-1': { slug: 'demo-uni', chain: { seq: '4', hash: 'bb' }, counts: over.tenant ?? { student: '10', audit_event: '4' } } },
});

describe('[B2-9] the counts at the set’s target', () => {
  it('equal everywhere: no problem', () => {
    expect(countProblems(facts(), facts())).toEqual([]);
  });

  it('a single row more or less fails, naming the table', () => {
    expect(countProblems(facts(), facts({ tenant: { student: '11', audit_event: '4' } }))).toEqual(['tenant demo-uni: student has 11 rows, the set recorded 10']);
    expect(countProblems(facts(), facts({ platform: { tenant: '1', platform_audit_event: '7' } }))).toEqual(['platform: tenant has 1 rows, the set recorded 2']);
  });

  it('a table or a tenant on one side only fails', () => {
    expect(countProblems(facts(), facts({ tenant: { student: '10' } }))).toEqual(['tenant demo-uni: audit_event has no table rows, the set recorded 4']);
    const extra: Facts = { ...facts(), tenants: { ...facts().tenants, 't-2': { slug: 'test-poly', chain: null, counts: {} } } };
    expect(countProblems(facts(), extra)).toEqual(['tenant test-poly: restored, but not in the set\'s facts']);
    expect(countProblems(extra, facts())).toEqual(['tenant test-poly: in the set\'s facts, not restored']);
  });

  it('the checkpoint carries every chain head, by tenant id', () => {
    expect(checkpointOf(facts())).toEqual({ platform: { seq: '7', hash: 'aa' }, tenants: { 't-1': { chain: { seq: '4', hash: 'bb' } } } });
  });
});

const r = (x: Record<string, DecryptReport[string]['status']>): DecryptReport => Object.fromEntries(Object.entries(x).map(([k, s]) => [k, { status: s, sampled: s === 'empty' ? 0 : 5 }]));

describe('[D11] the control, before recovery', () => {
  const none = new Set<string>();

  it('every tenant decrypts, or has nothing to sample: passes', () => {
    expect(controlProblems(r({ 'demo-uni': 'ok', 'test-poly': 'empty' }), { destroyedBefore: none })).toEqual([]);
  });

  it('a value that fails to decrypt fails', () => {
    expect(controlProblems(r({ 'demo-uni': 'failed' }), { destroyedBefore: none })).toEqual(['demo-uni: its values do not decrypt before recovery (5 sampled)']);
  });

  it('key_destroyed is allowed only for a destruction recorded before the set', () => {
    expect(controlProblems(r({ 'shred-drill-20261020': 'key_destroyed' }), { destroyedBefore: new Set(['shred-drill-20261020']) })).toEqual([]);
    expect(controlProblems(r({ 'demo-uni': 'key_destroyed' }), { destroyedBefore: none })).toHaveLength(1);
  });

  it('the drill tenant must decrypt: empty, destroyed or absent all fail', () => {
    const drill = 'shred-drill-20261026';
    expect(controlProblems(r({ [drill]: 'ok' }), { destroyedBefore: none, drill })).toEqual([]);
    for (const s of ['empty', 'key_destroyed'] as const) expect(controlProblems(r({ [drill]: s }), { destroyedBefore: new Set([drill]), drill }).join()).toMatch(/proves nothing/);
    expect(controlProblems(r({}), { destroyedBefore: none, drill }).join()).toMatch(/taken before it existed/);
  });
});

describe('[D11] after recovery', () => {
  const drill = 'shred-drill-20261026';
  const before = r({ [drill]: 'ok', 'demo-uni': 'ok', 'test-poly': 'empty', 'old-drill': 'key_destroyed' });

  it('the drill tenant destroyed, everyone else as the control found them: passes', () => {
    const after = r({ [drill]: 'key_destroyed', 'demo-uni': 'ok', 'test-poly': 'empty', 'old-drill': 'key_destroyed' });
    expect(afterProblems(before, after, { accepted: new Set([drill, 'old-drill']), drill })).toEqual([]);
  });

  it('the drill tenant still decrypting after recovery fails: the restore brought it back', () => {
    const after = r({ [drill]: 'ok', 'demo-uni': 'ok', 'test-poly': 'empty', 'old-drill': 'key_destroyed' });
    expect(afterProblems(before, after, { accepted: new Set([drill, 'old-drill']), drill }).join()).toMatch(/brought its data back into use/);
  });

  it('the drill tenant may never be empty; another destroyed tenant may', () => {
    const after = r({ [drill]: 'empty', 'demo-uni': 'ok', 'test-poly': 'empty', 'old-drill': 'empty' });
    expect(afterProblems(before, after, { accepted: new Set([drill, 'old-drill']), drill })).toEqual([`${drill}: its destruction was accepted, yet after recovery it is empty: a restore brought its data back into use`]);
  });

  it('a tenant without a destruction that changes, appears or vanishes fails', () => {
    expect(afterProblems(before, r({ [drill]: 'key_destroyed', 'demo-uni': 'key_destroyed', 'test-poly': 'empty', 'old-drill': 'key_destroyed' }), { accepted: new Set([drill, 'old-drill']), drill })).toEqual([
      'demo-uni: ok before recovery, key_destroyed after: recovery changed a tenant it had no destruction for',
    ]);
    expect(afterProblems(before, r({ [drill]: 'key_destroyed', 'test-poly': 'empty', 'old-drill': 'key_destroyed' }), { accepted: new Set([drill, 'old-drill']), drill })).toEqual(['demo-uni: vanished during recovery']);
  });

  it('a drill with no accepted destruction in the ledger fails', () => {
    const after = r({ [drill]: 'key_destroyed', 'demo-uni': 'ok', 'test-poly': 'empty', 'old-drill': 'key_destroyed' });
    expect(afterProblems(before, after, { accepted: new Set(['old-drill']), drill }).join()).toMatch(/no accepted destruction/);
  });
});

describe('[D11] which tenants the ledger says are destroyed', () => {
  it('TENANT destructions only; "before" holds those committed by the set\'s own ledger head', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { init } = await import('../ledger/commands.js');
    const { FakeKeysDb } = await import('../ledger/fake-keys-db.js');
    const { destroy } = await import('../ledger/protocol.js');
    const { establishAuthority } = await import('../ledger/ledger.js');
    const root = mkdtempSync(join(tmpdir(), 'uv-destroyed-'));
    try {
      const primary = { id: 'primary', path: join(root, 'primary') };
      const db = new FakeKeysDb();
      db.addTenant('10000000-0000-4000-8000-000000000001', 'old-drill', { 1: 'ACTIVE' });
      db.addTenant('10000000-0000-4000-8000-000000000002', 'demo-uni', { 1: 'RETIRED', 2: 'ACTIVE' }, [1]);
      db.addTenant('10000000-0000-4000-8000-000000000003', 'new-drill', { 1: 'ACTIVE' });
      const deps = { primary, db, lock: () => Promise.resolve({ release: () => undefined }), log: () => undefined };
      expect((await init(deps)).ok).toBe(true);
      expect((await destroy(deps, { slug: 'old-drill' })).ok).toBe(true);
      expect((await destroy(deps, { slug: 'demo-uni', version: 1 })).ok).toBe(true);
      const a = establishAuthority(primary);
      if (!a.ok) throw new Error('no authority');
      const setHead = { ledgerId: a.ledgerId, generation: 1, seq: a.entries.at(-1)?.seq ?? 0 };
      expect((await destroy(deps, { slug: 'new-drill' })).ok).toBe(true);
      const b = establishAuthority(primary);
      if (!b.ok) throw new Error('no authority');
      const { accepted, before } = destroyedTenants(b.entries, setHead);
      expect([...accepted].sort()).toEqual(['new-drill', 'old-drill']); // demo-uni's RETIRED destruction leaves it decrypting
      expect([...before]).toEqual(['old-drill']);
      // A set from another ledger can't be placed in this one's sequence: every accepted destruction counts as before.
      expect([...destroyedTenants(b.entries, { ...setHead, ledgerId: 'other' }).before].sort()).toEqual(['new-drill', 'old-drill']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
