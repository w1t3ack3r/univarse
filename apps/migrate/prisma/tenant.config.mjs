// The migrate image's Prisma config for the tenant pool (spec 0019 D3). See platform.config.mjs.
import { schemaEngineUrl } from '../dist/tls.js';

export default {
  schema: 'tenant/schema.prisma',
  migrations: { path: 'tenant/migrations' },
  datasource: { url: schemaEngineUrl('TENANT_POOL_01_MIGRATOR_URL') },
};
