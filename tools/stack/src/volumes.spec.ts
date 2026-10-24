// Spec 0020 B-2: the WAL staging volume is created and owned to PostgreSQL, and never emptied by a deploy.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Runner } from './docker.js';
import { DATA_VOLUMES, ensureDataVolumes, fillVolumes, VOLUMES } from './volumes.js';

function recorder(existing: readonly string[]) {
  const calls: (readonly string[])[] = [];
  const run: Runner = (args) => {
    calls.push(args);
    const missing = args[0] === 'volume' && args[1] === 'inspect' && !existing.includes(args[2] ?? '');
    return { status: missing ? 1 : 0, stdout: '', stderr: '' };
  };
  return { calls, run };
}

describe('ensureDataVolumes', () => {
  it('creates a missing staging volume and owns it to postgres (999), mode 0700', () => {
    const { calls, run } = recorder([]);
    ensureDataVolumes(run);
    expect(calls[1]).toEqual(['volume', 'create', 'univarse-stack-pg-wal-staging']);
    expect(calls[2]?.at(-1)).toBe('chown 999:999 /dst && chmod 0700 /dst');
  });

  it('never empties it: no delete, and an existing volume is not recreated', () => {
    const { calls, run } = recorder(Object.keys(DATA_VOLUMES));
    ensureDataVolumes(run);
    expect(calls.some((c) => c[1] === 'create')).toBe(false);
    for (const c of calls.filter((x) => x[0] === 'run')) expect(c.at(-1)).not.toMatch(/delete|\brm\b|find /);
  });

  it('is not a configuration volume (those are emptied on every fill)', () => {
    for (const v of Object.keys(DATA_VOLUMES)) expect(Object.keys(VOLUMES)).not.toContain(v);
  });
});

describe('fillVolumes', () => {
  it('ensures the staging volume on every deploy, before filling the configuration volumes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'uv-vol-'));
    for (const f of Object.values(VOLUMES).flat()) {
      mkdirSync(dirname(join(dir, f.from)), { recursive: true });
      writeFileSync(join(dir, f.from), 'x');
    }
    const { calls, run } = recorder([]);
    fillVolumes({ dir, run });
    const created = calls.filter((c) => c[1] === 'create').map((c) => c[2]);
    expect(created[0]).toBe('univarse-stack-pg-wal-staging');
    expect(created).toEqual(expect.arrayContaining(Object.keys(VOLUMES)));
  });
});
