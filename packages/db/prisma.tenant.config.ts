import { existsSync } from 'node:fs';
import { defineConfig } from 'prisma/config';

// Repo-root .env (git-ignored); real env vars win.
if (existsSync('../../.env')) process.loadEnvFile('../../.env');

// Migrations run as the schema owner (univarse_migrator), never as the app role.
export default defineConfig({
  schema: 'prisma/tenant/schema.prisma',
  migrations: { path: 'prisma/tenant/migrations' },
  datasource: { url: process.env.TENANT_POOL_01_MIGRATOR_URL ?? 'postgresql://unset' },
});
