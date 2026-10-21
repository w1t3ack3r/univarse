// Spec 0019 B6/LS5: `pnpm stack:isolation` runs spec 0017's PB1 and PB2 through the stack's PgBouncer
// (isolation.probe.ts), over the temporary loopback tunnel, with settings from STACK_DIR. The tunnel is removed
// afterwards, whatever happened, and checked gone.
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { REPO } from './config.js';
import { runNode, stackProblems } from './e2e.js';
import { loadSecrets } from './secrets.js';
import { testEnv, writeCaBundle } from './test-env.js';
import { withTunnel } from './tunnel.js';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const problems = stackProblems();
  if (problems.length) {
    for (const p of problems) console.error(`[stack:isolation] ${p}`);
    process.exit(1);
  }
  const env = testEnv(loadSecrets(), writeCaBundle());
  try {
    const stack = join(REPO, 'tools', 'stack');
    const code = await withTunnel(() => runNode(join(stack, 'node_modules', 'vitest', 'vitest.mjs'), ['run', '--config', 'vitest.isolation.config.ts', '--reporter=verbose'], stack, env));
    console.log('[stack:isolation] the tunnel was removed and is gone (no container; 127.0.0.1 port closed)');
    process.exit(code);
  } catch (e) {
    console.error(`[stack:isolation] ${(e as Error).message}`);
    process.exit(1);
  }
}
