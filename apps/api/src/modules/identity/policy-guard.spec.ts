// Spec 0018 PS7: the static guard (testing/policy-guard.ts) passes on the code and reports each form of reading an
// actor's grants outside the policy. Fixtures are compiled with the real types, inside the API's program.
import type * as TS from 'typescript';
import { beforeAll, describe, expect, it } from 'vitest';
import { packageProgram } from '../../testing/session-sql-guard.js';
import { grantReads, policyGuardViolations } from '../../testing/policy-guard.js';

const HEAD = `import type { Actor, Grant } from '../modules/identity/actor.js';\n`;
const FIXTURES: Record<string, [string, RegExp | null]> = {
  direct: [`${HEAD}export const f = (a: Actor) => a.grants.length;`, /reads Actor\.grants/],
  optional: [`${HEAD}export const f = (a: Actor | undefined) => a?.grants;`, /reads Actor\.grants/],
  element: [`${HEAD}export const f = (a: Actor) => a['grants'];`, /reads Actor\.grants/],
  destructured: [`${HEAD}export const f = ({ grants }: Actor) => grants;`, /reads Actor\.grants/],
  destructuredRenamed: [
    `${HEAD}export const f = (a: Actor) => { const { grants: g } = a; return g; };`,
    /reads Actor\.grants/,
  ],
  aliasType: [
    `${HEAD}type Who = Actor;\nexport const f = (a: Who) => a.grants;`,
    /reads Actor\.grants/,
  ],
  picked: [
    `${HEAD}export const f = (a: Pick<Actor, 'grants'>) => a.grants;`,
    /reads Actor\.grants/,
  ],
  scopeComparison: [
    `${HEAD}export const f = (g: Grant) => g.scopeType === 'INSTITUTION';`,
    /reads Grant\.scopeType/,
  ],
  scopeId: [`${HEAD}export const f = (g: Grant) => g.scopeId;`, /reads Grant\.scopeId/],
  // Not reads of the watched members: a same-named property of another type, and passing the actor whole.
  otherType: [
    `export const f = (x: { grants: number[]; scopeType: string }) => [x.grants, x.scopeType];`,
    null,
  ],
  passesActor: [
    `${HEAD}import { needsMfa } from '../modules/identity/actor.js';\nexport const f = (a: Actor) => needsMfa(a);`,
    null,
  ],
};
const path = (name: string) => `src/__policy_fixtures__/${name}.ts`;
let program: TS.Program;
beforeAll(() => {
  program = packageProgram(
    'apps/api',
    Object.fromEntries(Object.entries(FIXTURES).map(([n, [t]]) => [path(n), t])),
  );
}, 120_000);
const check = (name: string) => {
  const sf = program
    .getSourceFiles()
    .find((s) => s.fileName.replace(/\\/g, '/').endsWith(`__policy_fixtures__/${name}.ts`));
  if (!sf) throw new Error(`fixture ${name} not in the program`);
  return grantReads(program, sf);
};

describe('[PS7] only the policy reads grants', () => {
  it('[PS7] the API passes: no read of Actor.grants or Grant.scopeType/scopeId outside the allowlist', () => {
    expect(policyGuardViolations(program)).toEqual([]);
  });

  it('[PS7] the allowlisted policy does read them (the guard sees real reads; the allowlist is what excuses them)', () => {
    const policy = program
      .getSourceFiles()
      .find((s) => s.fileName.replace(/\\/g, '/').endsWith('/modules/identity/policy.ts'));
    expect(grantReads(program, policy!).length).toBeGreaterThan(0);
  });

  for (const [name, [, want]] of Object.entries(FIXTURES))
    it(`[PS7] ${name}: ${want ? 'reported' : 'not reported'}`, () => {
      const found = check(name);
      if (want) expect(found).toEqual([expect.stringMatching(want)]);
      else expect(found).toEqual([]);
    });
});
