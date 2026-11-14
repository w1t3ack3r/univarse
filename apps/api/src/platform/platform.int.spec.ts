/**
 * Spec 0027 P1, P3, P4, P5: the platform API's walls and its role, against the real platform database.
 * Prereqs: `pnpm db:setup` (which writes .env.console) and `pnpm db:migrate`. Loads .env.console only, like platform.ts:
 * the platform API never sees the root .env.
 */
import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { Controller, Get } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createPlatformClient } from '@univarse/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { platformTestConfig } from '../testing/platform-env.js';
import { PlatformPublic } from './identity/access.js';
import { createPlatformApp } from './platform-app.js';

const consoleEnvFile = new URL('../../../../.env.console', import.meta.url);
const CONSOLE_DATABASE_URL = existsSync(consoleEnvFile) ? parseEnv(readFileSync(consoleEnvFile, 'utf8')).CONSOLE_DATABASE_URL : undefined;
if (!CONSOLE_DATABASE_URL) throw new Error('No CONSOLE_DATABASE_URL in .env.console: run `pnpm db:setup`');

/** A route under the platform prefix, so the walls can be seen to let a request through (tests only). */
@Controller('api/platform/v1/test')
@PlatformPublic()
class WallProbeController {
  @Get('probe')
  probe() {
    return { reached: true };
  }
}

const EDGE = '172.31.219.10'; // Caddy, the trusted proxy
const GATEWAY = '172.31.218.1'; // the edge network's gateway: the owner, measured (spec 0027)
let app: NestFastifyApplication;
const get = (url: string, remoteAddress: string, forwardedFor?: string) =>
  app
    .getHttpAdapter()
    .getInstance()
    .inject({ method: 'GET', url, remoteAddress, headers: { host: 'console.stack.univarse.localhost', ...(forwardedFor ? { 'x-forwarded-for': forwardedFor } : {}) } });

beforeAll(async () => {
  const config = platformTestConfig({ TRUSTED_PROXIES: EDGE, CONSOLE_ALLOWLIST: GATEWAY });
  app = await createPlatformApp(config, { extraControllers: [WallProbeController] });
});
afterAll(async () => {
  await app.close();
});

describe('[P4] the allowlist, behind the edge', () => {
  it('lets the allowlisted address through the edge', async () => {
    const res = await get('/api/platform/v1/test/probe', EDGE, GATEWAY);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ reached: true });
  });

  it('refuses any other address with 404, exactly as an unknown route answers', async () => {
    const refused = await get('/api/platform/v1/test/probe', EDGE, '172.31.218.7');
    const unknown = await get('/api/platform/v1/no-such-route', EDGE, GATEWAY);
    expect(refused.statusCode).toBe(404);
    expect(unknown.statusCode).toBe(404);
    const shape = (r: typeof refused) => ({ ...(r.json<Record<string, unknown>>()), requestId: 'x' });
    expect(shape(refused)).toEqual(shape(unknown));
  });

  it('ignores a forwarded address from a peer that isn\'t the edge', async () => {
    expect((await get('/api/platform/v1/test/probe', '172.31.218.99', GATEWAY)).statusCode).toBe(404);
  });

  it('a forged address prepended by the client changes nothing: the right-most untrusted one counts', async () => {
    expect((await get('/api/platform/v1/test/probe', EDGE, `${GATEWAY}, 172.31.218.7`)).statusCode).toBe(404);
  });
});

describe('[P3] the platform API serves its prefix and health, nothing else', () => {
  it('a tenant path is 404 even from the allowlisted address', async () => {
    for (const path of ['/api/v1/auth/me', '/api/v1/tenant/public-profile', '/api/platform/v2/test/probe', '/', '/login']) {
      expect((await get(path, EDGE, GATEWAY)).statusCode, path).toBe(404);
    }
  });

  it('health answers on the container network, and ready means the platform database answers as the console role', async () => {
    expect((await get('/health/live', '172.31.219.20')).statusCode).toBe(200);
    expect((await get('/health/ready', '172.31.219.20')).json()).toEqual({ status: 'ready' });
  });
});

