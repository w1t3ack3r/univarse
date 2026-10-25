// Spec 0020 B2-4: a scheduled run waits for the registry lock, then gives up; and it keeps a dated log, 30 days long.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { acquireRegistryLock } from '../release.js';
import { acquireWaiting, registryLockFor, scheduledLog } from './scheduled.js';
import { shippedWal } from './status-deps.js';
import { parseStaged } from './wal.js';

/** A clock that only moves when the wait sleeps; a wait that never ends fails instead of hanging the run. */
function clock() {
  let t = 0;
  const slept: number[] = [];
  return {
    now: () => t,
    sleep: (ms: number) => {
      if (slept.length > 1000) throw new Error('the wait never ends');
      slept.push(ms);
      t += ms;
    },
    slept,
  };
}

describe('acquireWaiting', () => {
  it('[B2-4] waits while a deploy holds the registry lock, then takes it, saying so once', () => {
    const dir = mkdtempSync(join(tmpdir(), 'uv-lockwait-'));
    const held = acquireRegistryLock(dir, 'deploy');
    const c = clock();
    const said: string[] = [];
    let tries = 0;
    const lock = acquireWaiting(
      () => {
        if (++tries === 3) held.release();
        return acquireRegistryLock(dir, 'backup');
      },
      { now: c.now, sleep: c.sleep, log: (l) => said.push(l) },
    );
    expect(tries).toBe(3);
    expect(c.slept).toEqual([60_000, 60_000]);
    expect(said).toEqual([expect.stringMatching(/^waiting for the registry lock \(up to 60 min\): the local registry is locked by deploy/)]);
    lock.release();
  });

  it('gives up after an hour with the lock still held, with its own error', () => {
    const c = clock();
    const busy = () => {
      throw new Error('the local registry is locked by release (pid 1, since x).');
    };
    expect(() => acquireWaiting(busy, { now: c.now, sleep: c.sleep })).toThrow(/locked by release/);
    expect(c.slept).toHaveLength(60);
    expect(c.slept.reduce((a, b) => a + b, 0)).toBe(60 * 60_000);
  });

  it('[B2-4] only a scheduled backup waits; one run by hand fails at once, as before', () => {
    const dir = mkdtempSync(join(tmpdir(), 'uv-lockwait-'));
    const held = acquireRegistryLock(dir, 'release');
    const c = clock();
    expect(() => registryLockFor((h) => acquireRegistryLock(dir, h), false, { now: c.now, sleep: c.sleep })('backup')).toThrow(/locked by release/);
    expect(c.slept).toEqual([]);
    expect(() => registryLockFor((h) => acquireRegistryLock(dir, h), true, { now: c.now, sleep: c.sleep })('backup')).toThrow(/locked by release/);
    expect(c.slept).toHaveLength(60);
    held.release();
    registryLockFor((h) => acquireRegistryLock(dir, h), true)('backup').release();
  });

  it('never waits on any other error', () => {
    const c = clock();
    expect(() =>
      acquireWaiting(
        () => {
          throw new Error('EACCES: permission denied');
        },
        { now: c.now, sleep: c.sleep },
      ),
    ).toThrow(/EACCES/);
    expect(c.slept).toEqual([]);
  });
});

describe('scheduledLog', () => {
  it("[B2-4] appends stamped lines to the day's log, and removes logs over 30 days old", () => {
    const dir = mkdtempSync(join(tmpdir(), 'uv-logs-'));
    for (const d of ['2026-09-24', '2026-09-25', '2026-10-24']) writeFileSync(join(dir, `backup-${d}.log`), 'old\n');
    writeFileSync(join(dir, 'notes.txt'), 'kept: not a log');
    const now = new Date('2026-10-25T03:00:00.000Z');
    const log = scheduledLog(() => now, dir);
    log('set 20261025T030000Z-aaaa complete');
    log('exit 0');
    expect(readdirSync(dir).sort()).toEqual(['backup-2026-09-25.log', 'backup-2026-10-24.log', 'backup-2026-10-25.log', 'notes.txt']);
    expect(readFileSync(join(dir, 'backup-2026-10-25.log'), 'utf8')).toBe('2026-10-25T03:00:00.000Z set 20261025T030000Z-aaaa complete\n2026-10-25T03:00:00.000Z exit 0\n');
  });
});

describe('the WAL status reads', () => {
  it("[B2-2] the staging volume's listing: only staged names, a `.part` copy never", () => {
    expect(
      parseStaged(['1729828800.5 000000010000000000000012', '1729828900 000000010000000000000013.part', '1729829000 00000002.history', '1729829100 000000010000000000000012.00000028.backup', 'garbage', ''].join('\n')),
    ).toEqual([
      { name: '000000010000000000000012', at: new Date(1729828800500) },
      { name: '00000002.history', at: new Date(1729829000000) },
      { name: '000000010000000000000012.00000028.backup', at: new Date(1729829100000) },
    ]);
  });

  it('[B2-2] shipped WAL by timeline, with each file\'s time; none before the first ship', () => {
    const dest = mkdtempSync(join(tmpdir(), 'uv-walst-'));
    expect(shippedWal(dest)).toEqual([]);
    mkdirSync(join(dest, 'wal', '00000001'), { recursive: true });
    const f = join(dest, 'wal', '00000001', '000000010000000000000011.gz.seal');
    writeFileSync(f, 'x');
    writeFileSync(join(dest, 'wal', '00000001', 'stray.tmp'), 'x');
    utimesSync(f, new Date('2026-10-25T03:40:00Z'), new Date('2026-10-25T03:40:00Z'));
    expect(shippedWal(dest)).toEqual([{ name: '000000010000000000000011', at: new Date('2026-10-25T03:40:00Z') }]);
  });
});
