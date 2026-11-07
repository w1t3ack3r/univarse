/**
 * Spec 0031 Q11: a statement PostgreSQL refuses becomes a security event, through a real refusal: a tenant session
 * inserting a row for another tenant, stopped by RLS. The row is never written, so nothing is left behind.
 */
import { Writable } from 'node:stream';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { Logger } from '@nestjs/common';
import { createPlatformClient, createTenantShardClient, forTenant, isConnectionUnavailable, isPermissionRefused } from '@univarse/db';
import type { ArgumentsHost } from '@nestjs/common';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createLogger, setSecurityEventSink } from '../observability/logger.js';
import { SecurityEventCounts } from '../observability/security-rollup.js';
import { ProblemFilter } from './problem.filter.js';

const rootEnv = new URL('../../../../../.env', import.meta.url);
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const shard = createTenantShardClient(process.env.TENANT_POOL_01_DATABASE_URL ?? 'postgresql://unset');
const platform = createPlatformClient(process.env.PLATFORM_DATABASE_URL ?? 'postgresql://unset');
let refused: unknown;

/** The real thing: tenant A's session asking to write tenant B's row. */
beforeAll(async () => {
  const [a, b] = await platform.tenant.findMany({ take: 2, select: { id: true } });
  if (!a || !b) throw new Error('needs the two seeded tenants: run pnpm db:seed');
  refused = await forTenant(shard, a.id)
    .userAccount.create({ data: { tenantId: b.id, username: `rls-${randomBytes(4).toString('hex')}`, displayName: 'Never written', status: 'PENDING_ACTIVATION' } })
    .then(
      () => null,
      (e: unknown) => e,
    );
});
afterAll(async () => {
  await shard.$disconnect();
  await platform.$disconnect();
});
afterEach(() => {
  setSecurityEventSink(null);
  vi.restoreAllMocks();
});

const host = () => {
  const reply = { status: vi.fn().mockReturnThis(), header: vi.fn().mockReturnThis(), send: vi.fn() };
  const req = { id: 'r1', method: 'POST', routeOptions: { url: '/api/v1/users' } };
  return { reply, host: { switchToHttp: () => ({ getRequest: () => req, getResponse: () => reply }) } as unknown as ArgumentsHost };
};

describe('[0031 Q11] a statement the database refuses', () => {
  it('the error is recognised, and is nothing else', () => {
    expect(refused).toBeTruthy();
    expect(isPermissionRefused(refused)).toBe(true);
    expect(isConnectionUnavailable(refused)).toBe(false);
    expect(isPermissionRefused(new Error('permission denied'))).toBe(false);
    expect(isPermissionRefused(null)).toBe(false);
  });

  it('logs the security event with its route, never the query, and still logs the error for whoever debugs it', () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const h = host();
    new ProblemFilter().catch(refused, h.host);
    const lines = error.mock.calls.map((c) => c[0] as { event: string; stream?: string; route?: string });
    expect(lines.map((l) => l.event)).toEqual(['db.rls_violation', 'http.unhandled_error']);
    expect(lines[0]).toMatchObject({ stream: 'security', method: 'POST', route: '/api/v1/users' });
    expect(JSON.stringify(lines[0])).not.toMatch(/user_account|INSERT|row-level/i);
    expect(h.reply.status).toHaveBeenCalledWith(500);
  });

  it('reaches the counts, through the logger, as any security line does', () => {
    const counts = new SecurityEventCounts();
    setSecurityEventSink((event, tenantId) => {
      counts.add(event, tenantId, new Date());
    });
    const log = createLogger({ service: 'api', env: 'test', version: 't', destination: new Writable({ write: (_c, _e, cb) => { cb(); } }) });
    vi.spyOn(Logger.prototype, 'error').mockImplementation((message: unknown) => {
      log.error(message as object);
    });
    new ProblemFilter().catch(refused, host().host);
    expect(counts.drain().map((r) => [r.event, r.count])).toEqual([['db.rls_violation', 1]]);
  });

  it('an ordinary error logs no such event', () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    new ProblemFilter().catch(new Error('boom'), host().host);
    expect(error.mock.calls.map((c) => (c[0] as { event: string }).event)).toEqual(['http.unhandled_error']);
  });
});
