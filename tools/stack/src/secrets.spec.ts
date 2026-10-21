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
    expect(saveSecrets(s, { dir })).toBe(true);
    expect(ownerOnlyProblems(secretsFile(dir))).toEqual([]);
    expect(loadSecrets(dir)).toEqual(s);
  });

  it('[LS9] are kept on a second init; --rotate replaces them', () => {
    const first = generateSecrets();
    saveSecrets(first, { dir });
    expect(saveSecrets(generateSecrets(), { dir })).toBe(false);
    expect(loadSecrets(dir)).toEqual(first);
    const second = generateSecrets();
    expect(saveSecrets(second, { dir, rotate: true })).toBe(true);
    expect(JSON.parse(readFileSync(secretsFile(dir), 'utf8'))).toEqual(second);
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
