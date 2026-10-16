// Spec 0017: starts and stops the PgBouncer container the probes and suites run through, locally and in CI alike
// (one code path: the gateway is discovered at start, decision A, and CI's user is the runner's own).
//
//   node tools/pgbouncer/run.mjs start <probe|suite> [--dir .pgbouncer] [--image univarse-pgbouncer:local]
//   node tools/pgbouncer/run.mjs stop
//
// The container: read-only root filesystem, no capabilities, no new privileges, a non-root user, published on
// loopback only, the .pgbouncer directory mounted read-only (the profile's ini as the command), host.docker.internal mapped to the
// daemon's discovered host-gateway IPv4 address (never `host-gateway` itself). Its user: on Linux the current
// user's own UID:GID, because the auth file is 0600 and owned by them (db:setup, PB9); elsewhere the image's
// non-root 65532, since Docker Desktop's file sharing reads the host file as the host user.
// Start waits, bounded, until PgBouncer logs that it is up and listening; a failure prints its log and stops it.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { discoverGatewayIpv4 } from './gateway.mjs';

export const CONTAINER = 'univarse-pgbouncer';
export const PORT = 6432;
export const PROFILES = ['probe', 'suite'];
export const READY_TIMEOUT_MS = 30_000;

/** The `docker run` arguments for a profile. Pure: every input is explicit. */
export function runArgs({ profile, dir, image, gateway, user }) {
  if (!PROFILES.includes(profile))
    throw new Error(`unknown profile ${JSON.stringify(profile)} (probe or suite)`);
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(gateway))
    throw new Error(`the gateway must be an IPv4 address, not ${gateway}`);
  if (!/^\d+:\d+$/.test(user) || user.startsWith('0:'))
    throw new Error(`the user must be a non-root UID:GID, not ${user}`);
  return [
    'run',
    '--detach',
    '--name',
    CONTAINER,
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--user',
    user,
    '--add-host',
    `host.docker.internal:${gateway}`,
    '--publish',
    `127.0.0.1:${PORT}:${PORT}`,
    // The DIRECTORY, read-only: db:setup replaces the auth file by renaming a new one over it (PB9), and a
    // single-file bind mount would pin the old inode, so a rotation would never reach PgBouncer, even after RELOAD.
    '--volume',
    `${dir}:/etc/pgbouncer:ro`,
    image,
    `/etc/pgbouncer/pgbouncer.${profile}.ini`, // the profile, as the image's command
  ];
}

/** The container user: the current user on Linux (the auth file is theirs, 0600); the image's non-root elsewhere. */
export function containerUser(platform = process.platform) {
  if (platform === 'linux') {
    const uid = process.getuid?.();
    const gid = process.getgid?.();
    if (!uid || gid === undefined)
      throw new Error('refusing to run PgBouncer as root: run as a non-root user');
    return `${uid}:${gid}`;
  }
  return '65532:65532';
}

const docker = (args, opts = {}) =>
  spawnSync('docker', args, { encoding: 'utf8', timeout: 60_000, killSignal: 'SIGKILL', ...opts });

export function stop() {
  docker(['rm', '--force', CONTAINER]);
}

export async function start({
  profile,
  dir = '.pgbouncer',
  image = process.env.PGBOUNCER_IMAGE ?? 'univarse-pgbouncer:local',
}) {
  const abs = resolve(dir);
  for (const f of ['userlist.txt', `pgbouncer.${profile}.ini`])
    if (!existsSync(join(abs, f)))
      throw new Error(`${join(abs, f)} is missing: run pnpm db:setup first`);
  const gateway = discoverGatewayIpv4();
  stop(); // one PgBouncer at a time: a profile switch is a restart
  const r = docker(runArgs({ profile, dir: abs, image, gateway, user: containerUser() }));
  if (r.status !== 0)
    throw new Error(`docker run failed (exit ${r.status}): ${String(r.stderr).trim()}`);
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    const logs = docker(['logs', CONTAINER]);
    const text = `${logs.stdout}${logs.stderr}`;
    if (/LOG process up: PgBouncer/.test(text) && /listening on/.test(text)) {
      console.log(
        `[pgbouncer] ${profile} profile up on 127.0.0.1:${PORT} (server host ${gateway})`,
      );
      return;
    }
    const state = docker(['inspect', '--format', '{{.State.Running}}', CONTAINER]).stdout.trim();
    if (state !== 'true' || Date.now() > deadline) {
      stop();
      throw new Error(
        `PgBouncer didn't come up (${state === 'true' ? 'timed out' : 'exited'}):\n${text.slice(-2000)}`,
      );
    }
    await new Promise((r2) => setTimeout(r2, 250));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [cmd, profile] = process.argv.slice(2);
  const opt = (name) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  try {
    if (cmd === 'start') await start({ profile, dir: opt('dir'), image: opt('image') });
    else if (cmd === 'stop') stop();
    else throw new Error('usage: run.mjs start <probe|suite> [--dir d] [--image i] | stop');
  } catch (e) {
    console.error(`[pgbouncer] ${e.message}`);
    process.exit(1);
  }
}
