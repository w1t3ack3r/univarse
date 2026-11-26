// Spec 0039: a scratch pool's database name for a test, `univarse_pool_NN`, one no shard on the server uses yet. A
// random two-digit name collided with another scratch pool in CI (shard_server_id_database_key), so the name is
// chosen from those free. The integration files run one at a time, so nothing takes it between the read and the use.
import { randomInt } from 'node:crypto';
import type { PlatformClient } from '@univarse/db';

export async function freePoolDatabase(migrator: PlatformClient, serverId: string): Promise<string> {
  const used = new Set((await migrator.shard.findMany({ where: { serverId, database: { startsWith: 'univarse_pool_' } }, select: { database: true } })).map((s) => s.database));
  const free: string[] = [];
  for (let n = 10; n <= 99; n++) if (!used.has(`univarse_pool_${String(n)}`)) free.push(`univarse_pool_${String(n)}`);
  const pick = free[randomInt(free.length)];
  if (!pick) throw new Error('no free scratch pool name: remove the scratch pools earlier runs left on this server');
  return pick;
}
