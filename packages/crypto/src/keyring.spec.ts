// Spec 0015 CI7: the keyring never returns or caches a stale key, and every cached key is evicted and zeroed at
// a deadline fixed at the load's start. Deterministic: a controllable unwrap, a manual clock and scheduler.
import { randomBytes } from 'node:crypto';
import type { PlatformClient } from '@univarse/db';
import { describe, expect, it, vi } from 'vitest';
import { TenantKeyring, type Schedule } from './keyring.js';
import { KeyUnavailableError, type KeyProvider } from './providers.js';

const A = '0190a000-0000-7000-8000-00000000000a';
const B = '0190b000-0000-7000-8000-00000000000b';
const TTL = 1000;

/** A platform table with one ACTIVE key per tenant; `rows` can be edited (e.g. destroyed) mid-test. */
function platformWith(tenants: string[]) {
  const rows = tenants.map((tenantId) => ({
    tenantId,
    version: 1,
    status: 'ACTIVE',
    wrappedDek: `wrapped-${tenantId}` as string | null,
  }));
  const findUnique = vi.fn(
    ({ where }: { where: { tenantId_version: { tenantId: string; version: number } } }) =>
      Promise.resolve(
        rows.find(
          (r) =>
            r.tenantId === where.tenantId_version.tenantId &&
            r.version === where.tenantId_version.version,
        ) ?? null,
      ),
  );
  const platform = {
    tenantDataKey: { findUnique, findFirst: vi.fn() },
  } as unknown as PlatformClient;
  const destroy = (t: string) => {
    const r = rows.find((x) => x.tenantId === t)!;
    r.status = 'DESTROYED';
    r.wrappedDek = null;
  };
  return { platform, findUnique, destroy };
}

/** An unwrap whose every call waits until the test resolves it; each resolution is a fresh 32-byte buffer. */
function heldProvider() {
  const pending: { resolve: (b: Buffer) => void; buffer: Buffer }[] = [];
  const provider = {
    unwrap: vi.fn(
      () =>
        new Promise<Buffer>((resolve) => {
          pending.push({ resolve, buffer: randomBytes(32) });
        }),
    ),
  } as unknown as KeyProvider;
  /** Resolves the i-th unwrap call; returns the buffer it handed over. */
  const finish = async (i: number) => {
    await vi.waitFor(() => expect(pending.length).toBeGreaterThan(i));
    const p = pending[i]!;
    p.resolve(p.buffer);
    return p.buffer;
  };
  return { provider, finish, calls: () => pending.length };
}

/** A manual scheduler: records each timer; `fire` runs it unless cancelled. */
function manualSchedule() {
  const timers: { fn: () => void; ms: number; cancelled: boolean }[] = [];
  const schedule: Schedule = (fn, ms) => {
    const t = { fn, ms, cancelled: false };
    timers.push(t);
    return () => {
      t.cancelled = true;
    };
  };
  const fire = (i: number) => {
    const t = timers[i]!;
    if (!t.cancelled) t.fn();
  };
  return { schedule, timers, fire };
}

const zeroed = (b: Buffer) => b.every((x) => x === 0);

describe('[CI7] the keyring: no stale load', () => {
  it('[CI7] forget() during a pending unwrap: the old buffer is never returned or cached, and is zeroed; a fresh load re-reads status', async () => {
    const { platform, findUnique, destroy } = platformWith([A]);
    const held = heldProvider();
    const clock = { now: 0 };
    const ring = new TenantKeyring(platform, held.provider, {
      ttlMs: TTL,
      now: () => clock.now,
      schedule: manualSchedule().schedule,
    });

    const pending = ring.key(A, 1);
    await vi.waitFor(() => expect(held.calls()).toBe(1));
    ring.forget(A); // e.g. the key was just destroyed
    destroy(A);
    const old = await held.finish(0);

    await expect(pending).rejects.toMatchObject({ reason: 'key_destroyed' });
    expect(zeroed(old)).toBe(true);
    expect(ring.size).toBe(0);
    expect(findUnique).toHaveBeenCalledTimes(2); // the retry re-read the key's status
  });

  it('[CI7] forget() during a pending unwrap of a LIVE key: the caller gets a freshly unwrapped key, not the old one', async () => {
    const { platform } = platformWith([A]);
    const held = heldProvider();
    const ring = new TenantKeyring(platform, held.provider, {
      ttlMs: TTL,
      now: () => 0,
      schedule: manualSchedule().schedule,
    });
    const pending = ring.key(A, 1);
    await vi.waitFor(() => expect(held.calls()).toBe(1));
    ring.forget(A);
    const old = await held.finish(0);
    const fresh = await held.finish(1);
    const got = await pending;
    expect(got).toBe(fresh);
    expect(got).not.toBe(old);
    expect(zeroed(old)).toBe(true);
    expect(ring.size).toBe(1);
  });

  it('[CI7] an unwrap that finishes after the FULL TTL is zeroed and discarded; the retry re-reads the status in the DB', async () => {
    const { platform, findUnique, destroy } = platformWith([A]);
    const held = heldProvider();
    const clock = { now: 0 };
    const ring = new TenantKeyring(platform, held.provider, {
      ttlMs: TTL,
      now: () => clock.now,
      schedule: manualSchedule().schedule,
    });
    const pending = ring.key(A, 1);
    await vi.waitFor(() => expect(held.calls()).toBe(1));
    clock.now = TTL + 5; // the unwrap outlived its whole deadline
    destroy(A); // and the key was destroyed meanwhile
    const late = await held.finish(0);
    await expect(pending).rejects.toBeInstanceOf(KeyUnavailableError);
    expect(zeroed(late)).toBe(true);
    expect(ring.size).toBe(0);
    expect(findUnique).toHaveBeenCalledTimes(2);
  });

  it('[CI7] a provider always slower than the TTL fails after bounded restarts instead of looping', async () => {
    const { platform } = platformWith([A]);
    const clock = { now: 0 };
    const unwrap = vi.fn(() => ((clock.now += TTL + 1), Promise.resolve(randomBytes(32))));
    const provider = { unwrap } as unknown as KeyProvider;
    const ring = new TenantKeyring(platform, provider, {
      ttlMs: TTL,
      now: () => clock.now,
      schedule: manualSchedule().schedule,
    });
    await expect(ring.key(A, 1)).rejects.toMatchObject({ reason: 'provider_unavailable' });
    expect(ring.size).toBe(0);
    expect(unwrap).toHaveBeenCalledTimes(3); // the first load and exactly two restarts
  });
});

