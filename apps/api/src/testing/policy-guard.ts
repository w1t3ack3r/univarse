// Spec 0018 D6/PS7: only the policy decides access, so nothing else reads an actor's grants. On the API's
// TypeScript program with the real types, this reports every read of `Actor.grants`, `Grant.scopeType` or
// `Grant.scopeId` outside the allowlist: property access (also optional), element access by a literal, and object
// destructuring, resolved by symbol, so aliases and mapped types (`Pick<Actor, 'grants'>`) count as the original.
// Its limit, stated as for spec 0015's CI10: a value laundered through `any` or a cast to an unrelated type is not
// seen. The policy's negative tests (PS3, PS4) don't depend on this guard.
import { relative } from 'node:path';
import ts from 'typescript';
import type * as TS from 'typescript';
import { productionSources, REPO } from './session-sql-guard.js';

const ACTOR_FILE = /\/apps\/api\/src\/modules\/identity\/actor\.ts$/;
/** The policy decides; the session service builds grants; actor.ts declares them and classifies sessions. */
export const POLICY_ALLOWLIST = [
  'apps/api/src/modules/identity/policy.ts',
  'apps/api/src/modules/identity/session.service.ts',
  'apps/api/src/modules/identity/actor.ts',
];
const WATCHED: Record<string, string> = { grants: 'Actor', scopeType: 'Grant', scopeId: 'Grant' };

/** Every read of a watched member in `sf`, allowlisted or not. */
export function grantReads(program: TS.Program, sf: TS.SourceFile): string[] {
  const checker = program.getTypeChecker();
  const out: string[] = [];
  const where = (n: TS.Node) =>
    `${relative(REPO, sf.fileName).replace(/\\/g, '/')}:${String(sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1)}`;
  /** True when the property symbol is the watched member of its interface in actor.ts. */
  const watched = (sym: TS.Symbol | undefined, name: string): boolean =>
    (sym?.declarations ?? []).some((d) => {
      const owner = d.parent;
      return (
        ACTOR_FILE.test(d.getSourceFile().fileName.replace(/\\/g, '/')) &&
        ts.isInterfaceDeclaration(owner) &&
        owner.name.text === WATCHED[name]
      );
    });
  const report = (n: TS.Node, name: string) =>
    out.push(
      `${where(n)}: reads ${WATCHED[name] ?? '?'}.${name} outside the policy (spec 0018 D6)`,
    );

  const visit = (n: TS.Node): void => {
    if (ts.isPropertyAccessExpression(n) && Object.hasOwn(WATCHED, n.name.text)) {
      if (watched(checker.getSymbolAtLocation(n.name), n.name.text)) report(n, n.name.text);
    } else if (
      ts.isElementAccessExpression(n) &&
      ts.isStringLiteralLike(n.argumentExpression) &&
      Object.hasOwn(WATCHED, n.argumentExpression.text)
    ) {
      const name = n.argumentExpression.text;
      if (watched(checker.getTypeAtLocation(n.expression).getProperty(name), name)) report(n, name);
    } else if (ts.isBindingElement(n) && ts.isObjectBindingPattern(n.parent)) {
      const key = n.propertyName ?? n.name;
      const name = ts.isIdentifier(key) || ts.isStringLiteralLike(key) ? key.text : undefined;
      if (
        name &&
        Object.hasOwn(WATCHED, name) &&
        watched(checker.getTypeAtLocation(n.parent).getProperty(name), name)
      )
        report(n, name);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** The gate: reads outside the allowlist, across the API's production sources. */
export function policyGuardViolations(program: TS.Program): string[] {
  const allowed = new Set(POLICY_ALLOWLIST);
  return productionSources(program, 'apps/api')
    .filter((sf) => !sf.fileName.replace(/\\/g, '/').includes('/__policy_fixtures__/'))
    .filter((sf) => !allowed.has(relative(REPO, sf.fileName).replace(/\\/g, '/')))
    .flatMap((sf) => grantReads(program, sf));
}
