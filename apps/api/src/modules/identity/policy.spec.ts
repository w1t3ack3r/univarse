// Spec 0018: the policy's whole rule as a matrix (PS3), malformed grants (PS5), the type boundary (PS6), and the
// callers that must ask it (PS1). No database.
import { PERMISSIONS, type Permission } from '@univarse/contracts';
import { TenantModels } from '@univarse/db';
import { describe, expect, it } from 'vitest';
import { enforcePermission } from './access.guard.js';
import { AuthController } from './auth.controller.js';
import type { Actor, Grant } from './actor.js';
import type { AuthService } from './auth.service.js';
import {
  evaluate,
  holds,
  holdsSomewhere,
  INSTITUTION,
  orgUnit,
  permissionsHeld,
  scopeRoots,
  PolicyService,
  type PolicyActor,
  type Refusal,
} from './policy.js';
import type { SessionService } from './session.service.js';

const NOW = new Date('2026-10-18T12:00:00Z');
const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];
const SCOPES = Object.values(TenantModels.ScopeType);
const RESOURCE_ID = '0190a000-0000-7000-8000-0000000000aa';
const STEP_UPS: Record<string, Date | null> = {
  absent: null,
  fresh: new Date(NOW.getTime() - 60_000),
  stale: new Date(NOW.getTime() - 6 * 60_000),
  future: new Date(NOW.getTime() + 60_000),
};
const flags = (p: Permission) => PERMISSIONS[p] as { privileged?: boolean; stepUp?: boolean };
const grant = (permission: Permission, scopeType: string, scopeId: string | null): Grant => ({
  permission,
  scopeType,
  scopeId,
  roleKey: 'TEST',
});
const actorWith = (
  grants: Grant[],
  mfaAt: Date | null = NOW,
  stepUpAt: Date | null = STEP_UPS.fresh!,
): PolicyActor => ({ grants, mfaAt, stepUpAt });

/** The rule, written out independently of the implementation (D3, D4). */
function expected(p: Permission, scope: string, mfa: boolean, stepUp: string): true | Refusal {
  if (scope !== 'INSTITUTION') return 'forbidden';
  if (flags(p).privileged && !mfa) return 'mfa_required';
  if (flags(p).stepUp && stepUp !== 'fresh') return 'step_up_required';
  return true;
}

describe('[PS3] the matrix: every permission × every scope × MFA × step-up', () => {
  it('[PS3] covers the whole catalog and every scope type (a new one is included automatically)', () => {
    expect(ALL_PERMISSIONS.length).toBeGreaterThanOrEqual(13);
    expect([...SCOPES].sort()).toEqual([
      'COHORT',
      'COURSE_OFFERING',
      'HOSTEL',
      'INSTITUTION',
      'ORG_UNIT',
      'PROGRAMME',
    ]);
  });

  it('[PS3] allows only an INSTITUTION grant with no resource, with MFA when privileged and a fresh step-up when flagged; otherwise names the first failing reason', () => {
    const mismatches: string[] = [];
    let cases = 0;
    for (const p of ALL_PERMISSIONS)
      for (const scope of SCOPES)
        for (const mfa of [true, false])
          for (const [stepUp, stepUpAt] of Object.entries(STEP_UPS)) {
            cases++;
            const g = grant(p, scope, scope === 'INSTITUTION' ? null : RESOURCE_ID);
            const d = evaluate(actorWith([g], mfa ? NOW : null, stepUpAt), p, INSTITUTION, NOW);
            const got = d.allowed ? true : d.reason;
            const want = expected(p, scope, mfa, stepUp);
            if (got !== want)
              mismatches.push(
                `${p} @${scope} mfa=${String(mfa)} stepUp=${stepUp}: got ${String(got)}, want ${String(want)}`,
              );
          }
    expect(mismatches).toEqual([]);
    expect(cases).toBe(ALL_PERMISSIONS.length * SCOPES.length * 2 * 4);
  });

  it('[PS3] a grant of another permission, or no grant, is forbidden; holding it elsewhere never helps', () => {
    expect(evaluate(actorWith([]), 'identity.user.view', INSTITUTION, NOW)).toEqual({
      allowed: false,
      reason: 'forbidden',
    });
    expect(
      evaluate(
        actorWith([grant('org.unit.view', 'INSTITUTION', null)]),
        'identity.user.view',
        INSTITUTION,
        NOW,
      ),
    ).toEqual({ allowed: false, reason: 'forbidden' });
    const scopedAndOther = actorWith([
      grant('identity.user.view', 'ORG_UNIT', RESOURCE_ID),
      grant('org.unit.view', 'INSTITUTION', null),
    ]);
    expect(evaluate(scopedAndOther, 'identity.user.view', INSTITUTION, NOW).allowed).toBe(false);
  });

  it('[PS3] holds() and permissionsHeld() apply the same scope rule, without MFA or step-up', () => {
    const a = actorWith(
      [
        grant('settings.tenant.manage', 'INSTITUTION', null),
        grant('identity.user.view', 'HOSTEL', RESOURCE_ID),
        grant('org.unit.view', 'INSTITUTION', null),
        grant('org.unit.view', 'INSTITUTION', null),
      ],
      null,
      null,
    );
    expect(holds(a, 'settings.tenant.manage', INSTITUTION)).toBe(true); // no MFA, no step-up: still held
    expect(holds(a, 'identity.user.view', INSTITUTION)).toBe(false);
    expect(permissionsHeld(a, INSTITUTION)).toEqual(['org.unit.view', 'settings.tenant.manage']);
  });
});

