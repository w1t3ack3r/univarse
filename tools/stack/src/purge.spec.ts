import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { SetOnDisk } from './backup/set.js';
import type { Result } from './ledger/protocol.js';
import { certificateText, lastBackupGoneBy, parseArgs, purge, type JobRun, type PurgeDeps } from './purge.js';

const DAY = 86_400_000;
const NOW = new Date('2026-12-01T10:00:00Z');
const TENANT = '0196f3a2-1b2c-7d3e-8f40-123456789abc';

/** A purge job that keeps its steps' state, as the real one does on its row; `calls` is every command run, in order. */
function world(over: { solo?: boolean; refuse?: string; keysOp?: string | null; failAt?: string; committed?: string | null; destroy?: Result } = {}) {
  const state: Record<string, string | null> = { keys: over.keysOp ?? null, rows: null, objects: null, platform: null, certificate: null };
  const calls: string[] = [];
  const written: { name: string; json: string; text: string }[] = [];
  let finishInput = '';
  let destroyed = 0;
  const run = (json: Record<string, unknown>, status = 0): JobRun => ({ status, json, error: '' });
  const facts = () => ({
    institution: { id: TENANT, slug: 'old-poly', legalName: 'Old Polytechnic', type: 'POLYTECHNIC', status: state.platform ? 'PURGED' : 'ARCHIVED' },
    authority: over.solo ? { solo: true, reason: 'The only owner, before a second member joins' } : { solo: false, approvalId: 'a1', askedBy: 'Ada', approvedBy: 'Bola', approvedAt: '2026-11-30T09:00:00.000Z' },
    startedAt: '2026-12-01T09:00:00.000Z',
    keys: { op: state.keys, destroyedAt: state.keys ? '2026-12-01T09:01:00.000Z' : null },
    rows: { deletedAt: state.rows, perTable: state.rows ? { user_account: 3, audit_event: 5 } : null },
    objects: { deletedAt: state.objects, perBucket: state.objects ? { 'uv-clean': 2 } : null },
    platform: { deletedAt: state.platform, perTable: state.platform ? { tenant_domain: 1 } : null },
    certificate: state.certificate ? { at: state.certificate, sha256: 'f'.repeat(64) } : null,
  });
  const deps: PurgeDeps = {
    job(args, input) {
      const [cmd] = args;
      calls.push(String(cmd));
      if (over.failAt === cmd) return { status: 1, json: null, error: 'connection refused' };
      if (over.refuse && cmd === 'check') return run({ ok: false, refused: over.refuse }, 3);
      switch (cmd) {
        case 'check':
          return run({ ok: true, tenantId: TENANT, resuming: state.keys !== null, next: 'keys' });
        case 'begin':
          return run({ ok: true, purgeId: 'p1' });
        case 'facts':
          return run({ ok: true, facts: facts() });
        case 'keys-done':
          state.keys ??= String(args[3]);
          return run({ ok: true });
        case 'rows':
        case 'objects':
        case 'platform':
          if (!state.keys) return run({ ok: false, refused: 'step_out_of_order' }, 3);
          state[cmd] ??= NOW.toISOString();
          return run({ ok: true, [cmd]: {} });
        case 'finish':
          finishInput = input ?? '';
          state.certificate = NOW.toISOString();
          return run({ ok: true });
        default:
          return run({ ok: false }, 1);
      }
    },
    destroyKeys: () => {
      destroyed++;
      return Promise.resolve(over.destroy ?? { ok: true, op: 'op-new', lines: ['every key destroyed and accepted'] });
    },
    committedOp: () => over.committed ?? null,
    sets: () => [],
    write: (name, json, text) => {
      written.push({ name, json, text });
      return { json: `/p/${name}.json`, text: `/p/${name}.txt` };
    },
    log: () => undefined,
    now: () => NOW,
  };
  return { deps, calls, written, state, finishInput: () => finishInput, destroyed: () => destroyed };
}

