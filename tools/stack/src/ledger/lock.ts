// Spec 0020 D14 (A2-9): the ledger lock, a host-side, cross-process exclusive lock at ~/.univarse/ledger/.lock. The same
// mechanism as the registry lock (spec 0013 LR8): a directory created atomically, holding owner.json. Unlike it, a lock
// whose holder is gone may be taken over: gone means no process has that PID with that start time. A live holder's
// lock is never broken. A second taker waits, then refuses, naming the holder; it never interleaves.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LOCK_DIR } from './store.js';

export interface LockOwner {
  readonly holder: string;
  readonly pid: number;
  /** The holder process's start time as the OS reports it: a reused PID has another. */
  readonly started: string;
  readonly since: string;
  readonly token: string;
}

/** The start time of a running process, or null when no process has that PID. */
export function processStartTime(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform === 'win32') {
    // Explicit answers only: GONE, UNREADABLE (another user's process, say) or the time. A process whose start time
    // can't be read is never taken for a gone one: that would break a live holder's lock.
    const script = [
      `$p = Get-Process -Id ${String(pid)} -ErrorAction SilentlyContinue`,
      "if ($null -eq $p) { 'GONE'; exit 0 }",
      "try { $p.StartTime.ToUniversalTime().ToString('o') } catch { 'UNREADABLE' }",
      'exit 0',
    ].join('; ');
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 15_000 });
    const out = r.stdout.trim();
    if (r.status !== 0 || !out || out === 'UNREADABLE') throw new Error(`could not read the start time of process ${String(pid)}: the lock is left as it is`);
    return out === 'GONE' ? null : out;
  }
  // Elsewhere there is no /proc: a missing file would make every holder look gone, and break a live lock.
  if (process.platform !== 'linux') throw new Error(`the ledger lock reads process start times on Windows and Linux only, not ${process.platform}`);
  try {
    // /proc/<pid>/stat: field 22 is the start time in clock ticks since boot (after the parenthesised command name).
    const stat = readFileSync(`/proc/${String(pid)}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? null;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

export interface LockOptions {
  /** How long a second taker waits before refusing. */
  readonly waitMs?: number;
  readonly pollMs?: number;
  readonly pid?: number;
  readonly startTime?: (pid: number) => string | null;
  readonly log?: (line: string) => void;
}

export interface LedgerLock {
  readonly owner: LockOwner;
  release(): void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Takes the ledger lock in `root` (the primary destination's directory) for `holder`. */
export async function acquireLedgerLock(root: string, holder: string, opts: LockOptions = {}): Promise<LedgerLock> {
  const { waitMs = 30_000, pollMs = 250, pid = process.pid, startTime = processStartTime, log = (l) => console.log(l) } = opts;
  const lock = join(root, LOCK_DIR);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const ownStart = startTime(pid);
  if (!ownStart) throw new Error(`cannot read this process's own start time (pid ${String(pid)})`);
  const deadline = Date.now() + waitMs;
  let seen: LockOwner | null;
  for (;;) {
    try {
      mkdirSync(lock); // atomic: exactly one concurrent caller succeeds
      const owner: LockOwner = { holder, pid, started: ownStart, since: new Date().toISOString(), token: randomUUID() };
      writeFileSync(join(lock, 'owner.json'), `${JSON.stringify(owner)}\n`, { mode: 0o600 });
      return { owner, release: () => release(lock, owner.token) };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    seen = readOwner(lock);
    // A holder that is gone: no process with its PID, or one with another start time (the PID was reused).
    if (seen && startTime(seen.pid) !== seen.started) {
      // Takeovers are serialized by their own atomic directory, and the owner is read again inside it: otherwise a
      // slower taker could move aside the lock a faster one had just taken over.
      const takeover = `${lock}.takeover`;
      let mine = false;
      try {
        mkdirSync(takeover);
        mine = true;
        const again = readOwner(lock);
        if (again?.token === seen.token && startTime(again.pid) !== again.started) {
          const aside = `${lock}.stale-${seen.token}`;
          renameSync(lock, aside);
          log(`[ledger lock] took over a stale lock: ${describe(seen)} is gone (moved aside to ${aside})`);
          rmSync(aside, { recursive: true, force: true });
        }
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        await sleep(pollMs); // another takeover is in progress
      } finally {
        if (mine) rmSync(takeover, { recursive: true, force: true });
      }
      if (Date.now() < deadline) continue;
    }
    if (Date.now() >= deadline) break;
    await sleep(pollMs);
  }
  throw new Error(
    `the ledger is locked by ${seen ? describe(seen) : 'a holder still writing its owner file'}; waited ${String(Math.round(waitMs / 1000))} s. ` +
      'It is never broken while its holder runs: wait for it to finish.',
  );
}

function readOwner(lock: string): LockOwner | null {
  try {
    return JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8')) as LockOwner;
  } catch {
    return null; // being written (or torn by a crash in that instant): treated as held
  }
}

const describe = (o: LockOwner) => `${o.holder} (pid ${String(o.pid)}, since ${o.since})`;

function release(lock: string, token: string): void {
  const o = readOwner(lock);
  if (o?.token !== token) return; // not ours any more: never remove another run's lock
  rmSync(lock, { recursive: true, force: true });
}
