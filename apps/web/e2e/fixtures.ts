// E2E fixtures: real API + DB (spec 0005 W10). Users are created per run with known credentials.
// Helpers come from the API source so hashing and TOTP match the server exactly.
import { createHmac, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createPlatformClient, createTenantShardClient, forTenant } from '@univarse/db';
// API source (not dist): plain functions, no decorators; keeps hashing and TOTP identical to the server.
import { hashPassword } from '../../api/src/modules/identity/password.js';
import { enrolTestTotp, resetReplayGuard, totpCode } from '../../api/src/testing/mfa-helpers.js';

const rootEnv = new URL('../../../.env', import.meta.url);
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

export const EDGE_PORT = Number(process.env.EDGE_PORT ?? 4180);
export type Slug = 'demo-uni' | 'test-poly';
export const hostUrl = (slug: Slug) => `http://${slug}.univarse.localhost:${EDGE_PORT}`;
export const PASSWORD = 'E2e-Harmattan-Breeze-77';

const platform = createPlatformClient(process.env.PLATFORM_DATABASE_URL!);
const shard = createTenantShardClient(process.env.TENANT_POOL_01_DATABASE_URL!);
const tenantIds = new Map<string, string>();
const created: { tenantId: string; userId: string }[] = [];

async function tenantId(slug: Slug): Promise<string> {
  const known = tenantIds.get(slug);
  if (known) return known;
  const id = (await platform.tenant.findUniqueOrThrow({ where: { slug } })).id;
  tenantIds.set(slug, id);
  return id;
}

export interface TestUser {
  readonly id: string;
  readonly username: string;
  readonly displayName: string;
  readonly secret?: Buffer;
  readonly recoveryCode?: string;
}

/** Same derivation as MfaService.recoveryHash (the API's step-up tests use it too). */
const recoveryHash = (userId: string, code: string) =>
  new Uint8Array(
    createHmac('sha256', process.env.SESSION_PEPPER!)
      .update(`${userId}:recovery:${code.toUpperCase().replace(/[^A-Z2-7]/g, '')}`)
      .digest(),
  );

/** An ACTIVE user with a known password, optionally with a confirmed TOTP factor. */
export async function makeUser(slug: Slug, opts: { role: string; mfa?: boolean; recoveryCode?: boolean }): Promise<TestUser> {
  const tid = await tenantId(slug);
  const db = forTenant(shard, tid);
  const tag = randomBytes(3).toString('hex').toUpperCase();
  const username = `E2E-${tag}`;
  const displayName = `Ada E2E ${tag}`;
  const user = await db.userAccount.create({
    data: {
      tenantId: tid,
      username,
      displayName,
      email: `${username.toLowerCase()}@test.local`,
      status: 'ACTIVE',
      passwordHash: await hashPassword(PASSWORD),
    },
  });
  const role = await db.role.findUniqueOrThrow({ where: { tenantId_key: { tenantId: tid, key: opts.role } } });
  await db.roleAssignment.create({ data: { tenantId: tid, userId: user.id, roleId: role.id, scopeType: 'INSTITUTION' } });
  created.push({ tenantId: tid, userId: user.id });
  const secret = opts.mfa || opts.recoveryCode ? await enrolTestTotp(shard, tid, user.id) : undefined;
  let recoveryCode: string | undefined;
  if (opts.recoveryCode) {
    recoveryCode = `${randomBase32(5)}-${randomBase32(5)}`; // the API's format: "ABCDE-FGHJK"
    await db.recoveryCode.create({ data: { tenantId: tid, userId: user.id, codeHash: recoveryHash(user.id, recoveryCode) } });
  }
  return { id: user.id, username, displayName, ...(secret ? { secret } : {}), ...(recoveryCode ? { recoveryCode } : {}) };
}

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const randomBase32 = (n: number) => [...randomBytes(n)].map((b) => B32[b % 32]).join('');

/**
 * A distinct client IP per test. The API rate-limits per client IP and keeps counters in Valkey across
 * runs; locally every test comes from 127.0.0.1. This works only because, in dev, the browser and the
 * edge are both on loopback, which the API trusts. In production the edge's peer is the real client, so
 * a client-supplied X-Forwarded-For is never believed. The API integration tests do the same.
 */
export const randomClientIp = (): string => `10.${randomBytes(1)[0]!}.${randomBytes(1)[0]!}.${1 + (randomBytes(1)[0]! % 254)}`;

export const currentTotp = (u: TestUser): string => totpCode(u.secret!);

export async function clearReplayGuard(slug: Slug, u: TestUser): Promise<void> {
  await resetReplayGuard(shard, await tenantId(slug), u.id);
}

export async function cleanup(): Promise<void> {
  for (const c of created.splice(0)) await forTenant(shard, c.tenantId).userAccount.deleteMany({ where: { id: c.userId } });
  await shard.$disconnect();
  await platform.$disconnect();
}
