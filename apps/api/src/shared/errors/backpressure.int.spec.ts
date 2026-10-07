// ADR-026: when a shard has no free connection within the transaction wait (2 s), the API sheds the request
// with 503 server.busy and Retry-After, and logs a capacity signal, not an unhandled error (a 500 before).
// Found by the OB8 test in tracing.int.spec.ts; measured with scripts/load/session-auth.mjs (docs/07 §2).
import { Writable } from 'node:stream';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { isConnectionUnavailable, POOL_OPTIONS } from '@univarse/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../bootstrap.js';
import { loadConfig } from '../../config/config.js';
import { attachConformance } from '../../testing/conformance.js';
import { createHarness, HOSTS, PASSWORD, randomIp, type InjectResult } from '../../testing/int-harness.js';
import { ShardRegistry } from '../db/db.module.js';
import { UNAVAILABLE_RETRY_AFTER_SEC } from './problem.filter.js';

type Line = Record<string, unknown> & { event: string | null; level: string; requestId: string | null };

let h: Awaited<ReturnType<typeof createHarness>>;
let app: NestFastifyApplication;
const lines: Line[] = [];

beforeAll(async () => {
  h = await createHarness();
  const destination = new Writable({
    write(chunk: Buffer, _e, done) {
      for (const l of chunk.toString().split('\n').filter(Boolean)) lines.push(JSON.parse(l) as Line);
      done();
    },
  });
  // Its own app (own pool), so exhausting it can't disturb the harness; conformance-checked like the rest.
  app = await createApp(loadConfig({ ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'info' }), { beforeInit: attachConformance, logDestination: destination });
}, 60_000);
afterAll(async () => {
  await app.close();
  await h.close();
});

const inject = (o: { method?: 'GET' | 'POST'; url: string; cookie?: string; body?: object }): Promise<InjectResult> =>
  app
    .getHttpAdapter()
    .getInstance()
    .inject({
      method: o.method ?? 'GET',
      url: o.url,
      remoteAddress: randomIp(),
      headers: { host: HOSTS.demo, ...(o.method === 'POST' ? { 'sec-fetch-site': 'same-origin' } : {}), ...(o.cookie ? { cookie: o.cookie } : {}) },
      ...(o.body ? { payload: o.body } : {}),
    });

/**
 * Opens `n` transactions that stay open until `gate` resolves: one at a time, retrying a start that found no
 * connection in time (on a loaded machine, opening a connection can take longer than the 2 s wait).
 */
async function holdConnections(n: number, run: (body: () => Promise<void>) => Promise<unknown>, gate: Promise<void>): Promise<Promise<unknown>[]> {
  const holders: Promise<unknown>[] = [];
  for (let attempts = 0; holders.length < n; attempts++) {
    if (attempts > 5 * n) throw new Error(`Could only open ${String(holders.length)} of ${String(n)} connections`);
    let open!: () => void;
    const isOpen = new Promise<'open'>((r) => (open = () => r('open')));
    const holder = run(async () => {
      open();
      await gate;
    });
    const outcome = await Promise.race([isOpen, holder.then(() => new Error('holder ended early'), (e: unknown) => e)]);
    if (outcome === 'open') holders.push(holder);
    else if (!isConnectionUnavailable(outcome)) throw outcome;
  }
  return holders;
}

describe('[ADR-026] backpressure when a shard has no free connection', () => {
  it('answers 503 server.busy with Retry-After, logs db.connection_unavailable (no unhandled error), and recovers', { timeout: 120_000 }, async () => {
    const user = await h.makeUser('demo', { role: 'STUDENT' });
    const login = await inject({ method: 'POST', url: '/api/v1/auth/login', body: { username: user.username, password: PASSWORD } });
    const cookie = ([login.headers['set-cookie']].flat() as string[]).map((c) => c.split(';')[0]!).find((c) => c.startsWith('__Host-uv_sid='))!;
    expect((await inject({ url: '/api/v1/files', cookie })).statusCode).toBe(200);

    // Hold every connection of this app's pool for demo-uni's shard.
    const { shardId } = await h.platform.tenant.findUniqueOrThrow({ where: { id: h.tenants.demo } });
    const shards = app.get(ShardRegistry);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let holders: Promise<unknown>[] = [];
    try {
      holders = await holdConnections(
        POOL_OPTIONS.max,
        (body) =>
          shards.tx(shardId, h.tenants.demo, async (tx) => {
            await tx.$queryRaw`SELECT 1`;
            await body();
          }),
        gate,
      );

      // Session authentication is the first transaction of the request (AccessGuard), so it is the one shed.
      const res = await inject({ url: '/api/v1/files', cookie });
      expect([res.statusCode, res.json().code]).toEqual([503, 'server.busy']);
      expect(res.headers['retry-after']).toBe(String(UNAVAILABLE_RETRY_AFTER_SEC));
      expect(res.body).not.toMatch(/prisma|transaction|P2028/i); // no internals leak

      const rid = String(res.headers['x-request-id']);
      const mine = lines.filter((l) => l.requestId === rid);
      expect(mine.find((l) => l.event === 'db.connection_unavailable')?.level).toBe('warn');
      expect(mine.some((l) => l.event === 'http.unhandled_error')).toBe(false);
    } finally {
      release();
      await Promise.all(holders);
    }
    expect((await inject({ url: '/api/v1/files', cookie })).statusCode).toBe(200);
  });
});
