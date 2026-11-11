/**
 * Spec 0033 Q11, Q12 (PR C): an institution's colour and logo on its own host, and only there.
 * Prereqs: `pnpm db:migrate && pnpm db:seed`. Branding is written as the migrator, as the console's writes are
 * covered by the registry's own spec; the row the test finds is put back afterwards.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createPlatformClient, type PlatformClient } from '@univarse/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../bootstrap.js';
import { loadConfig } from '../../config/config.js';
import { TenantResolver } from '../../shared/tenancy/tenant-resolver.service.js';
import { attachConformance } from '../../testing/conformance.js';

const rootEnv = new URL('../../../../../.env', import.meta.url);
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const DEMO = 'demo-uni.univarse.localhost';
const POLY = 'test-poly.univarse.localhost';

/** A PNG's signature and header for a 64×32 image, with distinct trailing bytes per call. */
const png = (marker: number) => {
  const b = Buffer.alloc(8 + 25 + 4, 0);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(64, 16);
  b.writeUInt32BE(32, 20);
  b.writeUInt32BE(marker, 33);
  return b;
};
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

let app: NestFastifyApplication;
let migrator: PlatformClient;
type Row = { primaryColor: string | null; logo: Uint8Array | null; logoMime: string | null; logoSha256: string | null } | null;
let polyId: string;
let demoId: string;
let before: Row;
let demoBefore: Row;

const get = (url: string, host: string, headers: Record<string, string> = {}) =>
  app.getHttpAdapter().getInstance().inject({ method: 'GET', url, headers: { host, ...headers } });

const brand = async (primaryColor: string | null, logo: Buffer | null, mime = 'image/png', tenantId = polyId) => {
  const data = { primaryColor, logo: logo ? new Uint8Array(logo) : null, logoMime: logo ? mime : null, logoSha256: logo ? sha(logo) : null, updatedAt: new Date() };
  await migrator.tenantBranding.upsert({ where: { tenantId }, create: { tenantId, ...data }, update: data, select: { tenantId: true } });
  // The relay carries the capture in the running stack; here the cache is cleared as its message would.
  app.get(TenantResolver).invalidate();
};

beforeAll(async () => {
  app = await createApp(loadConfig({ ...process.env, NODE_ENV: 'test' }), { beforeInit: attachConformance });
  migrator = createPlatformClient(process.env.PLATFORM_MIGRATOR_URL!);
  polyId = (await migrator.tenant.findUniqueOrThrow({ where: { slug: 'test-poly' }, select: { id: true } })).id;
  demoId = (await migrator.tenant.findUniqueOrThrow({ where: { slug: 'demo-uni' }, select: { id: true } })).id;
  const select = { primaryColor: true, logo: true, logoMime: true, logoSha256: true } as const;
  before = await migrator.tenantBranding.findUnique({ where: { tenantId: polyId }, select });
  demoBefore = await migrator.tenantBranding.findUnique({ where: { tenantId: demoId }, select });
});

afterAll(async () => {
  for (const [tenantId, row] of [[polyId, before], [demoId, demoBefore]] as const) {
    if (row) await migrator.tenantBranding.update({ where: { tenantId }, data: { ...row, logo: row.logo ? new Uint8Array(row.logo) : null, updatedAt: new Date() }, select: { tenantId: true } });
    else await migrator.tenantBranding.deleteMany({ where: { tenantId } });
  }
  await migrator.$disconnect();
  await app.close();
});

describe('[BR1] without branding, UniVarse’s own', () => {
  it('the profile has no colour or logo, and the logo route is 404', async () => {
    await brand(null, null);
    expect((await get('/api/v1/tenant/public-profile', POLY)).json()).toMatchObject({ slug: 'test-poly', branding: { primaryColor: null, textColor: null, logoSha256: null } });
    const res = await get('/api/v1/tenant/logo', POLY);
    expect([res.statusCode, res.json().code]).toEqual([404, 'resource.not_found']);
  });
});

