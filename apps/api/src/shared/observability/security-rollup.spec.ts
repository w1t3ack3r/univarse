// Spec 0031 Q8, Q9, Q10: the security counts. They're bounded, hold only an event's name and its institution, never
// wait on the database in a request, and a failing write ends in a log line.
import { Writable } from 'node:stream';
import { Logger } from '@nestjs/common';
import type { PlatformClient } from '@univarse/db';
import { isClassifiedSecurityEvent } from '@univarse/domain';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { backgroundPass } from './background.js';
import { createLogger, setSecurityEventSink } from './logger.js';
import { NO_TENANT, SecurityEventCounts, SecurityRollupWriter } from './security-rollup.js';
import { SECURITY_EVENTS, securityFields } from './security.js';

const T = '01a1b1d7-4639-720c-baed-d5e2a86521bb';
const AT = new Date('2026-11-07T10:15:42.123Z');
const EVENT = 'auth.account.locked';
const fakeDb = (run: () => Promise<number> = () => Promise.resolve(1)) => {
  const calls: unknown[][] = [];
  return {
    calls,
    $executeRaw: (_q: TemplateStringsArray, ...values: unknown[]) => {
      calls.push(values);
      return run();
    },
  } as unknown as PlatformClient & { calls: unknown[][] };
};

afterEach(() => {
  setSecurityEventSink(null);
  vi.restoreAllMocks();
});

describe('[0031 Q8] the counts', () => {
  it('add up per minute, event and institution', () => {
    const c = new SecurityEventCounts();
    c.add(EVENT, T, AT);
    c.add(EVENT, T, new Date(AT.getTime() + 1_000));
    c.add(EVENT, T, new Date(AT.getTime() + 60_000));
    c.add('http.csrf_rejected', T, AT);
    const rows = c.drain();
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({ minute: new Date('2026-11-07T10:15:00.000Z'), event: EVENT, tenantId: T, count: 2, lastSeenAt: new Date(AT.getTime() + 1_000) });
    expect(c.drain()).toEqual([]);
  });

  it('an event without a valid institution belongs to none', () => {
    const c = new SecurityEventCounts();
    for (const t of [undefined, null, 'demo-uni', "'; DROP TABLE x;--"]) c.add(EVENT, t, AT);
    expect(c.drain()).toEqual([expect.objectContaining({ tenantId: NO_TENANT, count: 4 })]);
  });

  it('only events the code declares are counted, so nothing else can become a key', () => {
    const c = new SecurityEventCounts();
    for (const e of ['made.up', '', 42, null, { event: EVENT }]) c.add(e, T, AT);
    expect(c.drain()).toEqual([]);
  });

  it('is bounded: past the cap it drops and counts what it dropped, and existing keys still add up', () => {
    const c = new SecurityEventCounts(2);
    c.add(EVENT, T, AT);
    c.add('http.csrf_rejected', T, AT);
    c.add('auth.rate_limited', T, AT);
    c.add('auth.rate_limited', T, AT);
    c.add(EVENT, T, AT);
    expect(c.dropped).toBe(2);
    expect(c.drain().map((r) => [r.event, r.count])).toEqual([
      [EVENT, 2],
      ['http.csrf_rejected', 1],
    ]);
  });

  it('a row holds nothing but its key, its count and its time', () => {
    const c = new SecurityEventCounts();
    c.add(EVENT, T, AT);
    expect(Object.keys(c.drain()[0] ?? {}).sort()).toEqual(['count', 'event', 'lastSeenAt', 'minute', 'tenantId']);
  });
});

describe('[0031 Q9] the tap on the logger', () => {
  const silent = () => createLogger({ service: 'api', env: 'test', version: 't', destination: new Writable({ write: (_c, _e, cb) => { cb(); } }) });

  it('sees every security line, and nothing else', () => {
    const seen: unknown[][] = [];
    setSecurityEventSink((event, tenantId) => seen.push([event, tenantId]));
    const log = silent();
    log.warn(securityFields(EVENT, { tenantId: T, userId: 'someone' }), 'locked');
    log.warn({ event: 'something.else' }, 'not a security line');
    log.info('plain');
    expect(seen).toEqual([[EVENT, T]]);
  });

  it("a sink that throws can't break logging, or the request that logged", () => {
    setSecurityEventSink(() => {
      throw new Error('boom');
    });
    expect(() => silent().warn(securityFields(EVENT), 'locked')).not.toThrow();
  });
});

