// Test-only helpers for spec 0038's export (the web E2E imports them from here, as it does mfa-helpers): open an archive
// with its passphrase, and clear an institution's recent exports with their archives, so a test can ask for one again
// within the day. Never used by the app.
import { DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createPlatformClient, createTenantShardClient, forTenant } from '@univarse/db';
import { configure, TextWriter, Uint8ArrayReader, ZipReader } from '@zip.js/zip.js';

configure({ useWebWorkers: false });

/** The archive's entry names and its manifest, read with the passphrase (any entry fails without it). */
export async function openExport(bytes: Uint8Array, passphrase: string): Promise<{ names: string[]; manifest: { institution: { slug: string }; tables: { name: string; rows: number }[] } }> {
  const zip = new ZipReader(new Uint8ArrayReader(bytes));
  try {
    const entries = await zip.getEntries();
    const m = entries.find((e) => e.filename === 'manifest.json');
    if (!m || m.directory) throw new Error('the archive has no manifest');
    const manifest = JSON.parse(await m.getData(new TextWriter(), { password: passphrase })) as { institution: { slug: string }; tables: { name: string; rows: number }[] };
    return { names: entries.map((e) => e.filename), manifest };
  } finally {
    await zip.close();
  }
}

/**
 * Removes `tenantId`'s exports asked for within the last two days, archives first, and their platform mirrors. As the
 * migrators (the app's role can't delete an export); `env` holds the dev chain's settings.
 */
export async function clearRecentExports(env: Record<string, string | undefined>, tenantId: string, ids?: readonly string[]): Promise<number> {
  const shard = createTenantShardClient(env.TENANT_POOL_01_MIGRATOR_URL!);
  // The dev chain's own S3 identity, from its settings (never a value in code).
  const credentials = { accessKeyId: env.S3_ACCESS_KEY ?? '', secretAccessKey: env['S3_SECRET_KEY'] ?? '' };
  const s3 = new S3Client({ endpoint: env.S3_ENDPOINT ?? 'http://127.0.0.1:8333', region: env.S3_REGION ?? 'us-east-1', forcePathStyle: true, credentials });
  try {
    const db = forTenant(shard, tenantId);
    const where = ids ? { id: { in: [...ids] } } : { requestedAt: { gt: new Date(Date.now() - 2 * 86_400_000) } };
    const rows = await db.dataExport.findMany({ where, select: { id: true, objectKey: true } });
    for (const r of rows) {
      if (r.objectKey?.startsWith(`tenants/${tenantId}/exports/`)) await s3.send(new DeleteObjectCommand({ Bucket: env.S3_EXPORTS_BUCKET ?? 'uv-exports', Key: r.objectKey }));
    }
    const platform = createPlatformClient(env.PLATFORM_MIGRATOR_URL!);
    try {
      await platform.platformTenantExport.deleteMany({ where: { tenantId, ...(ids ? { id: { in: [...ids] } } : { requestedAt: { gt: new Date(Date.now() - 2 * 86_400_000) } }) } });
    } finally {
      await platform.$disconnect();
    }
    return (await db.dataExport.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } })).count;
  } finally {
    s3.destroy();
    await shard.$disconnect();
  }
}
