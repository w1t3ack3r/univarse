// Spec 0017 Design (owner decision A, 2026-10-14): PgBouncer reaches Postgres on the host through
// `host.docker.internal`, mapped EXPLICITLY to the active Docker daemon's host-gateway IPv4 address.
//
// `--add-host=…:host-gateway` can expand to both address families when the daemon has IPv6 configured (Docker
// documents this). On this machine's Docker Desktop it wrote an IPv4 and an unroutable IPv6 gateway, and PgBouncer,
// trying both, stalled clients into query_wait_timeout. So the gateway is discovered from the daemon itself, the
// one usable IPv4 address is required, and the container gets `--add-host=host.docker.internal:<that address>`.
//
// Discovery runs the pinned distroless Node reader image (already pinned for the Grype gate) with a probe host
// mapped to host-gateway, and reads its /etc/hosts. It is bounded (a timeout) and fails with a clear reason:
// never a guess, never a silent fallback.
//
//   node tools/pgbouncer/gateway.mjs      prints the IPv4 address, or fails
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { READER_IMAGE } from '../images/pgbouncer-grype-gate.mjs';

export const PROBE_HOST = 'uv-gateway-probe';
export const DISCOVERY_TIMEOUT_MS = 60_000;

/** /etc/hosts text → the addresses listed for exactly `name`, by family. */
export function gatewayAddresses(hostsText, name = PROBE_HOST) {
  const ipv4 = [];
  const ipv6 = [];
  for (const raw of hostsText.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    const [addr, ...names] = line.split(/\s+/);
    if (!names.includes(name)) continue;
    (addr.includes(':') ? ipv6 : ipv4).push(addr);
  }
  return { ipv4, ipv6 };
}

/** A dotted-quad IPv4 address a container can route to: not unspecified, loopback, multicast or reserved. */
export function isUsableIpv4(addr) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(addr);
  if (!m) return false;
  const octets = m.slice(1).map((o) => (o.length > 1 && o.startsWith('0') ? NaN : Number(o)));
  if (octets.some((o) => !Number.isInteger(o) || o > 255)) return false;
  const [a] = octets;
  return a !== 0 && a !== 127 && a < 224;
}

/** The one usable IPv4 gateway, or a clear error. IPv6 addresses are reported, never used. */
export function selectGatewayIpv4({ ipv4, ipv6 }) {
  const distinct = [...new Set(ipv4)];
  const also = ipv6.length ? ` (it also listed IPv6 ${ipv6.join(', ')}, which is not used)` : '';
  if (distinct.length === 0)
    throw new Error(
      `host-gateway has no IPv4 address on this Docker daemon${also || ' (it listed no address at all)'}. ` +
        'PgBouncer needs an IPv4 route to the host; check the daemon’s host-gateway-ip setting.',
    );
  if (distinct.length > 1)
    throw new Error(
      `host-gateway listed more than one IPv4 address (${distinct.join(', ')}); refusing to guess`,
    );
  const [addr] = distinct;
  if (!isUsableIpv4(addr))
    throw new Error(`host-gateway's IPv4 address ${JSON.stringify(addr)} is not a usable address`);
  return addr;
}

/** How long removing a timed-out probe container may take; it is bounded the same way. */
export const CLEANUP_TIMEOUT_MS = 15_000;

/**
 * Discovers the active daemon's host-gateway IPv4 address, bounded by `timeoutMs`: the docker client is killed
 * with SIGKILL when the time is up (a handled SIGTERM can't extend the wait), and the run's own named probe
 * container is then removed, bounded too. `run` is spawnSync's signature, replaced in tests.
 */
export function discoverGatewayIpv4({
  run = spawnSync,
  timeoutMs = DISCOVERY_TIMEOUT_MS,
  random = () => randomBytes(4).toString('hex'),
} = {}) {
  const name = `uv-gateway-probe-${random()}`;
  const args = [
    'run',
    '--rm',
    '--name',
    name,
    '--network',
    'bridge',
    '--add-host',
    `${PROBE_HOST}:host-gateway`,
    '--entrypoint',
    '/nodejs/bin/node',
    READER_IMAGE,
    '-e',
    "process.stdout.write(require('fs').readFileSync('/etc/hosts','utf8'))",
  ];
  const r = run('docker', args, { encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL' });
  if (r.error?.code === 'ETIMEDOUT' || r.signal) {
    // The client is gone; its container may not be. Remove it, by its run-owned name, within a bound.
    const rm = run('docker', ['rm', '-f', '-v', name], {
      encoding: 'utf8',
      timeout: CLEANUP_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    });
    const cleanup =
      rm.status === 0
        ? ''
        : ` (removing the probe container ${name} also failed; remove it by hand)`;
    throw new Error(
      `host-gateway discovery did not finish within ${timeoutMs / 1000} s (is Docker running?)${cleanup}`,
    );
  }
  if (r.error) throw new Error(`host-gateway discovery could not run docker: ${r.error.message}`);
  if (r.status !== 0)
    throw new Error(
      `host-gateway discovery failed (docker exit ${r.status}): ${String(r.stderr).trim().slice(0, 300)}`,
    );
  return selectGatewayIpv4(gatewayAddresses(String(r.stdout)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.log(discoverGatewayIpv4());
  } catch (e) {
    console.error(`[pgbouncer-gateway] ${e.message}`);
    process.exit(1);
  }
}
