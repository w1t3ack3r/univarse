// Spec 0019 B4/LS7: `pnpm stack:e2e [playwright args]` runs the Playwright suite (desktop and mobile) against the stack
// over HTTPS, in the owner's own browser trust: it first checks the edge CA is installed (never disabling
// verification), clears only the stack's rate-limit counters, then runs the suite with the tunnel open and settings
// from STACK_DIR (never the root .env). The tunnel is removed afterwards, whatever happened, and checked gone.
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { PROJECT, REPO } from './config.js';
import { docker, type Runner } from './docker.js';
import { loadSecrets } from './secrets.js';
import { testEnv, writeCaBundle } from './test-env.js';
import { edgeCa, installedOnWindows } from './trust.js';
import { withTunnel } from './tunnel.js';

/** The stack must be up: its edge, API, web and worker, and its Valkey (for the counters). */
export function stackProblems(run: Runner = docker): string[] {
  const up = new Set(run(['ps', '--filter', `label=com.docker.compose.project=${PROJECT}`, '--format', '{{.Label "com.docker.compose.service"}}'], { allowFail: true }).stdout.split('\n').map((s) => s.trim()));
  return ['caddy', 'api', 'web', 'worker', 'valkey', 'pgbouncer'].filter((s) => !up.has(s)).map((s) => `${s} is not running: deploy the stack first (pnpm stack:deploy)`);
}

/**
 * The API's fixed-window counters (`rl:*`) in the stack's Valkey only. Caddy rightly ignores the tests' X-Forwarded-For,
 * so every test arrives from one address, and a second run inside a window would be refused by the limits themselves.
 */
export function clearRateLimits(run: Runner = docker): void {
  const script = "valkey-cli --no-auth-warning --scan --pattern 'rl:*' | xargs -r valkey-cli --no-auth-warning DEL > /dev/null";
  run(['exec', '-e', 'REDISCLI_AUTH', `${PROJECT}-valkey-1`, 'sh', '-c', script], { env: { REDISCLI_AUTH: loadSecrets().valkeyPassword } });
}

/** Runs a command to completion with these extra variables; resolves with its exit code. */
export function runWith(cmd: string, args: readonly string[], env: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: REPO, stdio: 'inherit', shell: process.platform === 'win32', env: { ...process.env, ...env } });
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 1));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const problems = stackProblems();
  const ca = edgeCa();
  if (process.platform === 'win32' && !installedOnWindows(ca)) problems.push('the edge CA is not in your trust store: run `pnpm stack:trust` and install it (verification is never disabled)');
  if (problems.length) {
    for (const p of problems) console.error(`[stack:e2e] ${p}`);
    process.exit(1);
  }
  clearRateLimits();
  const env = testEnv(loadSecrets(), writeCaBundle());
  try {
    const code = await withTunnel(() => runWith('pnpm', ['--filter', '@univarse/web', 'exec', 'playwright', 'test', ...process.argv.slice(2)], env));
    console.log('[stack:e2e] the tunnel was removed and is gone (no container; 127.0.0.1 port closed)');
    process.exit(code);
  } catch (e) {
    console.error(`[stack:e2e] ${(e as Error).message}`);
    process.exit(1);
  }
}
