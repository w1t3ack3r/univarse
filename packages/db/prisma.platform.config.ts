import { existsSync } from 'node:fs';
import { defineConfig } from 'prisma/config';

// Repo-root .env (git-ignored); real env vars win.
if (existsSync('../../.env')) process.loadEnvFile('../../.env');

export default defineConfig({
  schema: 'prisma/platform/schema.prisma',
  migrations: { path: 'prisma/platform/migrations' },
  datasource: { url: process.env.PLATFORM_MIGRATOR_URL ?? 'postgresql://unset' },
});
