// Spec 0019 B4/LS1: the tunnel publishes PgBouncer on loopback only, hardened, and is removed after every run (a
// failed one included) and then checked gone. A recorded runner stands for Docker; the real run is in the notes.
import { describe, expect, it } from 'vitest';
import { TUNNEL_PORT } from './config.js';
import type { Runner } from './docker.js';
import { TUNNEL_CONTAINER, tunnelRunArgs, withTunnel } from './tunnel.js';

function fakeDocker() {
  const calls: string[] = [];
  let running = false;
  const run: Runner = (args) => {
    calls.push(args.join(' '));
    if (args[0] === 'run') running = true;
    if (args[0] === 'rm') running = false;
    if (args[0] === 'ps') return { status: 0, stdout: running ? 'abc123\n' : '', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  const signals = { once: () => signals, off: () => signals } as unknown as Pick<NodeJS.Process, 'once' | 'off'>;
  return { calls, run, signals, open: () => Promise.resolve(running) };
}

describe('[LS1] the E2E tunnel (B4)', () => {
  it('[LS1] publishes PgBouncer on 127.0.0.1 only, never PostgreSQL, hardened, with a bounded lifetime', () => {
    const args = tunnelRunArgs();
    const published = args.filter((_, i) => args[i - 1] === '-p');
    expect(published).toEqual([`127.0.0.1:${String(TUNNEL_PORT)}:${String(TUNNEL_PORT)}`]);
    expect(args.join(' ')).toContain('TCP:pgbouncer:6432');
    expect(args.join(' ')).not.toMatch(/postgres:5432/);
    for (const flag of ['--read-only', '--rm']) expect(args).toContain(flag);
    expect(args.slice(args.indexOf('--cap-drop'), args.indexOf('--cap-drop') + 2)).toEqual(['--cap-drop', 'ALL']);
    expect(args.slice(args.indexOf('--user'), args.indexOf('--user') + 2)).toEqual(['--user', '65532:65532']);
    expect(args).toContain('no-new-privileges:true');
    expect(args.slice(args.indexOf('--entrypoint') + 1, args.indexOf('--entrypoint') + 4)).toEqual(['timeout', expect.stringMatching(/@sha256:/), '3600']);
  });

  it('[LS1] a stale tunnel is removed before a new one opens', async () => {
    const d = fakeDocker();
    await withTunnel(() => Promise.resolve('ok'), d);
    expect(d.calls[0]).toBe(`rm -f -v ${TUNNEL_CONTAINER}`);
    expect(d.calls.findIndex((c) => c.startsWith('run '))).toBeGreaterThan(0);
  });

  it('[LS1] after a passing run the tunnel is removed and checked gone', async () => {
    const d = fakeDocker();
    expect(await withTunnel(() => Promise.resolve(42), d)).toBe(42);
    expect(d.calls.at(-3)).toBe(`rm -f -v ${TUNNEL_CONTAINER}`);
    expect(d.calls.at(-1)).toMatch(/^ps -a -q --filter/);
  });

  it('[LS1] after a FAILED run the tunnel is still removed, checked gone, and the failure is what is reported', async () => {
    const d = fakeDocker();
    await expect(withTunnel(() => Promise.reject(new Error('3 tests failed')), d)).rejects.toThrow('3 tests failed');
    expect(d.calls.filter((c) => c === `rm -f -v ${TUNNEL_CONTAINER}`)).toHaveLength(2); // before opening, and after
    expect(d.calls.at(-1)).toMatch(/^ps -a -q --filter/);
    expect(await d.open()).toBe(false);
  });

  it('[LS1] a tunnel that survives removal fails the run, even a passing one', async () => {
    const d = fakeDocker();
    const stuck: Runner = (args, o) => (args[0] === 'rm' ? { status: 1, stdout: '', stderr: 'busy' } : d.run(args, o));
    await expect(withTunnel(() => Promise.resolve('ok'), { ...d, run: stuck })).rejects.toThrow(/the tunnel was not removed: .*still exists.*still accepts connections/);
  });
});