describe('[PS5] malformed grants are inert (D4)', () => {
  it('[PS5] an INSTITUTION grant naming a resource, or an unknown scope type, allows nothing and is held nowhere', () => {
    for (const g of [
      grant('identity.user.view', 'INSTITUTION', RESOURCE_ID),
      grant('identity.user.view', 'GALAXY', null),
      grant('identity.user.view', 'institution', null),
    ]) {
      const a = actorWith([g]);
      expect(evaluate(a, 'identity.user.view', INSTITUTION, NOW)).toEqual({
        allowed: false,
        reason: 'forbidden',
      });
      expect(holds(a, 'identity.user.view', INSTITUTION)).toBe(false);
      expect(permissionsHeld(a, INSTITUTION)).toEqual([]);
    }
  });
});

describe('[Q13] the ORG_UNIT scope (spec 0042), from the loaded unit’s path', () => {
  const ROOT = '0190a000-0000-7000-8000-000000000001';
  const SCI = '0190a000-0000-7000-8000-000000000002';
  const CSC = '0190a000-0000-7000-8000-000000000003';
  const ENG = '0190a000-0000-7000-8000-000000000004';
  const csc = orgUnit({ id: CSC, path: `/${ROOT}/${SCI}/${CSC}/` });
  const sci = orgUnit({ id: SCI, path: `/${ROOT}/${SCI}/` });
  const eng = orgUnit({ id: ENG, path: `/${ROOT}/${ENG}/` });

  it('a grant on a faculty covers the faculty and its departments, never a sibling, nor the institution', () => {
    const dean = actorWith([grant('org.unit.manage', 'ORG_UNIT', SCI)]);
    expect(evaluate(dean, 'org.unit.manage', sci, NOW)).toEqual({ allowed: true });
    expect(evaluate(dean, 'org.unit.manage', csc, NOW)).toEqual({ allowed: true });
    expect(evaluate(dean, 'org.unit.manage', eng, NOW)).toEqual({ allowed: false, reason: 'forbidden' });
    expect(evaluate(dean, 'org.unit.manage', INSTITUTION, NOW)).toEqual({ allowed: false, reason: 'forbidden' });
    // Another permission held there doesn't help.
    expect(evaluate(dean, 'org.unit.restructure', csc, NOW).allowed).toBe(false);
  });

  it('an institution grant covers every unit; MFA and step-up still apply on a unit', () => {
    expect(evaluate(actorWith([grant('org.unit.view', 'INSTITUTION', null)]), 'org.unit.view', eng, NOW)).toEqual({ allowed: true });
    expect(evaluate(actorWith([grant('org.unit.manage', 'ORG_UNIT', SCI)], null), 'org.unit.manage', csc, NOW)).toEqual({ allowed: false, reason: 'mfa_required' });
    expect(evaluate(actorWith([grant('org.unit.restructure', 'ORG_UNIT', SCI)], NOW, STEP_UPS.stale), 'org.unit.restructure', csc, NOW)).toEqual({ allowed: false, reason: 'step_up_required' });
  });

  it('matches whole ids only, and a scoped grant with no unit, or another scope type naming the unit, is inert', () => {
    const prefix = SCI.slice(0, -1); // a unit whose id is a prefix of another's covers nothing of it
    expect(evaluate(actorWith([grant('org.unit.view', 'ORG_UNIT', prefix)]), 'org.unit.view', sci, NOW).allowed).toBe(false);
    for (const g of [grant('org.unit.view', 'ORG_UNIT', null), grant('org.unit.view', 'ORG_UNIT', ''), grant('org.unit.view', 'PROGRAMME', SCI), grant('org.unit.view', 'HOSTEL', SCI)]) {
      expect(evaluate(actorWith([g]), 'org.unit.view', sci, NOW).allowed, `${g.scopeType}:${String(g.scopeId)}`).toBe(false);
      expect(holdsSomewhere(actorWith([g]), 'org.unit.view')).toBe(false);
    }
  });

  it('holdsSomewhere and scopeRoots: the first gate of a scoped route, and a list’s scope', () => {
    const a = actorWith([grant('org.unit.view', 'ORG_UNIT', SCI), grant('org.unit.view', 'ORG_UNIT', ENG), grant('org.unit.view', 'ORG_UNIT', SCI), grant('org.unit.manage', 'ORG_UNIT', SCI)]);
    expect(holdsSomewhere(a, 'org.unit.view')).toBe(true);
    expect(holdsSomewhere(a, 'org.unit.restructure')).toBe(false);
    expect([...(scopeRoots(a, 'org.unit.view') as string[])].sort()).toEqual([ENG, SCI].sort());
    expect(scopeRoots(actorWith([grant('org.unit.view', 'INSTITUTION', null), grant('org.unit.view', 'ORG_UNIT', SCI)]), 'org.unit.view')).toBe('all');
    expect(scopeRoots(actorWith([]), 'org.unit.view')).toEqual([]);
    // The institution's permission list (/auth/me) counts institution grants only.
    expect(permissionsHeld(a, INSTITUTION)).toEqual([]);
  });
});

