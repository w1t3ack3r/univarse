// Spec 0020 B2-6: the set's stack.tar parts written back owner-only, folders included (the owner's first drill
// stopped at `certs/`: the folder was never made, so narrowing its ACL found nothing).
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ownerOnlyDirProblems, ownerOnlyProblems, restrictDirToOwner } from '../../../../packages/db/scripts/pgbouncer-config.js';
import { writeParts } from './real.js';

const part = (name: string, text = `${name}\n`) => ({ name, data: Buffer.from(text, 'utf8') });
let root = '';
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = '';
});
function ownerOnlyDir(): string {
  root = mkdtempSync(join(tmpdir(), 'uv-parts-'));
  const dir = join(root, 'restore');
  mkdirSync(dir);
  restrictDirToOwner(dir);
  return dir;
}

describe('[B2-6] writeParts', () => {
  it('writes parts in folders, making each folder owner-only, as the backup packs certs/ and edge/', () => {
    const dir = ownerOnlyDir();
    const parts = [part('secrets.json', '{}'), part('certs/stack-ca.pem'), part('edge/ca/edge-ca.pem')];
    expect(writeParts(dir, parts)).toBeNull();
    expect(readFileSync(join(dir, 'certs', 'stack-ca.pem'), 'utf8')).toBe('certs/stack-ca.pem\n');
    expect(readFileSync(join(dir, 'edge', 'ca', 'edge-ca.pem'), 'utf8')).toBe('edge/ca/edge-ca.pem\n');
    for (const d of ['certs', 'edge', join('edge', 'ca')]) expect(ownerOnlyDirProblems(join(dir, d))).toEqual([]);
    expect(ownerOnlyProblems(join(dir, 'edge', 'ca', 'edge-ca.pem'))).toEqual([]);
  }, 60_000);

  it.each(['../secrets.json', 'certs/../../x', '/etc/passwd', 'Certs/A.pem'])('refuses %s, and writes nothing at all', (bad) => {
    const dir = ownerOnlyDir();
    const written: string[] = [];
    expect(writeParts(dir, [part('secrets.json'), part(bad)], (t) => written.push(t))).toBe(bad);
    expect(written).toEqual([]);
    expect(readdirSync(dir)).toEqual([]);
  }, 60_000);
});
