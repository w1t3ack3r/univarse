export { createTenantShardClient, forTenant, withTenantTx } from './tenant.js';
export type { TenantShardClient, TenantTx } from './tenant.js';
export { createPlatformClient } from './platform.js';
export type { PlatformClient } from './platform.js';
export * as TenantModels from './generated/tenant/client.js';
export * as PlatformModels from './generated/platform/client.js';
