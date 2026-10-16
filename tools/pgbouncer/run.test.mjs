// Spec 0017: the PgBouncer container's run arguments, pinned. Run: node --test tools/pgbouncer/run.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CONTAINER, containerUser, PORT, runArgs } from './run.mjs';

const base = {
  profile: 'probe',
  dir: '/w/.pgbouncer',
  image: 'univarse-pgbouncer:ci',
  gateway: '172.17.0.1',
  user: '1001:118',
};
const pairs = (args) => args.map((a, i) => `${a} ${args[i + 1] ?? ''}`);

test('the container is locked down: read-only, no capabilities, no new privileges, a non-root user', () => {
  const a = runArgs(base);
  assert.ok(a.includes('--read-only'));
  assert.ok(pairs(a).includes('--cap-drop ALL'));
  assert.ok(pairs(a).includes('--security-opt no-new-privileges'));
  assert.ok(pairs(a).includes('--user 1001:118'));
  assert.ok(pairs(a).includes(`--name ${CONTAINER}`));
});

test('published on loopback only, with host.docker.internal mapped to the IPv4 gateway (decision A)', () => {
  const a = runArgs(base);
  assert.ok(pairs(a).includes(`--publish 127.0.0.1:${PORT}:${PORT}`));
  assert.ok(pairs(a).includes('--add-host host.docker.internal:172.17.0.1'));
  assert.ok(!a.some((x) => x.includes('host-gateway')));
  assert.throws(() => runArgs({ ...base, gateway: 'host-gateway' }), /must be an IPv4 address/);
  assert.throws(() => runArgs({ ...base, gateway: 'fdc4::254' }), /must be an IPv4 address/);
});

test("the .pgbouncer directory is mounted read-only (a renamed auth file is seen), the profile's ini as the command", () => {
  for (const profile of ['probe', 'suite']) {
    const a = runArgs({ ...base, profile });
    const v = pairs(a).filter((p) => p.startsWith('--volume '));
    assert.deepEqual(v, ['--volume /w/.pgbouncer:/etc/pgbouncer:ro']); // the directory, never single files
    assert.equal(a.at(-2), 'univarse-pgbouncer:ci');
    assert.equal(a.at(-1), `/etc/pgbouncer/pgbouncer.${profile}.ini`);
  }
  assert.throws(() => runArgs({ ...base, profile: 'session' }), /unknown profile/);
});

test('root is refused: as the user argument, and as the current user on Linux', () => {
  assert.throws(() => runArgs({ ...base, user: '0:0' }), /non-root/);
  assert.throws(() => runArgs({ ...base, user: 'root' }), /non-root/);
  assert.equal(containerUser('win32'), '65532:65532');
  assert.equal(containerUser('darwin'), '65532:65532');
  if (process.platform === 'linux' && process.getuid?.() !== 0)
    assert.equal(containerUser('linux'), `${process.getuid()}:${process.getgid()}`);
});
