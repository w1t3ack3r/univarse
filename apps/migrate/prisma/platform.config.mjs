// The migrate image's Prisma config for the platform database (spec 0019 D3). The schema and migrations are copied
// from packages/db/prisma at build time, beside this file; paths are relative to it. The URL is translated so
// Prisma's schema engine verifies PostgreSQL's certificate (src/tls.ts).
import { schemaEngineUrl } from '../dist/tls.js';

export default {
  schema: 'platform/schema.prisma',
  migrations: { path: 'platform/migrations' },
  datasource: { url: schemaEngineUrl('PLATFORM_MIGRATOR_URL') },
};