describe('[P5] the console role, in the database', () => {
  const as = (database: string) => createPlatformClient(CONSOLE_DATABASE_URL.replace(/\/[^/?]+(\?|$)/, `/${database}$1`));

  it('may connect to the platform database and to no other UniVarse database: every database, read from the catalogue', async () => {
    const db = as('univarse_platform');
    try {
      const rows = await db.$queryRaw<{ datname: string; connect: boolean }[]>`
        SELECT datname, has_database_privilege(current_user, datname, 'CONNECT') AS connect
          FROM pg_database WHERE NOT datistemplate AND datname LIKE 'univarse%' ORDER BY datname`;
      expect(rows.map((r) => r.datname)).toContain('univarse_pool_01'); // the scan sees the tenant databases
      expect(rows.filter((r) => r.connect).map((r) => r.datname)).toEqual(['univarse_platform']);
    } finally {
      await db.$disconnect();
    }
  });

  it('a real connection to the tenant database is refused', async () => {
    const tenant = as('univarse_pool_01');
    try {
      await expect(tenant.$queryRaw`SELECT 1`).rejects.toThrow(/permission denied for database|not have the CONNECT privilege/i);
    } finally {
      await tenant.$disconnect();
    }
  });

  it('holds exactly spec 0028 Q2\'s grants, and no special attribute: each later slice grants its own', async () => {
    const db = as('univarse_platform');
    try {
      const rows = await db.$queryRaw<{ table_name: string; sel: boolean; ins: boolean; upd: boolean; del: boolean; trunc: boolean }[]>`
        SELECT table_name,
               has_table_privilege(current_user, quote_ident(table_name), 'SELECT') AS sel,
               has_table_privilege(current_user, quote_ident(table_name), 'INSERT') AS ins,
               has_any_column_privilege(current_user, quote_ident(table_name), 'UPDATE') AS upd,
               has_table_privilege(current_user, quote_ident(table_name), 'DELETE') AS del,
               has_table_privilege(current_user, quote_ident(table_name), 'TRUNCATE') AS trunc
          FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`;
      const held = Object.fromEntries(rows.filter((r) => r.sel || r.ins || r.upd || r.del || r.trunc).map((r) => [r.table_name, `${r.sel ? 'S' : ''}${r.ins ? 'I' : ''}${r.upd ? 'U' : ''}${r.del ? 'D' : ''}${r.trunc ? 'T' : ''}`]));
      expect(held).toEqual({
        platform_access_review: 'SI',
        // Spec 0037: requests are read whole and inserted by column; only the decision's columns update.
        platform_approval: 'SU',
        platform_audit_event: 'SI',
        platform_audit_verification: 'SIU',
        platform_contact_change: 'SIU',
        platform_known_device: 'SIU',
        platform_mail_outbox: 'SIU',
        platform_mfa_challenge: 'SIU',
        platform_mfa_factor: 'SIU',
        // Spec 0037 Q9: notices and their deliveries are inserted by column; only named columns update.
        platform_notice: 'SU',
        platform_notice_delivery: 'SU',
        platform_one_time_code: 'SIU',
        platform_recovery_code: 'SIU',
        platform_security_event_rollup: 'SIU',
        platform_session: 'SIU',
        // Spec 0037 Q6: a suspension is inserted by column, and only the resume's columns update.
        platform_tenant_suspension: 'SU',
        platform_user: 'SIU',
        // Spec 0034: the job by column (inserted, read without its invite, updated to resume); the rest whole-table.
        provisioning_job: 'U',
        provisioning_step: 'S',
        // `tenant`, `shard`, `tenant_domain` and `tenant_data_key` are granted by column, so they don't count as whole-table SELECT.
        tenant: 'U',
        tenant_branding: 'SIU',
        tenant_dpa: 'SIU',
        tenant_onboarding: 'S',
        tenant_product: 'SIU',
        tenant_regulatory_profile: 'SIU',
      });
      // Spec 0034 Q-A2, Q7: a new institution can only start REQUESTED, and the sealed invite is never read back.
      for (const [table, column, privilege, expected] of [
        ['tenant', 'slug', 'INSERT', true],
        ['tenant', 'status', 'INSERT', false],
        ['tenant', 'tier', 'INSERT', false],
        ['tenant', 'version', 'INSERT', false],
        ['provisioning_job', 'status', 'INSERT', false],
        ['provisioning_job', 'version', 'INSERT', false],
        ['provisioning_job', 'invite_enc', 'INSERT', true],
        ['provisioning_job', 'invite_enc', 'SELECT', false],
        ['provisioning_job', 'invite_enc', 'UPDATE', false],
        // Spec 0037 Q7: the session ending is the worker's to record, never the console's.
        ['platform_tenant_suspension', 'sessions_ended_at', 'UPDATE', false],
        ['platform_tenant_suspension', 'sessions_ended', 'UPDATE', false],
        ['platform_tenant_suspension', 'reason', 'UPDATE', false],
        ['platform_tenant_suspension', 'resumed_at', 'UPDATE', true],
        // Spec 0037 Q9: a notice starts as a draft, by its author; its audience is never re-pointed.
        ['platform_notice', 'status', 'INSERT', false],
        ['platform_notice', 'published_at', 'INSERT', false],
        ['platform_notice_delivery', 'tenant_id', 'UPDATE', false],
        ['platform_notice_delivery', 'withdrawn_at', 'UPDATE', true],
      ] as const) {
        const [row] = await db.$queryRawUnsafe<{ ok: boolean }[]>(`SELECT has_column_privilege(current_user, '${table}', '${column}', '${privilege}') AS ok`);
        expect([table, column, privilege, row?.ok]).toEqual([table, column, privilege, expected]);
      }
      // Spec 0033 Q3: the columns of the tenant registry the console reads, by name, and never a secret.
      const tenantColumns = await db.$queryRaw<{ column_name: string }[]>`
        SELECT column_name FROM information_schema.columns
         WHERE table_name = 'tenant' AND has_column_privilege(current_user, 'tenant', column_name, 'SELECT') ORDER BY column_name`;
      expect(tenantColumns.map((c) => c.column_name)).toEqual(['created_at', 'id', 'legal_name', 'offboarding_started_at', 'ownership', 'purge_after', 'release_ring', 'shard_id', 'short_name', 'slug', 'status', 'suspended_reason', 'template', 'tier', 'type', 'updated_at', 'version']);
      for (const [table, column] of [['shard', 'secret_ref'], ['tenant_domain', 'verification_token'], ['tenant_data_key', 'wrapped_dek']] as const) {
        const [row] = await db.$queryRawUnsafe<{ ok: boolean }[]>(`SELECT has_column_privilege(current_user, '${table}', '${column}', 'SELECT') AS ok`);
        expect([table, column, row?.ok]).toEqual([table, column, false]);
      }
      const role = await db.$queryRaw<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean; rolcreaterole: boolean; rolcreatedb: boolean; rolreplication: boolean }[]>`
        SELECT rolname, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication FROM pg_roles WHERE rolname = current_user`;
      expect(role).toEqual([{ rolname: 'univarse_console', rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false, rolreplication: false }]);
    } finally {
      await db.$disconnect();
    }
  });

  it('the tenant API\'s platform role holds nothing on staff identity (spec 0028 Q2)', async () => {
    const env = parseEnv(readFileSync(new URL('../../../../.env', import.meta.url), 'utf8'));
    const app = createPlatformClient(env.PLATFORM_DATABASE_URL ?? 'postgresql://unset');
    try {
      const rows = await app.$queryRaw<{ table_name: string }[]>`
        SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'
           AND table_name IN ('platform_user', 'platform_session', 'platform_mfa_factor', 'platform_recovery_code', 'platform_mfa_challenge',
                              'platform_one_time_code', 'platform_known_device', 'platform_mail_outbox')
           AND (has_table_privilege(current_user, quote_ident(table_name), 'SELECT') OR has_table_privilege(current_user, quote_ident(table_name), 'INSERT')
             OR has_any_column_privilege(current_user, quote_ident(table_name), 'UPDATE') OR has_table_privilege(current_user, quote_ident(table_name), 'DELETE'))`;
      expect(rows).toEqual([]);
    } finally {
      await app.$disconnect();
    }
  });
});
