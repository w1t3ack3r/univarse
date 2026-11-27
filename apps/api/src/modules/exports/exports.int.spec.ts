/**
 * Spec 0038 Q7, Q8, Q-B1 to Q-B10 (T35): the institution's full export, end to end against the real databases and
 * storage. An IT Admin (MFA, stepped up) asks through the tenant API and gets the passphrase once; the worker's pass
 * mirrors the export to the platform and the builder seals an AES-256 ZIP into the exports bucket; the archive opens
 * with the passphrase only, holds every row the institution has (counted table by table) and no secret; the download
 * streams it to an IT Admin of this institution only; after 7 days it's deleted. Passes take "now", so no clock is
 * moved. Institutions here are their own (slug `exp-…`), removed at the end.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FieldCrypto, keyProviderFrom, provisionTenantKey } from '@univarse/crypto';
import { createPlatformClient, createTenantShardClient, forTenant, type PlatformClient, type TenantShardClient } from '@univarse/db';
import { configure, TextWriter, Uint8ArrayReader, Uint8ArrayWriter, ZipReader } from '@zip.js/zip.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../bootstrap.js';
import { loadConfig } from '../../config/config.js';
import { TenantResolver } from '../../shared/tenancy/tenant-resolver.service.js';
import { enrolTestTotp, resetReplayGuard, totpCode } from '../../testing/mfa-helpers.js';
import { testTree } from '../../testing/org-units.js';
import { pruneTestTenants } from '../../testing/tenant-cleanup.js';
import { WorkerModule } from '../../worker.module.js';
import { contactAad } from '../identity/contact.service.js';
import { hashPassword } from '../identity/password.js';
import { FileStorage } from '../files/file-storage.js';
import { ExportBuilder } from './export-builder.js';
import { EXCLUDED_TABLES, EXPORTED_TABLES } from './export-catalogue.js';
import { exportPassphraseAad } from './export-keys.js';
import { ExportPass } from './export-pass.js';
import { ExportsService } from './exports.service.js';
import type { Actor } from '../identity/actor.js';
import type { TenantContext } from '../../shared/tenancy/tenant-resolver.service.js';

configure({ useWebWorkers: false });

const rootEnv = new URL('../../../../../.env', import.meta.url);
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const PREFIX = 'exp-';
const PASSWORD = 'Correct-Horse-Battery-9';
const DAY = 86_400_000;

let tenantApp: NestFastifyApplication;
let worker: INestApplicationContext;
let pass: ExportPass;
let builder: ExportBuilder;
let storage: FileStorage;
let crypto: FieldCrypto;
let migrator: PlatformClient;
let shard: TenantShardClient;
let poolId: string;

const ip = () => `127.${String(randomInt(1, 255))}.${String(randomInt(0, 255))}.${String(randomInt(1, 255))}`;

interface Res {
  status: number;
  headers: Record<string, string | string[] | number | undefined>;
  raw: Buffer;
  body: Record<string, unknown>;
  setCookie: string[];
}

async function call(host: string, method: 'GET' | 'POST', url: string, opts: { cookie?: string; body?: unknown } = {}): Promise<Res> {
  const res = await tenantApp
    .getHttpAdapter()
    .getInstance()
    .inject({
      method,
      url,
      remoteAddress: ip(),
      headers: {
        host,
        ...(method === 'GET' ? {} : { 'sec-fetch-site': 'same-origin' }),
        ...(opts.cookie ? { cookie: opts.cookie } : {}),
        ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(opts.body !== undefined ? { payload: JSON.stringify(opts.body) } : {}),
    });
  const set = res.headers['set-cookie'];
  const raw = res.rawPayload;
  const json = (res.headers['content-type'] ?? '').includes('json') && raw.length ? (JSON.parse(raw.toString('utf8')) as Record<string, unknown>) : {};
  return { status: res.statusCode, headers: res.headers, raw, body: json, setCookie: Array.isArray(set) ? set : set ? [set] : [] };
}
const cookie = (r: Res, name: string) => (r.setCookie.find((c) => c.startsWith(`${name}=`) && c.length > name.length + 10) ?? '').split(';')[0] ?? '';

interface Person {
  id: string;
  username: string;
  secret: Buffer | null;
}

interface Inst {
  id: string;
  host: string;
  admin: Person;
  student: Person;
  scoped: Person;
  plainAdmin: Person;
  fileId: string;
  fileBytes: Buffer;
  address: string;
  totpSecretHex: string;
}

/**
 * An institution with a data key and: an IT Admin with MFA; one without; an IT Admin whose grant is a department's
 * only; a student; a clean file; an address change (encrypted); a recovery code and a one-time token (never exported).
 */
