// Spec 0015 CI9 (kept by spec 0016 D3 when CI10 was retired, spec 0022): key destruction is reachable only through
// KeyDestruction (shared/crypto/key-forget.ts), which notifies after commit and carries spec 0020's job guard.
import { relative } from 'node:path';
import type * as TS from 'typescript';
import { beforeAll, describe, expect, it } from 'vitest';
import { apiProgram, productionFiles, SRC } from '../../testing/program.js';

let program: TS.Program;
// Building the type-checked program takes ~15 s, longer under a parallel run.
beforeAll(() => {
  program = apiProgram();
}, 120_000);

describe('[CI9] one path to key destruction', { timeout: 60_000 }, () => {
  it.each([
    ['destroyTenantKeys', /\bdestroyTenantKeys\b/],
    ['destroyRetiredKey', /\bdestroyRetiredKey\b/],
    ['reapplyDestruction', /\breapplyDestruction\b/],
    ['adoptDestruction', /\badoptDestruction\b/],
  ])('[CI9][CI11][D14] only shared/crypto/key-forget.ts uses %s', (_fn, uses) => {
    const users = productionFiles(program)
      .filter((sf) => uses.test(sf.text))
      .map((sf) => relative(SRC, sf.fileName).replace(/\\/g, '/'));
    expect(users).toEqual(['shared/crypto/key-forget.ts']);
  });
});
