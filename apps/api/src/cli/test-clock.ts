// Spec 0038 Q-D1–Q-D4: the stack's test clock, the `clock` job from the deployed API image (`pnpm stack:clock`). It
// archives one institution now, as if its window had ended: the worker's own archive and session ending, as the app's
// roles (clock.env holds their two database URLs and nothing else). Only an institution leaving that never went live;
// the slug is given twice. Everything printed is ids, slugs, codes and counts.
//
//   test-clock archive <slug> --confirm <slug>     exit 0 done (or already archived), 3 refused, 2 usage, 1 failed
import { createPlatformClient } from '@univarse/db';
import { pathToFileURL } from 'node:url';
import { OffboardingArchive } from '../modules/offboarding/offboarding-archive.js';
import { AuditWriter } from '../shared/audit/audit-writer.js';
import { ShardRegistry } from '../shared/db/db.module.js';

export const TEST_CLOCK_USAGE = 'usage: test-clock archive <slug> --confirm <slug>';

/** The arguments, or null when they aren't exactly `archive <slug> --confirm <the same slug>`. */
export function testClockArgs(argv: readonly string[]): { slug: string } | null {
  const [command, slug, flag, confirm, ...rest] = argv;
  if (command !== 'archive' || !slug || slug.startsWith('-') || flag !== '--confirm' || confirm !== slug || rest.length) return null;
  return { slug };
}

/** The shard's URL comes from the environment by its registry name (ShardRegistry), as in the worker. */
export async function main(argv: readonly string[]): Promise<number> {
  const args = testClockArgs(argv);
  if (!args) {
    console.error(TEST_CLOCK_USAGE);
    return 2;
  }
  const platform = createPlatformClient(process.env.PLATFORM_DATABASE_URL ?? '');
  const shards = new ShardRegistry(platform);
  try {
    const r = await new OffboardingArchive(platform, shards, new AuditWriter()).byTestClock(args.slug);
    console.log(JSON.stringify({ ...r, slug: args.slug }));
    return r.ok ? 0 : 3;
  } catch (e) {
    console.error((e as Error).message.split('\n')[0]?.slice(0, 200));
    return 1;
  } finally {
    await shards.onApplicationShutdown();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