async function institution(): Promise<Inst> {
  const slug = `${PREFIX}${randomBytes(4).toString('hex')}`;
  const host = `${slug}.univarse.localhost`;
  const t = await migrator.tenant.create({ data: { slug, legalName: `Export University ${slug}`, shortName: 'EU', type: 'UNIVERSITY', ownership: 'FEDERAL', status: 'ACTIVE', shardId: poolId }, select: { id: true } });
  await migrator.tenantDomain.create({ data: { tenantId: t.id, hostname: host, kind: 'SUBDOMAIN', verifiedAt: new Date() } });
  await provisionTenantKey(migrator, keyProviderFrom(loadConfig({ ...process.env, NODE_ENV: 'test' })), t.id);
  const db = forTenant(shard, t.id);
  const dept = { id: (await testTree(shard, t.id, [{ ref: 'CSC', type: 'department', name: 'Computer Science', code: 'CSC' }], 'Export University')).CSC ?? '' };
  const role = async (key: string, permissions: string[]) => (await db.role.create({ data: { tenantId: t.id, key, name: key, isSystem: true, permissions }, select: { id: true } })).id;
  const adminRole = await role('INSTITUTION_ADMIN', ['settings.product.manage', 'data.export.request']);
  const studentRole = await role('STUDENT', ['files.file.upload', 'files.file.read']);
  const person = async (roleId: string, mfa: boolean, scope: { scopeType: 'INSTITUTION' | 'ORG_UNIT'; scopeId?: string } = { scopeType: 'INSTITUTION' }): Promise<Person> => {
    const username = `EX-${randomBytes(3).toString('hex').toUpperCase()}`;
    const u = await db.userAccount.create({ data: { tenantId: t.id, username, displayName: `Person ${username}`, status: 'ACTIVE', email: `${username.toLowerCase()}@test.local`, passwordHash: await hashPassword(PASSWORD) }, select: { id: true } });
    await db.roleAssignment.create({ data: { tenantId: t.id, userId: u.id, roleId, ...scope } });
    return { id: u.id, username, secret: mfa ? await enrolTestTotp(shard, t.id, u.id) : null };
  };
  const admin = await person(adminRole, true);
  const plainAdmin = await person(adminRole, false);
  const scoped = await person(adminRole, true, { scopeType: 'ORG_UNIT', scopeId: dept.id });
  const student = await person(studentRole, false);
  // A clean file in storage, as the scanner leaves one.
  const fileBytes = Buffer.concat([Buffer.from('%PDF-1.4\n'), randomBytes(2048)]);
  const file = await db.fileObject.create({
    data: {
      tenantId: t.id,
      bucketKey: `tenants/${t.id}/q/${randomBytes(8).toString('hex')}`,
      originalName: '../Transcript: 2025?.pdf',
      mime: 'application/pdf',
      sizeBytes: BigInt(fileBytes.length),
      uploadedById: student.id,
      state: 'CLEAN',
      scanStatus: 'CLEAN',
      cleanKey: `tenants/${t.id}/c/${randomBytes(8).toString('hex')}`,
      sha256: createHash('sha256').update(fileBytes).digest(),
      completedAt: new Date(),
      scannedAt: new Date(),
    },
    select: { id: true, cleanKey: true },
  });
  await storage.put(storage.clean, file.cleanKey ?? '', fileBytes, 'application/pdf');
  // A file that was clean, then deleted: its clean copy still in storage, and still not in the export.
  const goneKey = `tenants/${t.id}/c/${randomBytes(8).toString('hex')}`;
  await storage.put(storage.clean, goneKey, Buffer.from('%PDF-1.4 gone'), 'application/pdf');
  await db.fileObject.create({ data: { tenantId: t.id, bucketKey: `tenants/${t.id}/q/${randomBytes(8).toString('hex')}`, originalName: 'gone.pdf', mime: 'application/pdf', sizeBytes: 13n, state: 'DELETED', deletedAt: new Date(), cleanKey: goneKey, sha256: randomBytes(32) } });
  // An address change, its addresses sealed as the app seals them.
  const address = `new-${slug}@example.test`;
  const cc = await db.contactChange.create({ data: { tenantId: t.id, userId: student.id, kind: 'SELF', expiresAt: new Date(Date.now() + DAY), codeHash: randomBytes(32), newAddressHash: randomBytes(32) }, select: { id: true } });
  await db.contactChange.update({ where: { id: cc.id }, data: { newAddressEnc: await crypto.encrypt(t.id, Buffer.from(address), contactAad(t.id, cc.id, 'new')) } });
  await db.recoveryCode.create({ data: { tenantId: t.id, userId: admin.id, codeHash: randomBytes(32) } });
  await db.oneTimeToken.create({ data: { tenantId: t.id, userId: plainAdmin.id, purpose: 'PASSWORD_RESET', tokenHash: randomBytes(32), channel: 'email', expiresAt: new Date(Date.now() + DAY) } });
  return { id: t.id, host, admin, student, scoped, plainAdmin, fileId: file.id, fileBytes, address, totpSecretHex: (admin.secret ?? Buffer.alloc(0)).toString('hex') };
}

