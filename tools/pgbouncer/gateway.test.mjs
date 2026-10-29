// Spec 0017 Design, decision A: host.docker.internal is mapped to the daemon's host-gateway IPv4 address only.
// Run: node --test tools/pgbouncer/gateway.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
  assert.equal(seen.opts.killSignal, 'SIGKILL'); // a handled SIGTERM can't extend the wait
  assert.ok(seen.args.includes(`${PROBE_HOST}:host-gateway`));
  assert.match(
    seen.args.find((a) => a.startsWith('gcr.io/')),
    /@sha256:[0-9a-f]{64}$/,
  ); // a pinned image
});

test("a timed-out discovery removes its own named probe container, bounded too (owner's review of 6297f22)", () => {
  const calls = [];
  const run = (cmd, args, opts) => {
    calls.push({ args, opts });
    return args[0] === 'run'
      ? { error: Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' }), signal: 'SIGKILL' }
      : { status: 0 };
  };
  assert.throws(
    () => discoverGatewayIpv4({ run, timeoutMs: 1000, random: () => 'abcd1234' }),
    /within 1 s/,
  );
  assert.deepEqual(calls[0].args.slice(0, 4), [
    'run',
    '--rm',
    '--name',
    'uv-gateway-probe-abcd1234',
  ]);
  assert.deepEqual(calls[1].args, ['rm', '-f', '-v', 'uv-gateway-probe-abcd1234']); // its own, by name
  assert.equal(calls[1].opts.killSignal, 'SIGKILL');
  assert.ok(calls[1].opts.timeout > 0);
  // a failed removal is reported, not hidden
  const failing = (cmd, args) =>
    args[0] === 'run' ? { error: { code: 'ETIMEDOUT' }, signal: 'SIGKILL' } : { status: 1 };
  assert.throws(
    () => discoverGatewayIpv4({ run: failing, timeoutMs: 1000 }),
    /also failed; remove it by hand/,
  );
});

// A real child that handles (ignores) SIGTERM and would sleep 20 s: the bound must still hold. With spawnSync's
// default SIGTERM, a POSIX child like this outlives the timeout (owner's probe: 100 ms became 758 ms). CI (Linux)
// exercises that; on Windows any kill terminates the process outright.
test("discovery's timeout is enforced on a real process that ignores SIGTERM (owner's review of 6297f22)", () => {
  const STUBBORN =
    "process.on('SIGTERM', () => {}); setTimeout(() => {}, 20000); process.stdout.write('started')";
  const run = (cmd, args, opts) =>
    args[0] === 'run' ? spawnSync(process.execPath, ['-e', STUBBORN], opts) : { status: 0 };
  const t0 = Date.now();
  assert.throws(() => discoverGatewayIpv4({ run, timeoutMs: 300 }), /did not finish within 0\.3 s/);
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 3000, `returned after ${elapsed} ms, for a 300 ms bound`);
});
