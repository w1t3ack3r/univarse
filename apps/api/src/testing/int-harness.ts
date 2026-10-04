// Shared integration-test harness: real DBs + Valkey, captured email, per-run unique users.
import { randomBytes, randomInt } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  createPlatformClient,
  createTenantShardClient,
  forTenant,
  type PlatformClient,
  type TenantShardClient,
} from '@univarse/db';
import { createApp } from '../bootstrap.js';
import { loadConfig } from '../config/config.js';
import { hashPassword } from '../modules/identity/password.js';
import type { OutboundEmail } from '../shared/infra/mailer.js';
import { OutboxWorker, type BatchCounts } from '../shared/outbox/outbox-worker.js';
import { WorkerModule } from '../worker.module.js';

const rootEnv = new URL('../../../../.env', import.meta.url);
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

export const HOSTS = { demo: 'demo-uni.univarse.localhost', poly: 'test-poly.univarse.localhost' } as const;
export const PASSWORD = 'Correct-Horse-Battery-9';

export const randomIp = () => `10.${randomInt(255)}.${randomInt(255)}.${randomInt(1, 255)}`;
export const cookieFrom = (setCookie: string | string[] | undefined): string => {
  const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  if (!raw) throw new Error('No Set-Cookie header');
  return raw.split(';')[0]!;
};
export const codeIn = (mail: OutboundEmail | undefined): string => {
  const m = mail && /\b(\d{6})\b/.exec(mail.text);
  if (!m) throw new Error('No 6-digit code in email');
  return m[1]!;
};

/** The subset of light-my-request's response the tests use. */
export interface InjectResult {
  statusCode: number;
  headers: Record<string, string | string[] | number | undefined>;
  body: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
  json(): any;
}

export interface Harness {
  app: NestFastifyApplication;
  shard: TenantShardClient;
  platform: PlatformClient;
  tenants: { demo: string; poly: string };
  /** Emails the worker delivered (the capture mailer's inbox). */
  outbox: OutboundEmail[];
  /** The outbox worker, in-process, sending to the capture mailer. */
  worker: OutboxWorker;
  /** The worker's Nest context (its own ProductService cache, like the real worker process). */
  workerCtx: INestApplicationContext;
  /** Runs the worker until nothing is due. Email is delivered by the worker, never by requests (spec 0002 B7). */
  deliver(): Promise<BatchCounts>;
  run: string;
  mailsTo(address: string): OutboundEmail[];
  /** Waits until `address` has more than `after` emails matching `subject`; returns the newest. Email is async. */
  waitForMail(address: string, subject: RegExp, after: number): Promise<OutboundEmail>;
  call(
    method: 'GET' | 'POST' | 'PUT',
    host: string,
    url: string,
    o?: { cookie?: string; ip?: string; body?: unknown; headers?: Record<string, string> },
  ): Promise<InjectResult>;
  login(host: string, username: string, password?: string): Promise<InjectResult>;
  makeUser(
    tenant: 'demo' | 'poly',
    opts: { role: string; username?: string; status?: 'ACTIVE' | 'PENDING_ACTIVATION' | 'DISABLED' | 'LOCKED'; email?: string | null },
  ): Promise<{ id: string; username: string; email: string | null }>;
  close(): Promise<void>;
}

/**
 * @param opts.mailDelayMs simulated SMTP latency. The default in-memory mailer is instant, which hides
 *   timing differences that real SMTP would expose; timing tests must set a realistic delay.
 */
export async function createHarness(opts: { mailDelayMs?: number } = {}): Promise<Harness> {
  const outbox: OutboundEmail[] = [];
  const platform = createPlatformClient(process.env.PLATFORM_DATABASE_URL!);
  const shard = createTenantShardClient(process.env.TENANT_POOL_01_DATABASE_URL!);
  const tenants = {
    demo: (await platform.tenant.findUniqueOrThrow({ where: { slug: 'demo-uni' } })).id,
    poly: (await platform.tenant.findUniqueOrThrow({ where: { slug: 'test-poly' } })).id,
  };
  const config = loadConfig({ ...process.env, NODE_ENV: 'test' });
  const app = await createApp(config);
  const workerCtx: INestApplicationContext = await NestFactory.createApplicationContext(
    WorkerModule.forRoot(config, {
      mailer: {
        send: async (m) => {
          if (opts.mailDelayMs) await new Promise((r) => setTimeout(r, opts.mailDelayMs));
          outbox.push(m);
        },
      },
    }),
    { logger: false },
  );
  const worker = workerCtx.get(OutboxWorker);
  const deliver = async (): Promise<BatchCounts> => {
    const total: BatchCounts = { claimed: 0, sent: 0, retried: 0, dead: 0 };
    for (;;) {
      const c = await worker.runOnce();
      for (const k of Object.keys(total) as (keyof BatchCounts)[]) total[k] += c[k];
      if (c.claimed === 0) return total;
    }
  };
  const run = randomBytes(3).toString('hex').toUpperCase();
  const created: { tenantId: string; userId: string }[] = [];

  const call: Harness['call'] = async (method, host, url, o = {}) =>
    app.getHttpAdapter().getInstance().inject({
      method,
      url,
      remoteAddress: o.ip ?? randomIp(),
      headers: {
        host,
        ...(method !== 'GET' ? { 'sec-fetch-site': 'same-origin' } : {}),
        ...(o.cookie ? { cookie: o.cookie } : {}),
        ...o.headers,
      },
      ...(o.body !== undefined ? { payload: o.body as object } : {}),
    });

  return {
    app,
    shard,
    platform,
    tenants,
    outbox,
    worker,
    workerCtx,
    deliver,
    run,
    mailsTo: (address) => outbox.filter((m) => m.to === address),
    async waitForMail(address, subject, after) {
      const deadline = Date.now() + 5_000;
      for (;;) {
        const matching = outbox.filter((m) => m.to === address && subject.test(m.subject));
        if (matching.length > after) return matching.at(-1)!;
        await deliver();
        if (Date.now() > deadline) throw new Error(`No new ${subject} email for ${address} within 5s`);
        await new Promise((r) => setTimeout(r, 25));
      }
    },
    call,
    login: (host, username, password = PASSWORD) =>
      call('POST', host, '/api/v1/auth/login', { body: { username, password } }),
    async makeUser(tenant, opts) {
      const tenantId = tenants[tenant];
      const db = forTenant(shard, tenantId);
      const username = opts.username ?? `T${run}-${randomBytes(3).toString('hex').toUpperCase()}`;
      const email = opts.email === undefined ? `${username.toLowerCase()}@test.local` : opts.email;
      const status = opts.status ?? 'ACTIVE';
      const user = await db.userAccount.create({
        data: {
          tenantId,
          username,
          email,
          displayName: 'Test User',
          status,
          passwordHash: status === 'PENDING_ACTIVATION' ? null : await hashPassword(PASSWORD),
        },
      });
      const role = await db.role.findUniqueOrThrow({ where: { tenantId_key: { tenantId, key: opts.role } } });
      await db.roleAssignment.create({ data: { tenantId, userId: user.id, roleId: role.id, scopeType: 'INSTITUTION' } });
      created.push({ tenantId, userId: user.id });
      return { id: user.id, username, email };
    },
    async close() {
      for (const c of created) await forTenant(shard, c.tenantId).userAccount.deleteMany({ where: { id: c.userId } });
      await shard.$disconnect();
      await platform.$disconnect();
      await app.close();
      await workerCtx.close();
    },
  };
}
