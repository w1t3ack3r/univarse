// Spec 0020 B2-4: what a scheduled run adds to `pnpm stack:backup`: it waits for the registry lock instead of failing
// at once (a deploy or a release at backup time costs a wait, not the day's set), and it appends what it prints to a
// dated log in ~/.univarse/stack/logs (owner-only), removing logs over 30 days old. Nothing it logs is secret.
import { appendFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { STACK_DIR } from '../config.js';

export const LOCK_WAIT_MS = 60 * 60_000;
export const LOCK_STEP_MS = 60_000;
export const LOG_DAYS = 30;
const LOG = /^backup-(\d{4}-\d{2}-\d{2})\.log$/;

/** A synchronous pause: the backup takes its lock before anything else, so nothing else is waiting on the loop. */
export const sleepSync = (ms: number) => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/**
 * `acquire`, retried every `stepMs` while it throws that the lock is held, for up to `waitMs`; then its last error.
 * Any other error is thrown at once: only a held lock is worth waiting for.
 */
export function acquireWaiting<L>(acquire: () => L, opts: { waitMs?: number; stepMs?: number; sleep?: (ms: number) => void; now?: () => number; log?: (l: string) => void } = {}): L {
  const { waitMs = LOCK_WAIT_MS, stepMs = LOCK_STEP_MS, sleep = sleepSync, now = Date.now, log = () => undefined } = opts;
  const until = now() + waitMs;
  let said = false;
  for (;;) {
    try {
      return acquire();
    } catch (e) {
      if (!/is locked by/.test((e as Error).message) || now() + stepMs > until) throw e;
      if (!said) log(`waiting for the registry lock (up to ${String(Math.round(waitMs / 60_000))} min): ${(e as Error).message}`);
      said = true;
      sleep(stepMs);
    }
  }
}

/** The backup's registry lock: a scheduled run waits for it (acquireWaiting), a run by hand fails at once, as before. */
export function registryLockFor<L>(acquire: (holder: string) => L, scheduled: boolean, wait: Parameters<typeof acquireWaiting>[1] = {}): (holder: string) => L {
  return (holder) => (scheduled ? acquireWaiting(() => acquire(holder), wait) : acquire(holder));
}

export const logDir = (dir = STACK_DIR) => join(dir, 'logs');
const day = (d: Date) => d.toISOString().slice(0, 10);

/** Appends lines, stamped, to today's log; removes logs whose date is over LOG_DAYS days before `now`. */
export function scheduledLog(now: () => Date = () => new Date(), dir = logDir()): (line: string) => void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const cutoff = day(new Date(now().getTime() - LOG_DAYS * 24 * 3600 * 1000));
  for (const f of readdirSync(dir)) {
    const m = LOG.exec(f);
    if (m?.[1] && m[1] < cutoff) rmSync(join(dir, f), { force: true });
  }
  return (line) => {
    const t = now();
    appendFileSync(join(dir, `backup-${day(t)}.log`), `${t.toISOString()} ${line}\n`, { mode: 0o600 });
  };
}
