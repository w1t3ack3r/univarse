// Spec 0017 Design, decision A: host.docker.internal is mapped to the daemon's host-gateway IPv4 address only.
// Run: node --test tools/pgbouncer/gateway.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  discoverGatewayIpv4,
  gatewayAddresses,
  isUsableIpv4,
  PROBE_HOST,
  selectGatewayIpv4,
} from './gateway.mjs';

const BASE =
  '127.0.0.1\tlocalhost\n::1\tlocalhost ip6-localhost ip6-loopback\nff02::1\tip6-allnodes\n';
const hosts = (...lines) => `${BASE}${lines.join('\n')}\n172.17.0.2\taf1b8a2d1a5d\n`;
const pick = (text) => selectGatewayIpv4(gatewayAddresses(text));

test('IPv4-only daemon (e.g. a Linux CI runner): its gateway is used', () => {
  assert.equal(pick(hosts(`172.17.0.1\t${PROBE_HOST}`)), '172.17.0.1');
});

test('dual-stack daemon (this Docker Desktop): the IPv4 gateway is used, the IPv6 one ignored', () => {
  const text = hosts(`192.168.65.254\t${PROBE_HOST}`, `fdc4:f303:9324::254\t${PROBE_HOST}`);
  assert.deepEqual(gatewayAddresses(text), {
    ipv4: ['192.168.65.254'],
    ipv6: ['fdc4:f303:9324::254'],
  });
  assert.equal(pick(text), '192.168.65.254');
  assert.equal(
    pick(hosts(`fdc4:f303:9324::254\t${PROBE_HOST}`, `192.168.65.254\t${PROBE_HOST}`)),
    '192.168.65.254',
  ); // order-free
});

test('missing IPv4 fails clearly, naming the IPv6 address it will not use; nothing listed fails too', () => {
  assert.throws(
    () => pick(hosts(`fdc4:f303:9324::254\t${PROBE_HOST}`)),
    /no IPv4 address.*IPv6 fdc4:f303:9324::254, which is not used/,
  );
  assert.throws(() => pick(hosts()), /no IPv4 address.*listed no address at all/);
});

test('only the exact probe name counts: other entries, look-alike names and comments are ignored', () => {
  const text = hosts(
    `10.0.0.9\t${PROBE_HOST}2`,
    `10.0.0.8\tx-${PROBE_HOST}`,
    `# 10.0.0.7\t${PROBE_HOST}`,
    `192.168.65.254\tother ${PROBE_HOST} # trailing comment`,
  );
  assert.deepEqual(gatewayAddresses(text).ipv4, ['192.168.65.254']);
});

test('two different IPv4 gateways are refused rather than guessed; a repeated one is fine', () => {
  assert.throws(
    () => pick(hosts(`192.168.65.254\t${PROBE_HOST}`, `172.17.0.1\t${PROBE_HOST}`)),
    /more than one IPv4/,
  );
  assert.equal(pick(hosts(`172.17.0.1\t${PROBE_HOST}`, `172.17.0.1\t${PROBE_HOST}`)), '172.17.0.1');
});

test('an unusable IPv4 address is refused: loopback, unspecified, multicast, malformed', () => {
  for (const bad of [
    '127.0.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '256.1.1.1',
    '01.2.3.4',
    '1.2.3',
    'x.y.z.w',
  ]) {
    assert.equal(isUsableIpv4(bad), false, bad);
  }
  for (const good of ['172.17.0.1', '192.168.65.254', '10.0.0.1'])
    assert.equal(isUsableIpv4(good), true, good);
  assert.throws(() => pick(hosts(`127.0.0.1\t${PROBE_HOST}`)), /not a usable address/);
});

test('discovery is bounded and fails clearly: timeout, docker missing, a failed run; success parses the output', () => {
  const runWith = (r) => () => r;
  assert.throws(
    () =>
      discoverGatewayIpv4({
        run: runWith({
          error: Object.assign(new Error('spawnSync docker ETIMEDOUT'), { code: 'ETIMEDOUT' }),
          signal: 'SIGTERM',
        }),
        timeoutMs: 5000,
      }),
    /did not finish within 5 s/,
  );
  assert.throws(
    () =>
      discoverGatewayIpv4({
        run: runWith({
          error: Object.assign(new Error('spawnSync docker ENOENT'), { code: 'ENOENT' }),
        }),
      }),
    /could not run docker: spawnSync docker ENOENT/,
  );
  assert.throws(
    () =>
      discoverGatewayIpv4({
        run: runWith({ status: 125, stdout: '', stderr: 'Cannot connect to the Docker daemon' }),
      }),
    /docker exit 125.*Cannot connect/,
  );
  let seen;
  const ok = discoverGatewayIpv4({
    run: (cmd, args, opts) => {
      seen = { cmd, args, opts };
      return {
        status: 0,
        stdout: hosts(`192.168.65.254\t${PROBE_HOST}`, `fdc4::254\t${PROBE_HOST}`),
        stderr: '',
      };
    },
    timeoutMs: 7000,
  });
  assert.equal(ok, '192.168.65.254');
  assert.equal(seen.cmd, 'docker');
  assert.equal(seen.opts.timeout, 7000);
  assert.ok(seen.args.includes(`${PROBE_HOST}:host-gateway`));
  assert.match(
    seen.args.find((a) => a.startsWith('gcr.io/')),
    /@sha256:[0-9a-f]{64}$/,
  ); // a pinned image
});