describe('[PS6] the resource context type (D2)', () => {
  it('[PS6] only the contexts built so far type-check (ORG_UNIT from spec 0042; PROGRAMME and the rest later)', () => {
    const a = actorWith([]);
    // @ts-expect-error -- an ORG_UNIT context names its unit and path, built from the loaded unit.
    evaluate(a, 'identity.user.view', { scope: 'ORG_UNIT', id: RESOURCE_ID }, NOW);
    // @ts-expect-error -- no PROGRAMME context yet (ADR-028): it arrives with S4.
    evaluate(a, 'identity.user.view', { scope: 'PROGRAMME', programmeId: RESOURCE_ID }, NOW);
    // @ts-expect-error -- nor an empty one.
    evaluate(a, 'identity.user.view', {}, NOW);
    expect(INSTITUTION).toEqual({ scope: 'INSTITUTION' });
  });
});

describe('[PS1] the callers ask the policy', () => {
  const fullActor = (grants: Grant[]): Actor => ({
    tenantId: 't',
    userId: 'u',
    sessionId: 's',
    username: 'U',
    displayName: 'U',
    restricted: false,
    mfaAt: NOW,
    stepUpAt: new Date(),
    grants,
  });

  it('[PS1] enforcePermission maps each refusal to its unchanged response, and allows what the policy allows', () => {
    const err = (a: Actor, p: Permission) => {
      try {
        enforcePermission(a, p);
        return 'allowed';
      } catch (e) {
        const x = e as { status: number; code: string };
        return `${String(x.status)} ${x.code}`;
      }
    };
    expect(err(fullActor([]), 'identity.user.view')).toBe('403 auth.forbidden');
    expect(
      err(
        { ...fullActor([grant('identity.user.manage', 'INSTITUTION', null)]), mfaAt: null },
        'identity.user.manage',
      ),
    ).toBe('403 auth.mfa_required');
    expect(
      err(
        { ...fullActor([grant('settings.tenant.manage', 'INSTITUTION', null)]), stepUpAt: null },
        'settings.tenant.manage',
      ),
    ).toBe('428 auth.step_up_required');
    expect(
      err(fullActor([grant('identity.user.view', 'INSTITUTION', null)]), 'identity.user.view'),
    ).toBe('allowed');
    expect(
      err(fullActor([grant('identity.user.view', 'ORG_UNIT', RESOURCE_ID)]), 'identity.user.view'),
    ).toBe('403 auth.forbidden');
  });

  it('[PS1] /auth/me lists exactly what the policy says is held (a policy holding nothing lists nothing)', () => {
    const a = fullActor([
      grant('identity.user.view', 'INSTITUTION', null),
      grant('org.unit.view', 'COHORT', RESOURCE_ID),
    ]);
    const me = (policy: PolicyService) =>
      new AuthController({} as AuthService, {} as SessionService, policy).me(a).permissions;
    expect(me(new PolicyService())).toEqual(['identity.user.view']);
    const nothing = Object.assign(new PolicyService(), { held: () => [] });
    expect(me(nothing)).toEqual([]);
  });
});
