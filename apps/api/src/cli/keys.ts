// Operator key commands (spec 0006 PR B). Phase 0 stand-in for the console: run on a trusted host
// with the platform DB and Vault reachable. Prints numbers and versions only, never key material.
//
//   pnpm --filter @univarse/api keys status
//   pnpm --filter @univarse/api keys rotate <slug>
//   pnpm --filter @univarse/api keys sweep                      run pending sweeps now (the worker also does)
//   pnpm --filter @univarse/api keys migrate-v1                 request the v1 → v2 sweep for every tenant
//   pnpm --filter @univarse/api keys resweep <slug>              request a sweep now (D15 needs one after the grace)
//   pnpm --filter @univarse/api keys destroy-check <slug> --version <n>
//   pnpm --filter @univarse/api keys destroy <slug> --op <uuid> [--version <n>]
//     Spec 0020 D14: the destruction job's step. Without --version, every key of the tenant (offboarding); with it,
//     one retired version (D15). Prints one JSON line. In production it runs only as the job for its op
//     (UNIVARSE_DESTRUCTION_OP); operators use `pnpm stack:keys destroy`, never this directly.
//   pnpm --filter @univarse/api keys rewrap-kek                 needs VAULT_ADMIN_TOKEN (operator only)
import 'reflect-metadata';
import { existsSync } from 'node:fs';
import { NestFactory } from '@nestjs/core';
import {
  checkRetiredKey,
  keyProviderFrom,
  RetiredKeyInUseError,
  requestReencryption,
  rewrapAllDeks,
  rotateTenantKey,
  VaultKeyAdmin,
} from '@univarse/crypto';
import type { PlatformClient } from '@univarse/db';
import { loadConfig } from '../config/config.js';
import { KeyDestruction } from '../shared/crypto/key-forget.js';
import { KeyMaintenance } from '../shared/crypto/key-maintenance.js';
import { PLATFORM_DB } from '../shared/db/db.module.js';
import { WorkerModule } from '../worker.module.js';

const rootEnv = new URL('../../../../.env', import.meta.url);
if (process.env.NODE_ENV !== 'production' && existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const USAGE =
  'usage: keys <status | rotate <slug> | sweep | migrate-v1 | resweep <slug> | destroy-check <slug> --version <n> | destroy <slug> --op <uuid> [--version <n>] | rewrap-kek>';
const [command, ...args] = process.argv.slice(2);
const config = loadConfig();
// Spec 0015: the CLI publishes key-forget notices but never subscribes to the bus.
const ctx = await NestFactory.createApplicationContext(
  WorkerModule.forRoot(config, { subscribe: false }),
  { logger: ['error', 'warn'] },
);
const platform = ctx.get<PlatformClient>(PLATFORM_DB);
const keys = ctx.get(KeyMaintenance);
const destruction = ctx.get(KeyDestruction);

/** `--name value` from the arguments after the slug; refuses unknown or repeated flags. */
function flags(rest: string[], allowed: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 2) {
    const name = rest[i]?.replace(/^--/, '') ?? '';
    const value = rest[i + 1];
    if (!rest[i]?.startsWith('--') || !allowed.includes(name) || name in out || value === undefined) throw new Error(USAGE);
    out[name] = value;
  }
  return out;
}

function versionOf(raw: string | undefined): number {
  const version = Number(raw);
  if (!Number.isInteger(version) || version < 1) throw new Error(USAGE);
  return version;
}

async function tenantBySlug(slug: string | undefined) {
  if (!slug) throw new Error(USAGE);
  return platform.tenant.findUniqueOrThrow({
    where: { slug },
    select: { id: true, slug: true, shardId: true },
  });
}

