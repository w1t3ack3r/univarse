// Every `pnpm stack:*` command's entry point, run as a real process the way pnpm runs it (tsx), with arguments that
// only reach its usage message: so its whole import graph loads and evaluates. A cycle through a top-level await made
// `pnpm stack:vault migrate-raft` exit 13 ("unsettled top-level await") before it did anything (spec 0020 B-4, found on
// the owner's machine); unit tests that import the functions directly can't see that.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TSX = join(dirname(createRequire(import.meta.url).resolve('tsx/package.json')), 'dist', 'cli.mjs');
const scripts = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts;
const entry = (script: string) => (scripts[script] ?? '').replace(/^tsx /, '');

const run = (file: string, args: readonly string[]) =>
  spawnSync(process.execPath, [TSX, file, ...args], { cwd: ROOT, encoding: 'utf8', timeout: 60_000, env: { ...process.env, INIT_CWD: ROOT } });

describe('the stack commands load and answer', { timeout: 120_000 }, () => {
  const cases: [string, string[], number, RegExp][] = [
    ['vault', ['migrate-raft', 'releases/does-not-exist.json'], 1, /usage: pnpm stack:vault migrate-raft/],
    ['vault', ['nope'], 2, /usage: pnpm stack:vault status \| init \| unseal \| migrate-raft/],
    ['backup', ['nope'], 1, /usage: pnpm stack:backup/],
    ['keys', ['nope'], 1, /usage: pnpm stack:keys/],
    ['deploy', [], 2, /usage: pnpm stack:deploy/],
    ['bucket-check', ['--nope'], 2, /usage: pnpm stack:bucket-check/],
  ];
  for (const [script, args, code, usage] of cases)
    it(`pnpm stack:${script} ${args.join(' ')}: its usage, exit ${String(code)} (never 13)`, () => {
      const r = run(entry(script), args);
      expect([r.status, `${r.stdout}${r.stderr}`]).toEqual([code, expect.stringMatching(usage)]);
    });

  it('stack:vault runs vault-cli.ts, and vault.ts (imported by the migration) has no entry point of its own', () => {
    expect(entry('vault')).toBe('src/vault-cli.ts');
    expect(readFileSync(join(ROOT, 'src', 'vault.ts'), 'utf8')).not.toMatch(/process\.argv/);
  });
});