describe('pnpm stack:purge (spec 0038 Q10, Q-C3)', () => {
  it('runs keys, rows, objects, platform and the certificate, in that order, and records the certificate it wrote', async () => {
    const w = world();
    const r = await purge(w.deps, { slug: 'old-poly', solo: false });
    expect(r.ok).toBe(true);
    expect(w.calls).toEqual(['check', 'begin', 'facts', 'keys-done', 'rows', 'objects', 'platform', 'facts', 'finish']);
    expect(w.destroyed()).toBe(1);
    expect(w.state.keys).toBe('op-new');
    const file = w.written[0];
    expect(file?.name).toBe('old-poly-2026-12-01');
    // The job is given exactly the JSON written to disk, and its hash.
    expect(w.finishInput()).toBe(file?.json);
    const cert = JSON.parse(file?.json ?? '{}') as Record<string, unknown>;
    expect(cert).toMatchObject({ format: 'univarse-purge-certificate-1', institution: { slug: 'old-poly' }, authority: { solo: false, approvedBy: 'Bola' }, keys: { op: 'op-new' }, lastBackupGoneBy: null });
    expect(cert).not.toHaveProperty('certificate');
    expect(r.lines.at(-1)).toContain(createHash('sha256').update(file?.json ?? '').digest('hex'));
  });

  it('A12: a key destruction that fails stops everything after it', async () => {
    const w = world({ destroy: { ok: false, lines: ['the ledger copies could not be brought level: nothing was destroyed'] } });
    const r = await purge(w.deps, { slug: 'old-poly', solo: false });
    expect(r.ok).toBe(false);
    expect(w.calls).toEqual(['check', 'begin', 'facts']);
    expect(r.lines.at(-1)).toMatch(/keys were not destroyed; nothing else was touched/);
  });

  it('Q-C3: keys destroyed by an earlier run but not recorded are recorded with that op, never destroyed again', async () => {
    const w = world({ committed: 'op-earlier' });
    expect((await purge(w.deps, { slug: 'old-poly', solo: false })).ok).toBe(true);
    expect(w.destroyed()).toBe(0);
    expect(w.state.keys).toBe('op-earlier');
  });

  it('resumes after the keys: the protocol is not run again', async () => {
    const w = world({ keysOp: 'op-recorded' });
    expect((await purge(w.deps, { slug: 'old-poly', solo: false })).ok).toBe(true);
    expect(w.destroyed()).toBe(0);
    expect(w.calls).not.toContain('keys-done');
  });

  it('a job that fails mid-way says to run again; a refusal says why; a complete purge only reports', async () => {
    await expect(purge(world({ failAt: 'objects' }).deps, { slug: 'old-poly', solo: false })).rejects.toThrow(/objects failed.*run the command again/);
    await expect(purge(world({ refuse: 'no_authorisation' }).deps, { slug: 'old-poly', solo: false })).rejects.toThrow('refused at check: no_authorisation');
    const done = world({ keysOp: 'op' });
    done.state.rows = done.state.objects = done.state.platform = done.state.certificate = NOW.toISOString();
    const r = await purge(done.deps, { slug: 'old-poly', solo: false });
    expect(r.ok).toBe(true);
    expect(done.calls).not.toContain('finish');
    expect(done.written).toEqual([]);
  });

  it('Q11: a solo purge passes its flags to the job and says so on the certificate', async () => {
    const w = world({ solo: true });
    const calls: (readonly string[])[] = [];
    const job = w.deps.job.bind(w.deps);
    w.deps.job = (args, input) => {
      calls.push(args);
      return job(args, input);
    };
    await purge(w.deps, { slug: 'old-poly', solo: true, reason: 'The only owner, before a second member joins' });
    expect(calls[0]).toEqual(['check', 'old-poly', '--solo', '--reason', 'The only owner, before a second member joins']);
    expect(w.written[0]?.text).toMatch(/one person \(solo\), because no second person could approve it/);
  });

  it('parses its arguments: a reason belongs to a solo purge only', () => {
    expect(parseArgs(['old-poly'])).toEqual({ slug: 'old-poly', solo: false });
    expect(parseArgs(['old-poly', '--solo', '--reason', 'why'])).toEqual({ slug: 'old-poly', solo: true, reason: 'why' });
    expect(() => parseArgs(['old-poly', '--reason', 'why'])).toThrow(/solo/);
    expect(() => parseArgs([])).toThrow(/usage/);
    expect(() => parseArgs(['--solo'])).toThrow(/usage/);
  });
});

describe('the last backup holding it (Q-C6)', () => {
  const set = (at: Date, id = at.toISOString().replace(/[-:]/g, '').slice(0, 15)): SetOnDisk => ({ setId: `${id}Z-x`, createdAt: at, index: { startWal: '000000010000000000000001' } as SetOnDisk['index'] });

  it('is none when no set was taken before the purge', () => {
    expect(lastBackupGoneBy([set(new Date(NOW.getTime() + DAY))], NOW, NOW)).toBeNull();
    expect(lastBackupGoneBy([], NOW, NOW)).toBeNull();
  });

  it('follows the retention rule itself: about 35 days with daily backups, never fewer than the 7 dailies', () => {
    const daily = Array.from({ length: 40 }, (_, i) => set(new Date(NOW.getTime() - i * DAY - 3_600_000)));
    const gone = lastBackupGoneBy(daily, NOW, NOW);
    expect(gone).not.toBeNull();
    const days = ((gone?.getTime() ?? 0) - NOW.getTime()) / DAY;
    expect(days).toBeGreaterThanOrEqual(7);
    expect(days).toBeLessThanOrEqual(42);
  });

  it('a single recent set goes once seven newer ones exist, or its week is no longer one of the four kept', () => {
    const gone = lastBackupGoneBy([set(new Date(NOW.getTime() - 3_600_000))], NOW, NOW);
    expect(gone).not.toBeNull();
    expect(((gone?.getTime() ?? 0) - NOW.getTime()) / DAY).toBeGreaterThanOrEqual(7);
  });
});

describe('the certificate as text (Q12)', () => {
  it('states the institution, the authority, each step and the backups, without overstating them', () => {
    const t = certificateText({
      institution: { id: TENANT, slug: 'old-poly', legalName: 'Old Polytechnic', type: 'POLYTECHNIC' },
      authority: { solo: false, approvalId: 'a1', askedBy: 'Ada', approvedBy: 'Bola', approvedAt: '2026-11-30' },
      keys: { op: 'op1', destroyedAt: '2026-12-01T09:01:00Z' },
      rows: { deletedAt: '2026-12-01T09:02:00Z', perTable: { user_account: 3, audit_event: 5 } },
      objects: { deletedAt: '2026-12-01T09:03:00Z', perBucket: { 'uv-clean': 2 } },
      platform: { deletedAt: '2026-12-01T09:04:00Z', perTable: { tenant_domain: 1 } },
      completedAt: '2026-12-01T09:05:00Z',
      lastBackupGoneBy: '2027-01-05',
    });
    expect(t).toContain('Old Polytechnic (old-poly, POLYTECHNIC)');
    expect(t).toContain('asked by Ada and approved by Bola');
    expect(t).toContain('8 rows deleted');
    expect(t).toContain('shred ledger op op1');
    expect(t).toMatch(/still hold its records and files, unreadable for want of its keys.*deleted by 2027-01-05/);
  });
});
