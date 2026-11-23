// The migrate image's Prisma config for a tenant database (spec 0019 D3, spec 0039 Q9): the job sets TENANT_MIGRATE_URL
// to each shard's migrator URL in turn. See platform.config.mjs.
import { schemaEngineUrl } from '../dist/tls.js';

export default {
  schema: 'tenant/schema.prisma',
  migrations: { path: 'tenant/migrations' },
  datasource: { url: schemaEngineUrl('TENANT_MIGRATE_URL') },
};
