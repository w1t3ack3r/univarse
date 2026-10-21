// Spec 0019 D9/LS9: secrets generated once, owner-only, never overwritten without --rotate; the volumes get each
// file with its image's owner and a key 0600, from fixed paths only.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ownerOnlyProblems } from '../../../packages/db/scripts/pgbouncer-config.js';
import { ensureStackDir, generateSecrets, loadSecrets, saveSecrets, secretsFile, secretValues } from './secrets.js';
import { fillScript, VOLUMES } from './volumes.js';

let dir: string;
beforeEach(() => {
  dir = ensureStackDir(join(mkdtempSync(join(tmpdir(), 'uv-stack-secrets-')), 'stack'));
});
afterEach(() => rmSync(join(dir, '..'), { recursive: true, force: true }));

describe('[LS9] the secrets', () => {
  it('[LS9] are generated distinct, with valid SCRAM verifiers for their own passwords, and saved owner-only', () => {
    const s = generateSecrets();
    expect(new Set(secretValues(s)).size).toBe(secretValues(s).length);
    for (const v of Object.values(s.verifiers)) expect(v).toMatch(/^SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
    expect(saveSecrets(s, { dir })).toBe('written');
    expect(ownerOnlyProblems(secretsFile(dir))).toEqual([]);
    expect(loadSecrets(dir)).toEqual(s);
  });

  it('[LS9] are kept on a second init; --rotate replaces them', () => {
    const first = generateSecrets();
    saveSecrets(first, { dir });
    expect(saveSecrets(generateSecrets(), { dir })).toBe('kept');
    expect(loadSecrets(dir)).toEqual(first);
    const second = generateSecrets();
    expect(saveSecrets(second, { dir, rotate: true })).toBe('written');
    expect(JSON.parse(readFileSync(secretsFile(dir), 'utf8'))).toEqual(second);
  });

  it('[LS9][B5] a file from before PR B gains only the admin password (and its verifier); every other secret is kept', async () => {
    const { pgbouncerAdminPassword: _p, ...before } = generateSecrets();
    const { writeOwnerOnly, scramVerifier } = await import('../../../packages/db/scripts/pgbouncer-config.js');
    /** The verifier holds its password: recomputed from the same salt and iterations, it is identical. */
    const verifyScramPassword = (verifier: string, password: string) => {
      const [, iter, salt] = /^SCRAM-SHA-256\$(\d+):([^$]+)\$/.exec(verifier) ?? [];
      return scramVerifier(password, Buffer.from(salt ?? '', 'base64'), Number(iter)) === verifier;
    };
    writeOwnerOnly(secretsFile(dir), `${JSON.stringify(before)}\n`);
    expect(saveSecrets(generateSecrets(), { dir })).toBe('upgraded');
    const after = loadSecrets(dir);
    const { pgbouncerAdminPassword, pgbouncerAdminVerifier, ...rest } = after;
    const { pgbouncerAdminVerifier: _old, ...keptBefore } = before;
    expect(rest).toEqual(keptBefore);
    expect(pgbouncerAdminPassword).toMatch(/^[0-9a-f]{48}$/);
    expect(verifyScramPassword(pgbouncerAdminVerifier, pgbouncerAdminPassword)).toBe(true);
    expect(ownerOnlyProblems(secretsFile(dir))).toEqual([]);
  });

  it('[LS9] the stack directory itself is owner-only', async () => {
    const { ownerOnlyDirProblems } = await import('../../../packages/db/scripts/pgbouncer-config.js');
    expect(ownerOnlyDirProblems(dir)).toEqual([]);
  });
});

describe('the volumes', () => {
  it('every key is 0600 and owned by its image\'s user; the CA volume holds the CA certificate only, never its key', () => {
    for (const [volume, files] of Object.entries(VOLUMES))
      for (const f of files) {
        if (f.to.endsWith('.key') || f.to === 'userlist.txt' || f.to === 'valkey.conf' || f.to === 's3.json') expect([volume, f.to, f.mode]).toEqual([volume, f.to, '0600']);
      }
    expect(VOLUMES['univarse-stack-ca']).toEqual([{ from: 'certs/ca.crt', to: 'ca.crt', owner: '0:0', mode: '0644' }]);
    expect(Object.values(VOLUMES).flat().some((f) => f.from === 'certs/ca.key')).toBe(false);
  });

  it('the fill script refuses a path that could leave the volume or the source', () => {
    expect(() => fillScript([{ from: '../secrets.json', to: 'x', owner: '0:0', mode: '0600' }])).toThrow(/unsafe volume path/);
    expect(() => fillScript([{ from: 'certs/a.crt', to: 'x;rm -rf /', owner: '0:0', mode: '0600' }])).toThrow(/unsafe volume path/);
    expect(() => fillScript([{ from: 'certs/a.crt', to: 'a', owner: 'root', mode: '0600' }])).toThrow(/bad owner/);
  });
});

describe('[LS5] which volumes changed', () => {
  it('[LS5] only a changed or missing volume is filled; the services reading it are named until a restart is recorded', async () => {
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const { fillVolumes, markApplied, VOLUMES, VOLUME_SERVICES } = await import('./volumes.js');
    for (const f of Object.values(VOLUMES).flat()) {
      mkdirSync(join(dir, f.from, '..'), { recursive: true });
      writeFileSync(join(dir, f.from), `content of ${f.from}`);
    }
    const missing = new Set<string>(Object.keys(VOLUMES));
    const filled: string[] = [];
    const run = (args: readonly string[]) => {
      if (args[0] === 'volume' && args[1] === 'inspect') return { status: missing.has(args[2] ?? '') ? 1 : 0, stdout: '', stderr: '' };
      if (args[0] === 'volume' && args[1] === 'create') missing.delete(args[2] ?? '');
      if (args[0] === 'run') filled.push(args[args.indexOf('-v', args.indexOf('-v') + 1) + 1]?.split(':')[0] ?? '');
      return { status: 0, stdout: '', stderr: '' };
    };
    // First fill: everything is new.
    expect(new Set(fillVolumes({ dir, run }))).toEqual(new Set(Object.values(VOLUME_SERVICES).flat()));
    expect(filled.sort()).toEqual(Object.keys(VOLUMES).sort());
    // Not yet loaded (the deploy stopped before restarting): the next fill still names every service, fills nothing.
    filled.length = 0;
    expect(new Set(fillVolumes({ dir, run }))).toEqual(new Set(Object.values(VOLUME_SERVICES).flat()));
    expect(filled).toEqual([]);
    // Restarted and recorded: nothing changed, nothing filled, nothing to restart.
    markApplied({ dir });
    expect(fillVolumes({ dir, run })).toEqual([]);
    expect(filled).toEqual([]);
    // A rotated PgBouncer certificate: its volume alone, and PgBouncer alone.
    writeFileSync(join(dir, 'certs/pgbouncer.crt'), 'a new certificate');
    expect(fillVolumes({ dir, run })).toEqual(['pgbouncer']);
    expect(filled).toEqual(['univarse-stack-pgbouncer-conf']);
    markApplied({ dir });
    // A volume removed outside the deploy is refilled even though its content didn't change.
    filled.length = 0;
    missing.add('univarse-stack-caddy-tls');
    expect(fillVolumes({ dir, run })).toEqual(['caddy']);
    expect(filled).toEqual(['univarse-stack-caddy-tls']);
    markApplied({ dir });
    // A reissued internal CA: Vault is recorded early on its own (a restart seals it); PgBouncer's stays pending.
    writeFileSync(join(dir, 'certs/ca.crt'), 'a new stack CA');
    expect(new Set(fillVolumes({ dir, run }))).toEqual(new Set(['pgbouncer', 'api', 'worker', 'vault']));
    markApplied({ dir, services: ['vault'] });
    expect(new Set(fillVolumes({ dir, run }))).toEqual(new Set(['pgbouncer', 'api', 'worker']));
  });
});
