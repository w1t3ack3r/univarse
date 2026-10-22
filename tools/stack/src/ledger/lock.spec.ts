// Spec 0020 D14, BK14: the ledger lock, held by real processes; and the protocol's commands serialized by it.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { opStates, type Destination } from './chain.js';
import { init } from './commands.js';
import { FakeKeysDb } from './fake-keys-db.js';
import { establishAuthority } from './ledger.js';
import { acquireLedgerLock, processStartTime } from './lock.js';
import { destroy, recover, type ProtocolDeps } from './protocol.js';

const LOCK_TS = pathToFileURL(fileURLToPath(new URL('./lock.ts', import.meta.url))).href;

let root: string;
let children: ChildProcess[];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'uv-lock-'));
  children = [];
});
afterEach(() => {
  for (const c of children) c.kill('SIGKILL');
  rmSync(root, { recursive: true, force: true });
});

/** A real process holding the lock until killed (or for `holdMs`, then releasing it). Resolves once it holds it. */
function holder(holdMs?: number): Promise<{ child: ChildProcess; pid: number }> {
  const code = `
    const { acquireLedgerLock } = await import(${JSON.stringify(LOCK_TS)});
    const lock = await acquireLedgerLock(${JSON.stringify(root)}, 'child', { log: () => undefined });
    console.log('held ' + process.pid);
    ${holdMs === undefined ? 'setInterval(() => undefined, 1000);' : `setTimeout(() => { lock.release(); process.exit(0); }, ${String(holdMs)});`}
  `;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'inherit'] });
  children.push(child);
  return new Promise((resolve, reject) => {
    child.stdout.on('data', (b: Buffer) => {
      const m = /held (\d+)/.exec(b.toString());
      if (m) resolve({ child, pid: Number(m[1]) });
    });
    child.on('exit', (c) => reject(new Error(`holder exited (${String(c)}) before holding the lock`)));
  });
}
const owner = () => JSON.parse(readFileSync(join(root, '.lock', 'owner.json'), 'utf8')) as { pid: number; holder: string; token: string };

describe('[D14][BK14] the ledger lock, between real processes', { timeout: 120_000 }, () => {
  it('[BK14] a live holder is never broken: a second taker waits, then refuses, naming it', async () => {
    const { pid } = await holder();
    const before = owner();
    await expect(acquireLedgerLock(root, 'second', { waitMs: 1_500, pollMs: 100 })).rejects.toThrow(new RegExp(`locked by child \\(pid ${String(pid)}, since .*never broken while its holder runs`));
    expect(owner()).toEqual(before);
  });

  it('[BK14] a second taker waits, and takes it once the holder releases it', async () => {
    await holder(1_500);
    const t0 = Date.now();
    const lock = await acquireLedgerLock(root, 'second', { waitMs: 20_000, pollMs: 100 });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(500);
    expect(owner().holder).toBe('second');
    lock.release();
    expect(existsSync(join(root, '.lock'))).toBe(false);
  });

  it('[BK14] a stale lock (its holder killed) is taken over, and the takeover is logged', async () => {
    const { child, pid } = await holder();
    child.kill('SIGKILL');
    await new Promise((r) => child.once('exit', r));
    expect(processStartTime(pid)).toBeNull();
    const logged: string[] = [];
    const lock = await acquireLedgerLock(root, 'after', { waitMs: 10_000, log: (l) => void logged.push(l) });
    expect(logged.join()).toMatch(new RegExp(`took over a stale lock: child \\(pid ${String(pid)}`));
    expect(owner().holder).toBe('after');
    lock.release();
  });

  it('[BK14] a PID reused by another process (its start time differs) is a gone holder', async () => {
    mkdirSync(join(root, '.lock'), { recursive: true });
    // This very process is alive, but it never took this lock: its recorded start time is not its own.
    writeFileSync(join(root, '.lock', 'owner.json'), JSON.stringify({ holder: 'crashed', pid: process.pid, started: '2001-01-01T00:00:00.0000000Z', since: '2001-01-01T00:00:00Z', token: 't' }));
    const lock = await acquireLedgerLock(root, 'now', { waitMs: 10_000, log: () => undefined });
    expect(owner().holder).toBe('now');
    lock.release();
  });

  it('[BK14] release never removes another run’s lock', async () => {
    const a = await acquireLedgerLock(root, 'a', { log: () => undefined });
    writeFileSync(join(root, '.lock', 'owner.json'), JSON.stringify({ ...owner(), token: 'someone-else' }));
    a.release();
    expect(existsSync(join(root, '.lock'))).toBe(true);
  });
});