describe('[BR2] with branding, on its own host', () => {
  const logo = png(1);

  it('the profile carries the colour, the text colour the domain chose for it, and the logo’s hash', async () => {
    await brand('#0B3D91', logo);
    const p = (await get('/api/v1/tenant/public-profile', POLY)).json();
    expect(p.branding).toEqual({ primaryColor: '#0B3D91', textColor: '#FFFFFF', logoSha256: sha(logo) });
    await brand('#F2D16B', logo);
    expect((await get('/api/v1/tenant/public-profile', POLY)).json().branding.textColor).toBe('#485550');
  });

  it('serves the bytes as their checked type, with the hash as the ETag and nosniff', async () => {
    const res = await get('/api/v1/tenant/logo', POLY);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers.etag).toBe(`"${sha(logo)}"`);
    expect(Buffer.compare(res.rawPayload, logo)).toBe(0);
  });

  it('answers 304 with no body to a browser that has it, and 200 to one that has another', async () => {
    const same = await get('/api/v1/tenant/logo', POLY, { 'if-none-match': `"${sha(logo)}"` });
    expect([same.statusCode, same.rawPayload.length]).toEqual([304, 0]);
    const other = await get('/api/v1/tenant/logo', POLY, { 'if-none-match': `"${sha(png(9))}"` });
    expect(other.statusCode).toBe(200);
  });

  it('may be kept only when asked for under its own hash; any other request is no-store', async () => {
    const own = await get(`/api/v1/tenant/logo?v=${sha(logo)}`, POLY);
    expect([own.statusCode, own.headers['cache-control']]).toEqual([200, 'public, max-age=31536000, immutable']);
    const old = await get(`/api/v1/tenant/logo?v=${sha(png(9))}`, POLY);
    expect([old.statusCode, old.headers['cache-control']]).toEqual([200, 'no-store']);
    expect((await get('/api/v1/tenant/logo', POLY)).headers['cache-control']).toBe('no-store');
    const bad = await get('/api/v1/tenant/logo?v=x&w=1', POLY);
    expect([bad.statusCode, bad.json().code]).toEqual([400, 'request.invalid']);
    // A 404 is never cacheable, whatever was asked for.
    expect((await get(`/api/v1/tenant/logo?v=${sha(logo)}`, DEMO)).headers['cache-control']).toBe('no-store');
  });

  it('serves a WebP logo as WebP', async () => {
    const webp = png(5); // the route serves the stored, checked type; the bytes' format was checked on upload
    await brand('#F2D16B', webp, 'image/webp');
    const res = await get(`/api/v1/tenant/logo?v=${sha(webp)}`, POLY);
    expect([res.statusCode, res.headers['content-type'], res.headers['cache-control']]).toEqual([200, 'image/webp', 'public, max-age=31536000, immutable']);
    await brand('#F2D16B', logo);
  });

  it('a new logo is served under its new hash, not the cached one', async () => {
    const next = png(2);
    await brand('#F2D16B', next);
    const res = await get('/api/v1/tenant/logo', POLY);
    expect(res.headers.etag).toBe(`"${sha(next)}"`);
    expect(Buffer.compare(res.rawPayload, next)).toBe(0);
  });
});

describe('[BR3] never another institution’s', () => {
  it('another host gets its own (none here), whatever hash it is asked for', async () => {
    const polyHash = (await get('/api/v1/tenant/public-profile', POLY)).json().branding.logoSha256 as string;
    expect(polyHash).toMatch(/^[0-9a-f]{64}$/);
    const res = await get(`/api/v1/tenant/logo?v=${polyHash}`, DEMO, { 'if-none-match': `"${polyHash}"` });
    expect([res.statusCode, res.json().code]).toEqual([404, 'resource.not_found']);
    expect((await get('/api/v1/tenant/public-profile', DEMO)).json().branding).toEqual({ primaryColor: null, textColor: null, logoSha256: null });
  });

  it('with both institutions branded, each host serves its own logo, never the other’s', async () => {
    const polyLogo = png(3);
    const demoLogo = png(4);
    await brand('#0B3D91', polyLogo);
    await brand(null, demoLogo, 'image/png', demoId);
    const p = await get('/api/v1/tenant/logo', POLY);
    const d = await get('/api/v1/tenant/logo', DEMO);
    expect([p.headers.etag, d.headers.etag]).toEqual([`"${sha(polyLogo)}"`, `"${sha(demoLogo)}"`]);
    expect(Buffer.compare(p.rawPayload, polyLogo)).toBe(0);
    expect(Buffer.compare(d.rawPayload, demoLogo)).toBe(0);
    // Asking one host for the other's version changes nothing.
    expect((await get(`/api/v1/tenant/logo?v=${sha(polyLogo)}`, DEMO)).headers.etag).toBe(`"${sha(demoLogo)}"`);
    await brand(null, null, 'image/png', demoId);
  });

  it('an unknown host is refused before any logo is read', async () => {
    const res = await get('/api/v1/tenant/logo', 'nobody.univarse.localhost');
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toMatch(/problem\+json/);
  });
});
