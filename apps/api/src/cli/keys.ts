// Operator key commands (spec 0006 PR B). Phase 0 stand-in for the console: run on a trusted host
// with the platform DB and Vault reachable. Prints numbers and versions only, never key material.
//
//   pnpm --filter @univarse/api keys status
//   pnpm --filter @univarse/api keys rotate <slug>
//   pnpm --filter @univarse/api keys sweep                      run pending sweeps now (the worker also does)
//   pnpm --filter @univarse/api keys migrate-v1                 request the v1 → v2 sweep for every tenant
//   pnpm --filter @univarse/api keys resweep <slug>              request a sweep now (D15 needs one after the grace)
//   pnpm --filter @univarse/api keys destroy-check <slug> [--version <n>]   the read-only precheck, as JSON
//   pnpm --filter @univarse/api keys destroy <slug> --op <uuid> [--version <n>]
//     Spec 0020 D14: the destruction job's step. Without --version, every key of the tenant (offboarding); with it,
//     one retired version (D15). Prints one JSON line. In production it runs only as the job for its op
//     (UNIVARSE_DESTRUCTION_OP); operators use `pnpm stack:keys destroy`, never this directly.
//     A definite refusal (a precondition, a conflict, the job guard; nothing changed) prints {outcome: "refused"}
//     and exits 3; any other failure exits 1 and its outcome is unknown (the host protocol then asks the evidence).
//   pnpm --filter @univarse/api keys evidence [--tenant-id <uuid>]…
//     Spec 0020 D8: read-only JSON of every key_destruction row, its audit event and its keys, for the host's recovery.
//   pnpm --filter @univarse/api keys reapply --op <uuid> --tenant-id <uuid> --kind TENANT|RETIRED --versions <n,…>
//     Spec 0020 D8: re-applies an accepted destruction after a restore (the destruction job only, in production).
//   pnpm --filter @univarse/api keys ledger-audit --action <name> --detail <json>
//     Spec 0020 BK16: the platform audit event for a ledger command (init, a destination added, rebuilt or removed).
//   pnpm --filter @univarse/api keys ledger-copy --ledger <uuid> --generation gen-NNNN   (entries on stdin)
//     Spec 0020 A2-10: the ledger's extra copy in the object-locked bucket (evidence only).
//   pnpm --filter @univarse/api keys rewrap-kek                 needs VAULT_ADMIN_TOKEN (operator only)
import 'reflect-metadata';
import { existsSync, readFileSync } from 'node:fs';
import { NestFactory } from '@nestjs/core';
import {
  checkRetiredKey,
  DestructionConflictError,
  keyProviderFrom,
  RetiredKeyInUseError,
  requestReencryption,
  rewrapAllDeks,
  rotateTenantKey,
  VaultKeyAdmin,
  writePlatformAudit,
} from '@univarse/crypto';
import type { PlatformClient } from '@univarse/db';
import { loadConfig } from '../config/config.js';
import { DestructionRefusedError, KeyDestruction } from '../shared/crypto/key-forget.js';
import { KeyMaintenance } from '../shared/crypto/key-maintenance.js';
import { PLATFORM_DB } from '../shared/db/db.module.js';
import { WorkerModule } from '../worker.module.js';
import { copyToBucket } from './ledger-copy.js';

const rootEnv = new URL('../../../../.env', import.meta.url);
if (process.env.NODE_ENV !== 'production' && existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const USAGE =
  'usage: keys <status | rotate <slug> | sweep | migrate-v1 | resweep <slug> | destroy-check <slug> [--version <n>] | destroy <slug> --op <uuid> [--version <n>] | evidence [--tenant-id <uuid>]… | reapply --op <uuid> --tenant-id <uuid> --kind TENANT|RETIRED --versions <n,…> | ledger-audit --action <name> --detail <json> | ledger-copy --ledger <uuid> --generation gen-NNNN | rewrap-kek>';
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Every `--tenant-id <uuid>` given (the only flag that may repeat). */
function tenantIds(rest: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < rest.length; i += 2) {
    const value = rest[i + 1];
    if (rest[i] !== '--tenant-id' || value === undefined || !UUID.test(value)) throw new Error(USAGE);
    out.push(value);
  }
  return out;
}