describe('[CI7] the keyring: a hard deadline from the load’s start', () => {
  it('[CI7] an idle cached key is evicted and zeroed at its deadline, with no lookup', async () => {
    const { platform } = platformWith([A]);
    const held = heldProvider();
    const timers = manualSchedule();
    const ring = new TenantKeyring(platform, held.provider, {
      ttlMs: TTL,
      now: () => 0,
      schedule: timers.schedule,
    });
    const pending = ring.key(A, 1);
    const key = await held.finish(0);
    await pending;
    expect(ring.size).toBe(1);
    expect(timers.timers).toHaveLength(1);
    timers.fire(0); // the deadline passes; nobody looks the key up
    expect(ring.size).toBe(0);
    expect(zeroed(key)).toBe(true);
  });

  it('[CI7] a load delayed past half the TTL still expires at load start + TTL', async () => {
    const { platform } = platformWith([A]);
    const held = heldProvider();
    const timers = manualSchedule();
    const clock = { now: 100 };
    const ring = new TenantKeyring(platform, held.provider, {
      ttlMs: TTL,
      now: () => clock.now,
      schedule: timers.schedule,
    });
    const pending = ring.key(A, 1);
    await vi.waitFor(() => expect(held.calls()).toBe(1));
    clock.now = 100 + 600; // more than half the TTL spent in the unwrap
    await held.finish(0);
    await pending;
    expect(timers.timers[0]!.ms).toBe(100 + TTL - (100 + 600)); // fires at start + TTL, not at end + TTL
    clock.now = 100 + TTL; // at the deadline, a lookup misses
    const again = ring.key(A, 1);
    await held.finish(1);
    await again;
    expect(held.calls()).toBe(2);
  });
});

describe('[CI7] the keyring: old callbacks never touch a replacement', () => {
  it('[CI7] a stale load’s completion and cleanup never remove or zero the newer entry', async () => {
    const { platform } = platformWith([A]);
    const held = heldProvider();
    const ring = new TenantKeyring(platform, held.provider, {
      ttlMs: TTL,
      now: () => 0,
      schedule: manualSchedule().schedule,
    });
    const first = ring.key(A, 1); // load #0, generation 0
    await vi.waitFor(() => expect(held.calls()).toBe(1));
    ring.forget(A); // generation 1
    const second = ring.key(A, 1); // load #1, generation 1
    await vi.waitFor(() => expect(held.calls()).toBe(2));
    const newer = await held.finish(1);
    expect(await second).toBe(newer);
    expect(ring.size).toBe(1);

    await held.finish(0); // the OLD load completes after the replacement is cached
    const restarted = await first; // its caller is served from the newer entry, not the old buffer
    expect(restarted).toBe(newer);
    expect(ring.size).toBe(1);
    expect(zeroed(newer)).toBe(false);
    expect(await ring.key(A, 1)).toBe(newer);
  });

  it('[CI7] an old entry’s expiry timer never removes or zeroes the entry that replaced it', async () => {
    const { platform } = platformWith([A]);
    const held = heldProvider();
    const timers = manualSchedule();
    const clock = { now: 0 };
    const ring = new TenantKeyring(platform, held.provider, {
      ttlMs: TTL,
      now: () => clock.now,
      schedule: timers.schedule,
    });
    const p1 = ring.key(A, 1);
    const old = await held.finish(0);
    await p1;
    clock.now = TTL; // expired: the next lookup evicts it and loads a replacement
    const p2 = ring.key(A, 1);
    const newer = await held.finish(1);
    await p2;
    // Fire the OLD timer late (e.g. it was already queued): the newer entry must survive.
    timers.timers[0]!.cancelled = false;
    timers.fire(0);
    expect(zeroed(old)).toBe(true);
    expect(zeroed(newer)).toBe(false);
    expect(ring.size).toBe(1);
    expect(await ring.key(A, 1)).toBe(newer);
  });

  it('[CI7][CI8] forget(A) never evicts, zeroes or reloads B', async () => {
    const { platform, findUnique } = platformWith([A, B]);
    const held = heldProvider();
    const ring = new TenantKeyring(platform, held.provider, {
      ttlMs: TTL,
      now: () => 0,
      schedule: manualSchedule().schedule,
    });
    const pa = ring.key(A, 1);
    await held.finish(0);
    await pa;
    const pb = ring.key(B, 1);
    const bKey = await held.finish(1);
    await pb;
    findUnique.mockClear();
    ring.forget(A);
    expect(await ring.key(B, 1)).toBe(bKey);
    expect(zeroed(bKey)).toBe(false);
    expect(findUnique).not.toHaveBeenCalled(); // no extra DB read for B
    expect(held.calls()).toBe(2); // no extra unwrap for B
  });
});