try {
  switch (command) {
    case 'status': {
      const tenants = await platform.tenant.findMany({
        select: { id: true, slug: true, shardId: true },
        orderBy: { slug: 'asc' },
      });
      for (const t of tenants) {
        const dataKeys = await platform.tenantDataKey.findMany({
          where: { tenantId: t.id },
          orderBy: { version: 'asc' },
        });
        const sweep = await platform.keyReencryption.findUnique({ where: { tenantId: t.id } });
        const usage = await keys.usage(t);
        const keyList =
          dataKeys.map((k) => `v${String(k.version)} ${k.status}`).join(', ') || 'none';
        const sweepState = !sweep
          ? '-'
          : !sweep.completedAt
            ? 'pending'
            : sweep.unreadableRemaining > 0n
              ? `partial (${String(sweep.unreadableRemaining)} unreadable; their key versions are kept)`
              : 'done';
        console.log(
          `${t.slug}: keys [${keyList}]  values ${JSON.stringify(usage)}  sweep ${sweepState}`,
        );
      }
      break;
    }
    case 'rotate': {
      const t = await tenantBySlug(args[0]);
      const r = await rotateTenantKey(platform, keyProviderFrom(config), t.id, null);
      console.log(
        `${t.slug}: v${String(r.from)} retired, v${String(r.to)} active; sweep requested`,
      );
      break;
    }
    case 'sweep': {
      // Runs every claimable request once. Failed ones stay leased (10 min) and are reported.
      let reencrypted = 0;
      let unreadable = 0;
      const failed: string[] = [];
      for (let r = await keys.runOnce(); r !== null; r = await keys.runOnce()) {
        reencrypted += r.reencrypted;
        unreadable += r.unreadable;
        if (!r.ok) failed.push(r.tenantId);
      }
      const pending = await platform.keyReencryption.count({ where: { completedAt: null } });
      console.log(
        `${String(reencrypted)} values re-encrypted, ${String(unreadable)} unreadable (left as is); ${String(pending)} sweeps still pending`,
      );
      for (const id of failed)
        console.error(`  sweep failed for tenant ${id} (see the logs); retried after its lease`);
      if (failed.length > 0 || unreadable > 0) process.exitCode = 1;
      break;
    }
    case 'migrate-v1': {
      const tenants = await platform.tenant.findMany({
        where: { dataKeys: { some: { status: 'ACTIVE' } } },
        select: { id: true },
      });
      for (const t of tenants) await requestReencryption(platform, t.id, 'LEGACY_V1');
      console.log(`v1 → v2 sweep requested for ${String(tenants.length)} tenants`);
      break;
    }
    case 'resweep': {
      const t = await tenantBySlug(args[0]);
      await requestReencryption(platform, t.id, 'ROTATION');
      console.log(`${t.slug}: sweep requested`);
      break;
    }
    case 'destroy-check': {
      // The protocol's read-only precheck. Prints one JSON line; exits 1 when not eligible now.
      const t = await tenantBySlug(args[0]);
      const version = versionOf(flags(args.slice(1), ['version']).version);
      const count = async (v: number) => (await keys.usage(t))[String(v)] ?? 0;
      try {
        await checkRetiredKey(platform, t.id, version, count, { graceMs: config.RETIRED_KEY_GRACE_MS });
        console.log(JSON.stringify({ tenant: t.slug, version, eligible: true }));
      } catch (err) {
        if (!(err instanceof RetiredKeyInUseError)) throw err;
        console.log(JSON.stringify({ tenant: t.slug, version, eligible: false, why: err.why, remaining: err.remaining }));
        process.exitCode = 1;
      }
      break;
    }
    case 'destroy': {
      const t = await tenantBySlug(args[0]);
      const f = flags(args.slice(1), ['op', 'version']);
      if (!f.op) throw new Error(USAGE);
      // Spec 0015 CI5/CI6/CI9: KeyDestruction notifies only after the destruction committed.
      const r =
        f.version === undefined
          ? await destruction.shredTenantKeys(t.id, null, 'tenant keys destroyed by the destruction job', { op: f.op })
          : await destruction.destroyRetired(t.id, versionOf(f.version), async (v) => (await keys.usage(t))[String(v)] ?? 0, {
              op: f.op,
              actorId: null,
              reason: 'retired key destroyed by the destruction job',
            });
      const destroyed = typeof r.destroyed === 'number' ? r.destroyed > 0 : r.destroyed;
      // `destroyed: false` is a repeat of a committed op, or a tenant with nothing left; the record answers which.
      console.log(
        JSON.stringify({
          op: f.op,
          tenant: t.slug,
          kind: f.version === undefined ? 'TENANT' : 'RETIRED',
          destroyed,
          committed: (await platform.keyDestruction.findUnique({ where: { op: f.op }, select: { op: true } })) !== null,
          forget: r.report?.lines ?? [],
        }),
      );
      break;
    }
    case 'rewrap-kek': {
      const token = process.env.VAULT_ADMIN_TOKEN;
      if (!config.VAULT_ADDR || !token)
        throw new Error('rewrap-kek needs VAULT_ADDR and VAULT_ADMIN_TOKEN');
      const admin = new VaultKeyAdmin({
        addr: config.VAULT_ADDR,
        token,
        mount: config.VAULT_TRANSIT_MOUNT,
        key: config.VAULT_TRANSIT_KEY,
      });
      const r = await rewrapAllDeks(platform, admin, null);
      console.log(
        `${String(r.rewrapped)} data keys re-wrapped under ${admin.kekId} key version ${String(r.keyVersion)}`,
      );
      for (const f of r.failed)
        console.error(
          `  not re-wrapped (Vault refused the wrap): tenant ${f.tenantId} v${String(f.version)}`,
        );
      if (r.failed.length > 0) process.exitCode = 1;
      break;
    }
    default:
      throw new Error(USAGE);
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
} finally {
  await ctx.close();
}
