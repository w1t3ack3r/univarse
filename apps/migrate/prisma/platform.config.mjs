// The migrate image's Prisma config for the platform database (spec 0019 D3). The schema and migrations are copied
// from packages/db/prisma at build time, beside this file; paths are relative to it.
export default {
  schema: 'platform/schema.prisma',
  migrations: { path: 'platform/migrations' },
  datasource: { url: process.env.PLATFORM_MIGRATOR_URL },
};
