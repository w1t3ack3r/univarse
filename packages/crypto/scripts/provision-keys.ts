/**
 * Spec 0006 E11: every tenant gets an ACTIVE data key. Idempotent; runs after `pnpm db:seed`
 * (and later from tenant provisioning in the console). Never prints key material.
 */
import { existsSync } from 'node:fs';
import { createPlatformClient } from '@univarse/db';
import { keyProviderFrom, provisionTenantKey } from '../src/index.js';

const rootEnv = new URL('../../../.env', import.meta.url);
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const platformUrl = process.env.PLATFORM_DATABASE_URL;
if (!platformUrl) throw new Error('PLATFORM_DATABASE_URL is required (run pnpm db:setup)');
const platform = createPlatformClient(platformUrl);
const provider = keyProviderFrom({
  KEY_PROVIDER: process.env.KEY_PROVIDER === 'local' ? 'local' : 'vault',
  NODE_ENV: process.env.NODE_ENV,
  VAULT_ADDR: process.env.VAULT_ADDR,
  VAULT_TOKEN: process.env.VAULT_TOKEN,
  VAULT_TRANSIT_MOUNT: process.env.VAULT_TRANSIT_MOUNT,
  VAULT_TRANSIT_KEY: process.env.VAULT_TRANSIT_KEY,
  LOCAL_KEK: process.env.LOCAL_KEK,
});

try {
  for (const t of await platform.tenant.findMany({ select: { id: true, slug: true }, orderBy: { slug: 'asc' } })) {
    const { version, created } = await provisionTenantKey(platform, provider, t.id);
    console.log(`  ${created ? '✓ created' : '· kept   '} data key v${version} for ${t.slug} (${provider.kekId})`);
  }
} finally {
  await platform.$disconnect();
}
