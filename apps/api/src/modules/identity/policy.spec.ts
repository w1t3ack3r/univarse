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
  INSTITUTION,
  permissionsHeld,
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

describe('[PS6] the resource context type (D2)', () => {
  it('[PS6] only the institution context type-checks until a resource scope is built', () => {
    const a = actorWith([]);
    // @ts-expect-error -- no ORG_UNIT context yet (ADR-028): it arrives with its first consuming module.
    evaluate(a, 'identity.user.view', { scope: 'ORG_UNIT', id: RESOURCE_ID }, NOW);
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