describe('[BK14] the protocol under the real lock', { timeout: 120_000 }, () => {
  const T1 = '10000000-0000-4000-8000-000000000001';
  const T2 = '10000000-0000-4000-8000-000000000002';
  let db: FakeKeysDb;
  let primary: Destination;
  const deps = (over: Partial<ProtocolDeps> = {}): ProtocolDeps => ({
    primary,
    db,
    lock: (h) => acquireLedgerLock(primary.path, h, { waitMs: 30_000, pollMs: 50, startTime: () => 'test', log: () => undefined }),
    log: () => undefined,
    ...over,
  });
  beforeEach(async () => {
    primary = { id: 'primary', path: join(root, 'primary') };
    db = new FakeKeysDb();
    db.addTenant(T1, 't1', { 1: 'ACTIVE' });
    db.addTenant(T2, 't2', { 1: 'ACTIVE' });
    expect((await init(deps(), [join(root, 'external')])).ok).toBe(true);
  });
  const entries = () => {
    const a = establishAuthority(primary);
    if (!a.ok) throw new Error(a.problems.join());
    return a.entries;
  };

  it('[BK14] two overlapping destroys of the same tenant: the second waits, then refuses, recording nothing', async () => {
    const [a, b] = await Promise.all([destroy(deps(), { slug: 't1' }), destroy(deps(), { slug: 't1' })]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect((a.ok ? b : a).lines.join()).toMatch(/refused before anything was written: nothing_to_destroy/);
    expect(entries().filter((e) => e.type === 'pending')).toHaveLength(1);
  });

  it('[BK14] for different tenants, both complete, one after the other', async () => {
    const [a, b] = await Promise.all([destroy(deps(), { slug: 't1' }), destroy(deps(), { slug: 't2' })]);
    expect(a.ok && b.ok).toBe(true);
    const types = entries().map((e) => e.type);
    // Never interleaved: each pending is followed by its own committed.
    expect(types.slice(1)).toEqual(['pending', 'committed', 'pending', 'committed']);
  });

  it('[BK14] recovery racing a destruction waits for the lock, and never acts on the pending record of a command still running', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let inside!: () => void;
    const started = new Promise<void>((r) => (inside = r));
    const slow: FakeKeysDb = Object.assign(Object.create(db) as FakeKeysDb, {
      destroy: async (op: string, slug: string, v?: number) => {
        inside();
        await gate;
        return db.destroy(op, slug, v);
      },
    });
    const destroying = destroy(deps({ db: slow }), { slug: 't1' });
    await started; // the pending record is durable, the command is in its database step
    const recovering = recover(deps());
    await new Promise((r) => setTimeout(r, 300));
    expect(db.calls.filter((c) => c.startsWith('destroy:'))).toHaveLength(0); // recovery has not rolled it forward
    release();
    expect((await destroying).ok).toBe(true);
    const r = await recovering;
    expect(r.ok).toBe(true);
    expect(db.calls.filter((c) => c.startsWith('destroy:'))).toHaveLength(1); // only the command's own
    const { ops } = opStates(entries());
    expect([...ops.values()].map((s) => s.outcome?.type)).toEqual(['committed']);
  });
});
