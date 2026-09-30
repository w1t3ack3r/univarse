// Tenant-scoped database access (docs/02 §7.2, docs/07 §3.2).
// This is the ONLY sanctioned way to touch tenant data. Every operation runs in a
// transaction whose first statement sets `app.tenant_id`, which RLS policies read.
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/tenant/client.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertTenantId(tenantId: string): void {
  if (!UUID_RE.test(tenantId)) throw new Error('Invalid tenant id');
}

/** Raw client for one shard. Never use it for data access directly — wrap it with forTenant/withTenantTx. */
export function createTenantShardClient(connectionString: string): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

export type TenantShardClient = PrismaClient;

/**
 * Returns a client where every single operation is executed as
 * `BEGIN; SELECT set_config('app.tenant_id', $1, true); <op>; COMMIT`.
 */
export function forTenant(shard: TenantShardClient, tenantId: string) {
  assertTenantId(tenantId);
  return shard.$extends({
    query: {
      $allModels: {
        async $allOperations({ args, query }) {
          const [, result] = await shard.$transaction([
            shard.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`,
            query(args),
          ]);
          return result;
        },
      },
    },
  });
}

export type TenantTx = Parameters<Parameters<TenantShardClient['$transaction']>[0]>[0];

/** Interactive transaction bound to a tenant — use for multi-statement use cases. */
export async function withTenantTx<T>(
  shard: TenantShardClient,
  tenantId: string,
  fn: (tx: TenantTx) => Promise<T>,
  options?: { timeoutMs?: number },
): Promise<T> {
  assertTenantId(tenantId);
  return shard.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      return fn(tx);
    },
    { timeout: options?.timeoutMs ?? 10_000 },
  );
}