describe('[0031 Q9, Q10] the writer', () => {
  it('writes everything in one statement, with its source', async () => {
    const db = fakeDb();
    const w = new SecurityRollupWriter(db, 'api');
    w.counts.add(EVENT, T, AT);
    w.counts.add('http.csrf_rejected', null, AT);
    expect(await w.flush()).toBe(2);
    expect(db.calls).toHaveLength(1);
    expect(db.calls[0]?.[0]).toBe('api');
    expect(db.calls[0]?.[2]).toEqual([EVENT, 'http.csrf_rejected']);
  });

  it('writes nothing when there is nothing to write', async () => {
    const db = fakeDb();
    expect(await new SecurityRollupWriter(db, 'api').flush()).toBe(0);
    expect(db.calls).toEqual([]);
  });

  it('a failed write keeps its rows for the next flush, so nothing is lost or counted twice', async () => {
    let fail = true;
    const db = fakeDb(() => (fail ? Promise.reject(new Error('down')) : Promise.resolve(1)));
    const w = new SecurityRollupWriter(db, 'api');
    w.counts.add(EVENT, T, AT);
    await expect(w.flush()).rejects.toThrow('down');
    w.counts.add(EVENT, T, AT);
    fail = false;
    await w.flush();
    expect(db.calls[1]?.[4]).toEqual([2]);
  });

  it("reports what the buffer dropped, once", async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const w = new SecurityRollupWriter(fakeDb(), 'api');
    w.counts.dropped = 5;
    await w.flush();
    await w.flush();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatchObject({ event: 'security.rollup.dropped', dropped: 5 });
  });

  it('a process that opted out (tests, CLI jobs) records nothing', () => {
    const seen = vi.fn();
    new SecurityRollupWriter(fakeDb(), null).onApplicationBootstrap();
    setSecurityEventSink(seen);
    expect(seen).not.toHaveBeenCalled();
  });

  it('counting in a request never touches the database', () => {
    const db = fakeDb();
    const w = new SecurityRollupWriter(db, 'api');
    w.onApplicationBootstrap();
    const log = createLogger({ service: 'api', env: 'test', version: 't', destination: new Writable({ write: (_c, _e, cb) => { cb(); } }) });
    for (let i = 0; i < 1_000; i++) log.warn(securityFields(EVENT, { tenantId: T }), 'locked');
    expect(db.calls).toEqual([]);
    void w.onApplicationShutdown();
  });

  it('shutting down writes what is held, and survives a dead database', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const db = fakeDb(() => Promise.reject(Object.assign(new Error('down'), { code: 'P2028' })));
    const w = new SecurityRollupWriter(db, 'api');
    w.onApplicationBootstrap();
    w.counts.add(EVENT, T, AT);
    await expect(w.onApplicationShutdown()).resolves.toBeUndefined();
    expect(warn.mock.calls[0]?.[0]).toMatchObject({ event: 'security.rollup.pass_failed', reason: 'P2028' });
  });
});

describe('[0031 Q10] a background pass', () => {
  it('ends a failure in a log line, by its code, never its message', async () => {
    const warn = vi.fn();
    const err = Object.assign(new Error('value: secret@example.ng'), { code: 'P2028' });
    await expect(backgroundPass({ warn }, 'x.failed', () => Promise.reject(err))).resolves.toBeUndefined();
    expect(warn.mock.calls[0]?.[0]).toEqual({ event: 'x.failed', reason: 'P2028' });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret@example.ng');
  });

  it('falls back to the error type, and survives something that is not an error', async () => {
    const warn = vi.fn();
    await backgroundPass({ warn }, 'x.failed', () => Promise.reject(new TypeError('nope')));
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the point: a rejection that isn't an Error
    await backgroundPass({ warn }, 'x.failed', () => Promise.reject(null));
    expect(warn.mock.calls.map((c) => (c[0] as { reason: string }).reason)).toEqual(['TypeError', 'unknown']);
  });

  it('a pass that works logs nothing', async () => {
    const warn = vi.fn();
    await backgroundPass({ warn }, 'x.failed', () => Promise.resolve());
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('[0031 Q12] every event is classified', () => {
  it('each declared event has a level of its own, not the default', () => {
    expect(SECURITY_EVENTS.filter((e) => !isClassifiedSecurityEvent(e))).toEqual([]);
  });
});
