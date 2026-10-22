// Spec 0019 C1: every production-image run reaches the dev Vault over TLS, trusting the dev CA, never its plain
// listener; a missing CA stops the run before anything starts.
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { dockerRun, VAULT_TLS_ADDR, WORKER_CMD } from './container.mjs';

const dir = mkdtempSync(join(tmpdir(), 'uv-ca-'));
const caFile = join(dir, 'ca.crt');
writeFileSync(caFile, 'dev CA');
test.after(() => rmSync(dir, { recursive: true, force: true }));

for (const [what, cmd] of [['the API', []], ['the worker', WORKER_CMD]])
  test(`[LS8] ${what}: VAULT_ADDR is the TLS listener, the dev CA is trusted and mounted read-only`, () => {
    process.env.VAULT_ADDR = 'http://127.0.0.1:8200'; // what .env holds for development
    const { args, env } = dockerRun({ name: 'x', image: 'univarse-api:ci', cmd, caFile });
    assert.equal(env.VAULT_ADDR, VAULT_TLS_ADDR);
    assert.match(VAULT_TLS_ADDR, /^https:\/\//);
    assert.equal(env.NODE_EXTRA_CA_CERTS, '/etc/univarse/vault-ca.crt');
    for (const k of ['VAULT_ADDR', 'NODE_EXTRA_CA_CERTS']) assert.ok(args.join(' ').includes(`-e ${k}`), k);
    assert.ok(args.join(' ').includes(`-v ${caFile}:/etc/univarse/vault-ca.crt:ro`));
    assert.ok(!args.some((a) => a.includes('http://127.0.0.1:8200')), 'the plain listener is never on the command line');
  });

test('[LS8] without the dev CA the run stops, naming the step that makes it', () => {
  assert.throws(() => dockerRun({ name: 'x', image: 'i', caFile: join(dir, 'missing.crt') }), /no dev Vault CA .*pnpm dev:infra/);
});