/** Signs a person in (with their TOTP if they have one), stepped up unless asked not to. */
async function signIn(i: Inst, p: Person, stepUp = true): Promise<string> {
  const login = await call(i.host, 'POST', '/api/v1/auth/login', { body: { username: p.username, password: PASSWORD } });
  expect(login.status).toBe(200);
  let sid = cookie(login, '__Host-uv_sid');
  if (p.secret) {
    await resetReplayGuard(shard, i.id, p.id);
    const v = await call(i.host, 'POST', '/api/v1/auth/mfa/verify', { cookie: cookie(login, '__Host-uv_mfa'), body: { code: totpCode(p.secret) } });
    expect(v.status).toBe(200);
    sid = cookie(v, '__Host-uv_sid');
    if (stepUp) {
      await resetReplayGuard(shard, i.id, p.id);
      const up = await call(i.host, 'POST', '/api/v1/auth/step-up', { cookie: sid, body: { password: PASSWORD, code: totpCode(p.secret) } });
      expect(up.status).toBe(200);
      sid = cookie(up, '__Host-uv_sid');
    }
  }
  return sid;
}

const fresh = () => tenantApp.get(TenantResolver).invalidate();
const exportRow = (i: Inst, id: string) => forTenant(shard, i.id).dataExport.findUniqueOrThrow({ where: { id } });
const audits = async (i: Inst, id: string) =>
  (await forTenant(shard, i.id).auditEvent.findMany({ where: { entityType: 'data_export', entityId: id }, orderBy: { seq: 'asc' }, select: { action: true, actorType: true } })).map((a) => `${a.actorType}:${a.action}`);
/** The pass, with builds run in place of the queue. */
const runPass = (now = new Date()) =>
  pass.pass(now, async (id) => {
    await builder.build(id, now);
  });

async function readArchive(bytes: Buffer, passphrase: string): Promise<Map<string, Buffer>> {
  const zip = new ZipReader(new Uint8ArrayReader(new Uint8Array(bytes)));
  const out = new Map<string, Buffer>();
  for (const e of await zip.getEntries()) {
    if (e.directory) continue;
    expect(e.encrypted).toBe(true);
    out.set(e.filename, Buffer.from(await e.getData(new Uint8ArrayWriter(), { password: passphrase })));
  }
  await zip.close();
  return out;
}

beforeAll(async () => {
  migrator = createPlatformClient(process.env.PLATFORM_MIGRATOR_URL!);
  shard = createTenantShardClient(process.env.TENANT_POOL_01_MIGRATOR_URL!);
  poolId = (await migrator.shard.findUniqueOrThrow({ where: { name: 'pool-01' }, select: { id: true } })).id;
  tenantApp = await createApp(loadConfig({ ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'silent' }));
  worker = await NestFactory.createApplicationContext(
    WorkerModule.forRoot(loadConfig({ ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'silent', EXPORT_INTERVAL_MS: '0', OFFBOARDING_INTERVAL_MS: '0', NOTICE_RELAY_INTERVAL_MS: '0', NOTICE_COUNT_INTERVAL_MS: '0' }, 'worker'), { mailer: { send: () => Promise.resolve() }, subscribe: false }),
    { logger: false },
  );
  pass = worker.get(ExportPass);
  builder = worker.get(ExportBuilder);
  storage = worker.get(FileStorage);
  crypto = worker.get(FieldCrypto);
});

afterAll(async () => {
  // The archives under the test institutions' prefixes, then the institutions.
  for (const t of await migrator.tenant.findMany({ where: { slug: { startsWith: PREFIX } }, select: { id: true } })) {
    for (const key of await storage.listKeys(storage.exports, `tenants/${t.id}/`, 100)) await storage.remove(storage.exports, key);
    for (const key of await storage.listKeys(storage.clean, `tenants/${t.id}/`, 100)) await storage.remove(storage.clean, key);
  }
  await shard.$disconnect();
  await migrator.$disconnect();
  await pruneTestTenants({ platformMigratorUrl: process.env.PLATFORM_MIGRATOR_URL, tenantMigratorUrl: process.env.TENANT_POOL_01_MIGRATOR_URL }, PREFIX);
  await worker.close();
  await tenantApp.close();
});

describe('[Q1, T35] who may ask', () => {
  it('an IT Admin of the whole institution, with MFA and a fresh step-up; anyone else is refused, and nothing is written', async () => {
    const i = await institution();
    fresh();
    expect((await call(i.host, 'POST', '/api/v1/exports')).status).toBe(401);
    expect((await call(i.host, 'POST', '/api/v1/exports', { cookie: await signIn(i, i.student) })).body.code).toBe('auth.forbidden');
    // Privileged without a factor: the session is for enrolling one only.
    expect(['auth.mfa_required', 'auth.mfa_enrolment_required']).toContain((await call(i.host, 'POST', '/api/v1/exports', { cookie: await signIn(i, i.plainAdmin) })).body.code);
    expect((await call(i.host, 'POST', '/api/v1/exports', { cookie: await signIn(i, i.admin, false) })).body.code).toBe('auth.step_up_required');
    // A department's administrator holds the permission, but not over the whole institution.
    expect((await call(i.host, 'POST', '/api/v1/exports', { cookie: await signIn(i, i.scoped) })).status).toBeGreaterThanOrEqual(403);
    expect((await call(i.host, 'GET', '/api/v1/exports', { cookie: await signIn(i, i.scoped) })).status).toBeGreaterThanOrEqual(403);
    expect(await forTenant(shard, i.id).dataExport.count()).toBe(0);
  });
});