/** A definite refusal: nothing changed. The host protocol records it as `aborted` (exit 3). */
function refused(op: string, why: string): void {
  console.log(JSON.stringify({ op, outcome: 'refused', why }));
  process.exitCode = 3;
}

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
      // The protocol's read-only precheck (D7), before its `pending` record. Prints one JSON line with what it saw
      // (statuses and times only); exits 1 when not eligible now.
      const f = flags(args.slice(1), ['version']);
      const t = args[0] ? await platform.tenant.findUnique({ where: { slug: args[0] }, select: { id: true, slug: true, shardId: true } }) : null;
      if (!t) {
        console.log(JSON.stringify({ tenant: args[0] ?? null, eligible: false, why: 'no_tenant' }));
        process.exitCode = 1;
        break;
      }
      const dataKeys = await platform.tenantDataKey.findMany({ where: { tenantId: t.id }, orderBy: { version: 'asc' } });
      const seen = dataKeys.map((k) => ({ version: k.version, status: k.status, retiredAt: k.retiredAt?.toISOString() ?? null }));
      const base = { tenant: t.slug, tenantId: t.id };
      if (f.version === undefined) {
        const live = dataKeys.filter((k) => k.status !== 'DESTROYED').map((k) => k.version);
        const ok = live.length > 0;
        console.log(JSON.stringify({ ...base, kind: 'TENANT', versions: live, eligible: ok, ...(ok ? {} : { why: 'nothing_to_destroy' }), preconditions: { keys: seen } }));
        if (!ok) process.exitCode = 1;
        break;
      }
      const version = versionOf(f.version);
      const sweep = await platform.keyReencryption.findUnique({ where: { tenantId: t.id } });
      const preconditions = {
        keys: seen,
        graceMs: config.RETIRED_KEY_GRACE_MS,
        sweep: sweep
          ? { startedAt: sweep.startedAt?.toISOString() ?? null, completedAt: sweep.completedAt?.toISOString() ?? null, unreadableRemaining: String(sweep.unreadableRemaining) }
          : null,
      };
      const count = async (v: number) => (await keys.usage(t))[String(v)] ?? 0;
      try {
        await checkRetiredKey(platform, t.id, version, count, { graceMs: config.RETIRED_KEY_GRACE_MS });
        console.log(JSON.stringify({ ...base, kind: 'RETIRED', versions: [version], eligible: true, preconditions }));
      } catch (err) {
        if (!(err instanceof RetiredKeyInUseError)) throw err;
        console.log(JSON.stringify({ ...base, kind: 'RETIRED', versions: [version], eligible: false, why: err.why, remaining: err.remaining, preconditions }));
        process.exitCode = 1;
      }
      break;
    }
    case 'destroy': {
      const f = flags(args.slice(1), ['op', 'version']);
      if (!f.op || !args[0]) throw new Error(USAGE);
      const op = f.op;
      const t = await platform.tenant.findUnique({ where: { slug: args[0] }, select: { id: true, slug: true, shardId: true } });
      if (!t) {
        refused(op, 'no_tenant');
        break;
      }
      // Spec 0015 CI5/CI6/CI9: KeyDestruction notifies only after the destruction committed.
      let report: { lines: readonly string[] } | null;
      try {
        const r =
          f.version === undefined
            ? await destruction.shredTenantKeys(t.id, null, 'tenant keys destroyed by the destruction job', { op })
            : await destruction.destroyRetired(t.id, versionOf(f.version), async (v) => (await keys.usage(t))[String(v)] ?? 0, {
                op,
                actorId: null,
                reason: 'retired key destroyed by the destruction job',
              });
        report = r.report;
      } catch (err) {
        // Definite refusals only: each is thrown before the transaction commits, and rolls it back.
        if (err instanceof RetiredKeyInUseError) refused(op, err.why);
        else if (err instanceof DestructionConflictError) refused(op, 'conflict');
        else if (err instanceof DestructionRefusedError) refused(op, 'not_the_job');
        else throw err;
        break;
      }
      // Committed now, or a repeat of a committed op: the row is the database's answer either way (D8).
      const row = await platform.keyDestruction.findUnique({ where: { op } });
      if (!row) {
        refused(op, 'nothing_to_destroy'); // a tenant with no live key: nothing was recorded
        break;
      }
      console.log(
        JSON.stringify({
          op,
          outcome: 'committed',
          tenant: t.slug,
          tenantId: t.id,
          kind: row.kind,
          versions: row.versions,
          destroyedAt: row.destroyedAt.toISOString(),
          auditSeq: String(row.auditSeq),
          forget: report?.lines ?? [],
        }),
      );
      break;
    }
    case 'evidence': {
      // D8: the database's own evidence. Never key material: statuses, and whether each wrap is erased.
      const rows = await platform.keyDestruction.findMany({ orderBy: { destroyedAt: 'asc' } });
      const ids = [...new Set([...rows.map((r) => r.tenantId), ...tenantIds(args)])];
      const keysOf = await platform.tenantDataKey.findMany({
        where: { tenantId: { in: ids } },
        select: { tenantId: true, version: true, status: true, wrappedDek: true },
        orderBy: { version: 'asc' },
      });
      const audits = await platform.platformAuditEvent.findMany({
        where: { seq: { in: rows.map((r) => r.auditSeq) } },
        select: { seq: true, action: true, tenantId: true, metadata: true },
      });
      const auditOf = new Map(audits.map((a) => [a.seq, a]));
      const tenants = Object.fromEntries(
        ids.map((id) => [
          id,
          keysOf.filter((k) => k.tenantId === id).map((k) => ({ version: k.version, status: k.status, wrapErased: k.wrappedDek === null })),
        ]),
      );
      console.log(
        JSON.stringify({
          rows: rows.map((r) => {
            const a = auditOf.get(r.auditSeq);
            const m = (a?.metadata ?? {}) as { op?: unknown; versions?: unknown };
            return {
              op: r.op,
              tenantId: r.tenantId,
              kind: r.kind,
              versions: r.versions,
              destroyedAt: r.destroyedAt.toISOString(),
              auditSeq: String(r.auditSeq),
              audit: a ? { action: a.action, tenantId: a.tenantId, op: m.op ?? null, versions: m.versions ?? null } : null,
            };
          }),
          tenants,
        }),
      );
      break;
    }
    case 'reapply': {
      const f = flags(args, ['op', 'tenant-id', 'kind', 'versions']);
      const kind = f.kind;
      const versions = (f.versions ?? '').split(',').map(versionOf);
      if (!f.op || !f['tenant-id'] || !UUID.test(f['tenant-id']) || (kind !== 'TENANT' && kind !== 'RETIRED')) throw new Error(USAGE);
      const op = f.op;
      let r: Awaited<ReturnType<KeyDestruction['reapply']>>;
      try {
        r = await destruction.reapply({ op, tenantId: f['tenant-id'], kind, versions, actorId: null, reason: 'accepted destruction re-applied by recovery' });
      } catch (err) {
        if (err instanceof DestructionConflictError) refused(op, 'conflict');
        else if (err instanceof DestructionRefusedError) refused(op, 'not_the_job');
        else throw err;
        break;
      }
      console.log(
        JSON.stringify({ op, outcome: 'reapplied', destroyed: r.destroyed, recorded: r.recorded, activeDestroyed: r.activeDestroyed, forget: r.report?.lines ?? [] }),
      );
      break;
    }
    case 'ledger-audit': {
      // BK16: every ledger command is recorded in the platform audit as well as in the chain. Names and ids only.
      const f = flags(args, ['action', 'detail']);
      if (!f.action || !/^[a-z_]{3,40}$/.test(f.action) || !f.detail || f.detail.length > 4_000) throw new Error(USAGE);
      const detail = JSON.parse(f.detail) as unknown;
      if (typeof detail !== 'object' || detail === null || Array.isArray(detail)) throw new Error(USAGE);
      const seq = await platform.$transaction((tx) =>
        writePlatformAudit(tx, { actorId: null, action: `crypto.ledger.${f.action ?? ''}`, tenantId: null, metadata: detail as Record<string, unknown> }),
      );
      console.log(JSON.stringify({ outcome: 'audited', auditSeq: String(seq) }));
      break;
    }
    case 'ledger-copy': {
      const f = flags(args, ['ledger', 'generation']);
      if (!f.ledger || !f.generation) throw new Error(USAGE);
      if (!config.LEDGER_S3_ACCESS_KEY || !config.LEDGER_S3_SECRET_KEY) throw new Error('ledger-copy needs LEDGER_S3_ACCESS_KEY and LEDGER_S3_SECRET_KEY');
      const lines = readFileSync(0, 'utf8').split('\n').filter((l) => l.trim() !== '');
      const written = await copyToBucket(
        {
          endpoint: config.S3_ENDPOINT,
          region: config.S3_REGION,
          accessKeyId: config.LEDGER_S3_ACCESS_KEY,
          secretAccessKey: config.LEDGER_S3_SECRET_KEY,
          ledgerId: f.ledger,
          generation: f.generation,
        },
        lines,
      );
      console.log(JSON.stringify({ outcome: 'copied', written }));
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
