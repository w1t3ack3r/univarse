// Spec 0019 B4 (LS1's one exception): a temporary loopback tunnel to the stack's PgBouncer, for the E2E suite and the
// isolation probe only. A throwaway forwarder (TUNNEL_IMAGE: UID 65532, read-only, no capabilities, an hour's lifetime)
// on its own bridge network publishes 127.0.0.1:TUNNEL_PORT, and joins `app` to reach pgbouncer:6432. PostgreSQL is
// never published; PgBouncer still requires TLS and SCRAM. `withTunnel` removes it after the run, on success, failure
// or interrupt, then checks it's gone (no container, the port refuses connections). A tunnel left by a killed run is
// removed before the next one starts, and by `pnpm stack:down`.
import { connect } from 'node:net';
import { PROJECT, TUNNEL_IMAGE, TUNNEL_PORT } from './config.js';
import { docker, type Runner } from './docker.js';

export const TUNNEL_CONTAINER = `${PROJECT}-tunnel`;
export const TUNNEL_NETWORK = `${PROJECT}-tunnel`;
const APP_NETWORK = `${PROJECT}_app`;
/** The forwarder's own lifetime: an orphaned tunnel (a killed run) ends by itself within the hour. */
const LIFETIME_S = 3600;

/** The `docker run` arguments: loopback only, hardened like the stack's services. */
export function tunnelRunArgs(): string[] {
  return [
    'run', '-d', '--rm', '--name', TUNNEL_CONTAINER,
    '--network', TUNNEL_NETWORK,
    '-p', `127.0.0.1:${String(TUNNEL_PORT)}:${String(TUNNEL_PORT)}`,
    '--user', '65532:65532', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--memory', '32m',
    '--entrypoint', 'timeout', TUNNEL_IMAGE,
    String(LIFETIME_S), 'socat', `TCP-LISTEN:${String(TUNNEL_PORT)},fork,reuseaddr`, 'TCP:pgbouncer:6432',
  ];
}

/** Removes the tunnel and its network, whether or not they exist. */
export function removeTunnel(run: Runner = docker): void {
  run(['rm', '-f', TUNNEL_CONTAINER], { allowFail: true });
  run(['network', 'rm', TUNNEL_NETWORK], { allowFail: true });
}

/** Whether something accepts connections on 127.0.0.1:port. */
export function portOpen(port = TUNNEL_PORT): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect({ host: '127.0.0.1', port, timeout: 2000 });
    const done = (open: boolean) => {
      s.destroy();
      resolve(open);
    };
    s.once('connect', () => {
      done(true);
    });
    s.once('error', () => {
      done(false);
    });
    s.once('timeout', () => {
      done(false);
    });
  });
}

/** Problems if the tunnel survives: a container by its name, or the port still answering. */
export async function tunnelGoneProblems(run: Runner = docker, open = portOpen): Promise<string[]> {
  const problems: string[] = [];
  const left = run(['ps', '-a', '-q', '--filter', `name=^/${TUNNEL_CONTAINER}$`], { allowFail: true }).stdout.trim();
  if (left) problems.push(`the tunnel container ${TUNNEL_CONTAINER} still exists`);
  if (await open()) problems.push(`127.0.0.1:${String(TUNNEL_PORT)} still accepts connections`);
  return problems;
}

export function openTunnel(run: Runner = docker): void {
  removeTunnel(run); // a tunnel left by a killed run
  run(['network', 'create', TUNNEL_NETWORK]);
  run(tunnelRunArgs());
  run(['network', 'connect', APP_NETWORK, TUNNEL_CONTAINER]);
}

/**
 * Runs `fn` with the tunnel open; always closes it, then verifies it's gone. An interrupt (Ctrl+C, a closed terminal)
 * closes it before exiting. Returns fn's result; a tunnel that survives is an error, even after a passing run.
 */
export async function withTunnel<T>(
  fn: () => Promise<T>,
  { run = docker, open = portOpen, signals = process }: { run?: Runner; open?: () => Promise<boolean>; signals?: Pick<NodeJS.Process, 'once' | 'off'> } = {},
): Promise<T> {
  const onSignal = () => {
    removeTunnel(run);
    process.exit(130);
  };
  const names = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
  for (const n of names) signals.once(n, onSignal);
  let outcome: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    openTunnel(run);
    outcome = { ok: true, value: await fn() };
  } catch (error) {
    outcome = { ok: false, error };
  }
  for (const n of names) signals.off(n, onSignal);
  removeTunnel(run);
  // A surviving tunnel is reported first, whatever the run did; the run's own failure is kept in the message.
  const left = await tunnelGoneProblems(run, open);
  if (left.length) throw new Error(`the tunnel was not removed: ${left.join('; ')}${outcome.ok ? '' : ` (after: ${(outcome.error as Error).message})`}`);
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}