describe('[Q7, Q8, Q-B2 to Q-B7] the request, the build and the archive', () => {
  it('answers with the passphrase once, seals it, builds the archive, and the archive matches the institution and holds no secret', async () => {
    const i = await institution();
    fresh();
    const sid = await signIn(i, i.admin);
    const req = await call(i.host, 'POST', '/api/v1/exports', { cookie: sid });
    expect(req.status).toBe(201);
    const passphrase = String(req.body.passphrase);
    expect(passphrase).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){5}$/);
    const id = (req.body.export as { id: string }).id;
    expect(req.body.export).toMatchObject({ state: 'REQUESTED', downloadable: false, sizeBytes: null });
    expect(req.headers['cache-control']).toContain('no-store');

    // Q-B4: sealed under the institution's key, bound to this export; never in the clear.
    const sealed = await exportRow(i, id);
    expect(sealed.passphraseEnc).not.toContain(passphrase);
    expect((await crypto.decrypt(i.id, sealed.passphraseEnc ?? '', exportPassphraseAad(i.id, id))).toString()).toBe(passphrase);
    // The list never shows it again.
    const listed = await call(i.host, 'GET', '/api/v1/exports', { cookie: sid });
    expect(JSON.stringify(listed.body)).not.toContain(passphrase);
    // Q-B5: one at a time.
    expect((await call(i.host, 'POST', '/api/v1/exports', { cookie: sid })).body.code).toBe('export.in_progress');

    const counts = await runPass();
    expect(counts.offered).toBe(1);
    const built = await exportRow(i, id);
    expect([built.state, built.lastError]).toEqual(['READY', null]);
    expect(built.passphraseEnc).toBeNull();
    expect(built.objectKey?.startsWith(`tenants/${i.id}/exports/${id}/`)).toBe(true);
    expect(await audits(i, id)).toEqual(['USER:data.export.requested', 'SYSTEM:data.export.ready']);

    // Q-B7: the platform's mirror: state and counts, nothing else.
    const mirror = await migrator.platformTenantExport.findUniqueOrThrow({ where: { id } });
    expect(mirror).toMatchObject({ tenantId: i.id, state: 'READY', sizeBytes: built.sizeBytes, tables: built.tables, rows: built.rows, files: 1 });
    const mirrorColumns = await migrator.$queryRaw<{ column_name: string }[]>`SELECT column_name FROM information_schema.columns WHERE table_name = 'platform_tenant_export'`;
    expect(mirrorColumns.map((c) => c.column_name).sort()).toEqual(['expired_at', 'expires_at', 'failed_at', 'files', 'id', 'ready_at', 'requested_at', 'rows', 'size_bytes', 'state', 'tables', 'tenant_id', 'updated_at']);

    // The download: the archive's bytes are the row's.
    const dl = await call(i.host, 'GET', `/api/v1/exports/${id}/content`, { cookie: sid });
    expect(dl.status).toBe(200);
    expect(dl.headers['content-type']).toBe('application/zip');
    expect(String(dl.headers['content-disposition'])).toContain('attachment');
    expect(createHash('sha256').update(dl.raw).digest('hex')).toBe(Buffer.from(built.sha256 ?? new Uint8Array()).toString('hex'));
    expect(BigInt(dl.raw.length)).toBe(built.sizeBytes);
    expect((await audits(i, id)).at(-1)).toBe('USER:data.export.downloaded');

    // Q8: AES-256 only. It doesn't open without the passphrase, or with another.
    const bad = new ZipReader(new Uint8ArrayReader(new Uint8Array(dl.raw)));
    const first = (await bad.getEntries()).find((e) => !e.directory);
    if (first?.directory !== false) throw new Error('the archive has no file');
    await expect(first.getData(new TextWriter())).rejects.toThrow();
    await expect(first.getData(new TextWriter(), { password: 'WRONG-WRONG-WRONG-WRONG-WRONG-WRONG' })).rejects.toThrow();
    await bad.close();
    expect(dl.raw.readUInt16LE(8)).toBe(99); // the WinZip AES method, not ZipCrypto
    const files = await readArchive(dl.raw, passphrase);

    // Criterion 4: every table's rows, counted against the database at the snapshot.
    const manifest = JSON.parse(files.get('manifest.json')?.toString('utf8') ?? '{}') as { snapshotAt: string; tables: { name: string; rows: number; sha256: string; file: string }[]; files: { id: string; path: string; sha256: string; matches: boolean }[]; excludedTables: Record<string, string> };
    expect(manifest.tables.map((x) => x.name).sort()).toEqual(EXPORTED_TABLES.map((x) => x.table).sort());
    const manifestAt = manifest.snapshotAt;
    for (const tbl of manifest.tables) {
      // The audit trail grows after the snapshot (the export's own "ready" and "downloaded"): counted up to its moment.
      const sql = tbl.name === 'audit_event' ? `SELECT count(*)::int AS n FROM audit_event WHERE tenant_id = $1::uuid AND occurred_at <= $2::timestamptz` : `SELECT count(*)::int AS n FROM ${tbl.name} WHERE tenant_id = $1::uuid`;
      const [{ n }] = (await shard.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${i.id}, true)`;
        return tbl.name === 'audit_event' ? tx.$queryRawUnsafe<{ n: number }[]>(sql, i.id, manifestAt) : tx.$queryRawUnsafe<{ n: number }[]>(sql, i.id);
      })) as [{ n: number }];
      expect([tbl.name, tbl.rows]).toEqual([tbl.name, n]);
      const body = files.get(tbl.file) ?? Buffer.alloc(0);
      expect(body.toString('utf8').split('\n').filter(Boolean)).toHaveLength(n);
      expect(createHash('sha256').update(body).digest('hex')).toBe(tbl.sha256);
    }
    expect(Object.keys(manifest.excludedTables).sort()).toEqual(Object.keys(EXCLUDED_TABLES).sort());
    for (const name of Object.keys(EXCLUDED_TABLES)) expect(files.has(`tables/${name}.jsonl`)).toBe(false);

    // Q-B3: no excluded column in any row, the address decrypted, and none of the secrets anywhere in the archive.
    for (const tbl of EXPORTED_TABLES) {
      for (const line of (files.get(`tables/${tbl.table}.jsonl`) ?? Buffer.alloc(0)).toString('utf8').split('\n').filter(Boolean)) {
        const keys = Object.keys(JSON.parse(line) as object);
        expect(keys).toEqual([...tbl.columns]);
        for (const col of [...Object.keys(tbl.excluded), ...Object.keys(tbl.decrypted ?? {})]) expect(keys).not.toContain(col);
      }
    }
    const contact = (files.get('tables/contact_change.jsonl') ?? Buffer.alloc(0)).toString('utf8');
    expect(contact).toContain(i.address);
    const everything = Buffer.concat([...files.values()]).toString('latin1');
    const users = await forTenant(shard, i.id).userAccount.findMany({ select: { passwordHash: true } });
    for (const u of users) expect(everything).not.toContain(u.passwordHash ?? 'none');
    const factors = await forTenant(shard, i.id).mfaFactor.findMany({ select: { secretEnc: true } });
    for (const f of factors) expect(everything).not.toContain(f.secretEnc);
    expect(everything).not.toContain(i.totpSecretHex);
    const hashes = [
      ...(await forTenant(shard, i.id).recoveryCode.findMany({ select: { codeHash: true } })).map((r) => r.codeHash),
      ...(await forTenant(shard, i.id).oneTimeToken.findMany({ select: { tokenHash: true } })).map((r) => r.tokenHash),
      ...(await forTenant(shard, i.id).session.findMany({ select: { tokenHash: true } })).map((r) => r.tokenHash),
      ...(await forTenant(shard, i.id).contactChange.findMany({ select: { codeHash: true, newAddressHash: true } })).flatMap((r) => [r.codeHash, r.newAddressHash]),
    ].filter((b): b is Uint8Array<ArrayBuffer> => b !== null);
    expect(hashes.length).toBeGreaterThan(4);
    for (const h of hashes) expect(everything).not.toContain(Buffer.from(h).toString('hex'));
    expect(everything).not.toContain(passphrase);

    // Q-B2: the clean file, as uploaded, under a safe name; the deleted one isn't there.
    expect(manifest.files).toHaveLength(1);
    expect(manifest.files[0]).toMatchObject({ id: i.fileId, matches: true, path: `files/${i.fileId}/_Transcript_ 2025_.pdf` });
    expect(files.get(manifest.files[0]!.path)?.equals(i.fileBytes)).toBe(true);
    expect(files.get('README.txt')?.toString('utf8')).toContain('Nothing in this archive lets anyone sign in');

    // Q-B5: within a day, another is refused.
    expect((await call(i.host, 'POST', '/api/v1/exports', { cookie: sid })).body.code).toBe('export.too_soon');
    expect((await call(i.host, 'GET', '/api/v1/exports', { cookie: sid })).body.nextAllowedAt).toBeTruthy();
  });

  it('opens in 7-Zip, an archive tool outside UniVarse (required in CI)', async () => {
    const z = spawnSync('7z', ['i'], { encoding: 'utf8' });
    if (z.error) {
      expect(process.env.CI, '7-Zip must be on the CI runner').toBeFalsy();
      return;
    }
    const i = await institution();
    fresh();
    const sid = await signIn(i, i.admin);
    const req = await call(i.host, 'POST', '/api/v1/exports', { cookie: sid });
    await runPass();
    const dl = await call(i.host, 'GET', `/api/v1/exports/${(req.body.export as { id: string }).id}/content`, { cookie: sid });
    const dir = mkdtempSync(join(tmpdir(), 'uv-export-'));
    try {
      const file = join(dir, 'export.zip');
      writeFileSync(file, dl.raw);
      // `t`: test every entry with the passphrase; a wrong one fails.
      expect(execFileSync('7z', ['t', `-p${String(req.body.passphrase)}`, file], { encoding: 'utf8' })).toContain('Everything is Ok');
      expect(spawnSync('7z', ['t', '-pWRONG', file], { encoding: 'utf8' }).status).not.toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('[Q8, Q-B9, T35] the download', () => {
  it('only here, by an IT Admin stepped up; another institution\'s export, a malformed id or one not ready is refused', async () => {
    const a = await institution();
    const b = await institution();
    fresh();
    const sa = await signIn(a, a.admin);
    const sb = await signIn(b, b.admin);
    const id = ((await call(a.host, 'POST', '/api/v1/exports', { cookie: sa })).body.export as { id: string }).id;
    // Not ready yet.
    expect((await call(a.host, 'GET', `/api/v1/exports/${id}/content`, { cookie: sa })).body.code).toBe('export.not_ready');
    await runPass();
    expect((await call(a.host, 'GET', `/api/v1/exports/${id}/content`, { cookie: sa })).status).toBe(200);
    // Another institution's IT Admin, at their own address, with this id: the same 404 as no export.
    expect((await call(b.host, 'GET', `/api/v1/exports/${id}/content`, { cookie: sb })).status).toBe(404);
    expect((await call(b.host, 'GET', `/api/v1/exports/${randomUUID()}/content`, { cookie: sb })).status).toBe(404);
    expect((await call(a.host, 'GET', '/api/v1/exports/not-an-id/content', { cookie: sa })).status).toBe(404);
    // b's list shows none of a's.
    expect(((await call(b.host, 'GET', '/api/v1/exports', { cookie: sb })).body.data as unknown[]).length).toBe(0);
    // A session from a's host doesn't work at b's.
    expect((await call(b.host, 'GET', `/api/v1/exports/${id}/content`, { cookie: sa })).status).toBe(401);
    // Without a fresh step-up, or as a student: refused, and no download audited.
    const before = (await audits(a, id)).length;
    expect((await call(a.host, 'GET', `/api/v1/exports/${id}/content`, { cookie: await signIn(a, a.admin, false) })).body.code).toBe('auth.step_up_required');
    expect((await call(a.host, 'GET', `/api/v1/exports/${id}/content`, { cookie: await signIn(a, a.student) })).body.code).toBe('auth.forbidden');
    expect((await audits(a, id)).length).toBe(before);
  });

  it('is gone after 7 days: the archive deleted first, then the row expired, audited; and a closed institution\'s waiting export fails', async () => {
    const i = await institution();
    fresh();
    const sid = await signIn(i, i.admin);
    const id = ((await call(i.host, 'POST', '/api/v1/exports', { cookie: sid })).body.export as { id: string }).id;
    await runPass();
    const ready = await exportRow(i, id);
    await runPass(new Date((ready.expiresAt?.getTime() ?? 0) - 1000));
    expect((await exportRow(i, id)).state).toBe('READY');
    const counts = await runPass(new Date((ready.expiresAt?.getTime() ?? 0) + 1000));
    expect(counts.expired).toBe(1);
    expect((await exportRow(i, id)).state).toBe('EXPIRED');
    expect((await storage.stream(storage.exports, ready.objectKey ?? '')).kind).toBe('missing');
    expect((await migrator.platformTenantExport.findUniqueOrThrow({ where: { id } })).state).toBe('EXPIRED');
    expect((await audits(i, id)).at(-1)).toBe('SYSTEM:data.export.expired');
    expect((await call(i.host, 'GET', `/api/v1/exports/${id}/content`, { cookie: sid })).body.code).toBe('export.not_ready');

    // Q5: an institution archived while its export waits gets none; its passphrase is wiped.
    const c = await institution();
    fresh();
    const cid = ((await call(c.host, 'POST', '/api/v1/exports', { cookie: await signIn(c, c.admin) })).body.export as { id: string }).id;
    await pass.pass(new Date(), () => Promise.resolve()); // mirrored, not built
    await migrator.tenant.update({ where: { id: c.id }, data: { status: 'ARCHIVED' } });
    expect(await builder.build(cid)).toBe('skipped');
    const closed = await pass.pass(new Date(), () => Promise.resolve());
    expect(closed.closedFailed).toBe(1);
    expect(await exportRow(c, cid)).toMatchObject({ state: 'FAILED', passphraseEnc: null, lastError: 'InstitutionClosed' });
    expect((await audits(c, cid)).at(-1)).toBe('SYSTEM:data.export.failed');
  });
});

describe('[Q1, T35] the use case checks again, whatever reached it', () => {
  it('refuses an actor whose grant is a department’s, at an institution not served, and a row naming an archive outside its own', async () => {
    const i = await institution();
    const service = tenantApp.get(ExportsService);
    const tenant = { tenantId: i.id, shardId: poolId, slug: 'x', shortName: 'x', legalName: 'x', type: 'UNIVERSITY', status: 'ACTIVE', primaryColor: null, logoSha256: null, closesAt: null, shardStatus: 'ACTIVE' } satisfies TenantContext;
    const actor = (scopeType: string, tenantId = i.id): Actor => ({
      tenantId,
      userId: i.admin.id,
      sessionId: randomUUID(),
      username: i.admin.username,
      displayName: 'x',
      mfaAt: new Date(),
      restricted: false,
      stepUpAt: new Date(),
      grants: [{ permission: 'data.export.request', scopeType, scopeId: scopeType === 'INSTITUTION' ? null : randomUUID(), roleKey: 'INSTITUTION_ADMIN' }],
    } as unknown as Actor);
    const meta = { ip: '127.0.0.1', userAgent: 'test', requestId: 'r' };
    // A department's grant, past every guard: still the same 404 as nothing.
    await expect(service.request(tenant, actor('ORG_UNIT'), meta)).rejects.toMatchObject({ status: 404 });
    await expect(service.list(tenant, actor('ORG_UNIT'))).rejects.toMatchObject({ status: 404 });
    // At an institution that isn't served (the guard answers first; the use case refuses too).
    await expect(service.request({ ...tenant, status: 'SUSPENDED' }, actor('INSTITUTION'), meta)).rejects.toMatchObject({ status: 404 });
    expect(await forTenant(shard, i.id).dataExport.count()).toBe(0);

    // A ready row whose archive key isn't under this export's own prefix is never streamed.
    const id = randomUUID();
    const now = new Date();
    await forTenant(shard, i.id).dataExport.create({
      data: { id, tenantId: i.id, state: 'READY', objectKey: `tenants/${randomUUID()}/exports/${id}/${randomUUID()}.zip`, sizeBytes: 1n, sha256: randomBytes(32), tables: 1, rows: 1n, files: 0, readyAt: now, expiresAt: new Date(now.getTime() + DAY) },
    });
    await expect(service.download(tenant, actor('INSTITUTION'), id, meta)).rejects.toMatchObject({ status: 404 });
    expect(await audits(i, id)).toEqual([]);
  });
});

describe('[Q-B5] a build that fails', () => {
  it('is tried three times, then FAILED with its passphrase wiped; a failure doesn\'t count against the day', async () => {
    const i = await institution();
    fresh();
    const sid = await signIn(i, i.admin);
    const id = ((await call(i.host, 'POST', '/api/v1/exports', { cookie: sid })).body.export as { id: string }).id;
    // The pass mirrors it first: the builder takes the institution from the mirror, never from the job.
    expect(await builder.build(id)).toBe('skipped');
    await pass.pass(new Date(), () => Promise.resolve());
    const spy = vi.spyOn(storage, 'multipart').mockRejectedValue(Object.assign(new Error('storage down'), { name: 'StorageDown' }));
    try {
      let now = Date.now();
      expect(await builder.build(id, new Date(now))).toBe('retry');
      expect(await exportRow(i, id)).toMatchObject({ state: 'BUILDING', attempts: 1, lastError: 'StorageDown' });
      // Its lease is let go for a minute: an immediate second claim is refused.
      expect(await builder.build(id, new Date(now + 1000))).toBe('skipped');
      now += 2 * 60_000;
      expect(await builder.build(id, new Date(now))).toBe('retry');
      now += 2 * 60_000;
      expect(await builder.build(id, new Date(now))).toBe('failed');
    } finally {
      spy.mockRestore();
    }
    expect(await exportRow(i, id)).toMatchObject({ state: 'FAILED', attempts: 3, passphraseEnc: null });
    expect((await audits(i, id)).at(-1)).toBe('SYSTEM:data.export.failed');
    // Nothing left behind in the bucket.
    expect(await storage.listKeys(storage.exports, `tenants/${i.id}/exports/${id}/`, 10)).toEqual([]);
    // Another can be asked for at once.
    expect((await call(i.host, 'POST', '/api/v1/exports', { cookie: sid })).status).toBe(201);
  });

  it('a builder that lost its lease to another seals nothing over the other\'s archive', async () => {
    const i = await institution();
    fresh();
    const id = ((await call(i.host, 'POST', '/api/v1/exports', { cookie: await signIn(i, i.admin) })).body.export as { id: string }).id;
    await pass.pass(new Date(), () => Promise.resolve());
    // The first builder claims, then stalls past its lease while uploading; a second claims and finishes.
    const real = storage.multipart.bind(storage);
    const second: { done?: Promise<string> } = {};
    const spy = vi.spyOn(storage, 'multipart').mockImplementationOnce(async (bucket, key, type) => {
      const w = await real(bucket, key, type);
      second.done = builder.build(id, new Date(Date.now() + 31 * 60_000));
      await second.done;
      return w;
    });
    try {
      expect(await builder.build(id)).toBe('skipped');
    } finally {
      spy.mockRestore();
    }
    expect(await second.done).toBe('ready');
    const row = await exportRow(i, id);
    expect(row.state).toBe('READY');
    // Only the winner's archive is there.
    expect(await storage.listKeys(storage.exports, `tenants/${i.id}/exports/${id}/`, 10)).toEqual([row.objectKey]);
  });
});

describe('[Q-B5] a builder’s claim', () => {
  it('a builder whose lease another has taken seals nothing, even before the other finishes', async () => {
    const i = await institution();
    fresh();
    const id = (await call(i.host, 'POST', '/api/v1/exports', { cookie: await signIn(i, i.admin) })).body.export as { id: string };
    await pass.pass(new Date(), () => Promise.resolve());
    const other = randomUUID();
    const real = storage.multipart.bind(storage);
    const spy = vi.spyOn(storage, 'multipart').mockImplementationOnce(async (bucket, key, type) => {
      const w = await real(bucket, key, type);
      // Another builder claims it now (as after a lapsed lease) and is still working.
      await forTenant(shard, i.id).dataExport.update({ where: { id: id.id }, data: { leaseToken: other } });
      return w;
    });
    try {
      expect(await builder.build(id.id)).toBe('skipped');
    } finally {
      spy.mockRestore();
    }
    expect(await exportRow(i, id.id)).toMatchObject({ state: 'BUILDING', leaseToken: other, objectKey: null });
    expect(await storage.listKeys(storage.exports, `tenants/${i.id}/exports/${id.id}/`, 10)).toEqual([]);
  });

  it('a build that died past its last attempt (a crash, not a caught failure) fails, its passphrase wiped', async () => {
    const i = await institution();
    fresh();
    const id = (await call(i.host, 'POST', '/api/v1/exports', { cookie: await signIn(i, i.admin) })).body.export as { id: string };
    await pass.pass(new Date(), () => Promise.resolve());
    await forTenant(shard, i.id).dataExport.update({ where: { id: id.id }, data: { state: 'BUILDING', attempts: 3, leaseUntil: new Date(Date.now() - 1000) } });
    expect(await builder.build(id.id)).toBe('failed');
    expect(await exportRow(i, id.id)).toMatchObject({ state: 'FAILED', passphraseEnc: null, lastError: 'TooManyAttempts' });
  });
});

describe('[Q7] the database', () => {
  it('keeps one export open at a time, its steps only forward, its passphrase only while needed, and its record undeletable', async () => {
    const i = await institution();
    const db = forTenant(shard, i.id);
    const seal = async (id: string) => crypto.encrypt(i.id, Buffer.from('X'), exportPassphraseAad(i.id, id));
    const a = await db.dataExport.create({ data: { tenantId: i.id, passphraseEnc: 'v2:1:placeholder' }, select: { id: true } });
    await expect(db.dataExport.create({ data: { tenantId: i.id, passphraseEnc: await seal('x') } })).rejects.toThrow();
    // No passphrase while waiting: refused.
    await expect(db.dataExport.update({ where: { id: a.id }, data: { passphraseEnc: null } })).rejects.toThrow();
    // Backwards: refused.
    await db.dataExport.update({ where: { id: a.id }, data: { state: 'FAILED', passphraseEnc: null, failedAt: new Date() } });
    await expect(db.dataExport.update({ where: { id: a.id }, data: { state: 'REQUESTED', passphraseEnc: 'v2:1:again', failedAt: null } })).rejects.toThrow(/only go forward/);
    await expect(db.dataExport.update({ where: { id: a.id }, data: { lastError: 'x' } })).rejects.toThrow(/only go forward/);
    // Who asked never changes.
    const b = await db.dataExport.create({ data: { tenantId: i.id, passphraseEnc: 'v2:1:placeholder' }, select: { id: true } });
    await expect(db.dataExport.update({ where: { id: b.id }, data: { requestedAt: new Date(0) } })).rejects.toThrow(/request can't change/);
    // The app's role can't delete one.
    const app = createTenantShardClient(process.env.TENANT_POOL_01_DATABASE_URL!);
    try {
      await expect(forTenant(app, i.id).dataExport.deleteMany({ where: { id: b.id } })).rejects.toThrow();
    } finally {
      await app.$disconnect();
    }
  });
});
