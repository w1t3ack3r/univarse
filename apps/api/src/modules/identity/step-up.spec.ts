import { Reflector } from '@nestjs/core';
import { PERMISSIONS, type Permission } from '@univarse/contracts';
import { describe, expect, it } from 'vitest';
import { ProblemError } from '../../shared/errors/problem.js';
import { AccessGuard, AllowRestricted, Authenticated, Public, RequirePermission, RequireStepUp } from './access.guard.js';
import { hasFreshStepUp, requiresStepUp, STEP_UP_WINDOW_MS, type Actor } from './actor.js';
import type { SessionService } from './session.service.js';

describe('[S1] step-up window', () => {
  const now = new Date('2026-10-01T12:00:00Z');
  const at = (msAgo: number) => ({ stepUpAt: new Date(now.getTime() - msAgo) });

  it('accepts a step-up within 5 minutes, including the boundary', () => {
    expect(hasFreshStepUp(at(0), now)).toBe(true);
    expect(hasFreshStepUp(at(STEP_UP_WINDOW_MS), now)).toBe(true);
  });

  it('rejects a step-up older than 5 minutes, or none at all', () => {
    expect(hasFreshStepUp(at(STEP_UP_WINDOW_MS + 1), now)).toBe(false);
    expect(hasFreshStepUp({ stepUpAt: null }, now)).toBe(false);
  });

  it('rejects a step-up timestamp from the future (clock tampering / bad data)', () => {
    expect(hasFreshStepUp(at(-1000), now)).toBe(false);
  });
});

describe('[S9] permission-flagged step-up', () => {
  it('flags exactly the catalog permissions marked stepUp', () => {
    const flagged = (Object.keys(PERMISSIONS) as Permission[]).filter(requiresStepUp).sort();
    expect(flagged).toEqual(['identity.role.assign', 'settings.tenant.manage']);
  });

  it('does not flag ordinary permissions', () => {
    expect(requiresStepUp('identity.user.view')).toBe(false);
    expect(requiresStepUp('org.unit.view')).toBe(false);
  });
});

/** Route shapes the guard must handle. Only the metadata matters. */
class Routes {
  @Authenticated()
  @RequireStepUp()
  explicit() {}

  @RequirePermission('identity.role.assign')
  flagged() {}

  @RequirePermission('identity.user.view')
  plain() {}

  @Authenticated()
  @AllowRestricted()
  @RequireStepUp()
  restrictedButStepUp() {}

  @Public()
  @RequireStepUp()
  publicStepUp() {}
}

const TOKEN = 'A'.repeat(43);
const grant = (permission: Permission) => ({ permission, scopeType: 'INSTITUTION', scopeId: null, roleKey: 'TEST' });

function actor(o: Partial<Actor> = {}): Actor {
  return {
    tenantId: 't',
    userId: 'u',
    sessionId: 's',
    username: 'U',
    displayName: 'U',
    mfaAt: new Date(),
    restricted: false,
    stepUpAt: null,
    grants: [grant('identity.role.assign'), grant('identity.user.view')],
    ...o,
  };
}

/** Runs the real guard for one route with the given session; returns 'ok' or [status, code]. */
async function run(route: keyof Routes, a: Actor | null): Promise<'ok' | [number, string]> {
  const sessions = { authenticate: async () => a } as unknown as SessionService;
  const guard = new AccessGuard(new Reflector(), sessions);
  const req = { headers: { cookie: `__Host-uv_sid=${TOKEN}` }, tenant: {}, id: 'r', method: 'POST', routeOptions: { url: '/x' } };
  const ctx = {
    getHandler: () => Routes.prototype[route],
    getClass: () => Routes,
    switchToHttp: () => ({ getRequest: () => req }),
  };
  try {
    await guard.canActivate(ctx as never);
    return 'ok';
  } catch (err) {
    if (err instanceof ProblemError) return [err.status, err.code];
    throw err;
  }
}

const fresh = () => new Date(Date.now() - 60_000);
const stale = () => new Date(Date.now() - STEP_UP_WINDOW_MS - 1_000);

describe('[S1][S9] access guard enforcement', () => {
  it('[S1] @RequireStepUp(): 428 without a step-up or with a stale one; passes with a fresh one', async () => {
    expect(await run('explicit', actor())).toEqual([428, 'auth.step_up_required']);
    expect(await run('explicit', actor({ stepUpAt: stale() }))).toEqual([428, 'auth.step_up_required']);
    expect(await run('explicit', actor({ stepUpAt: fresh() }))).toBe('ok');
  });

  it('[S9] a stepUp-flagged permission needs a fresh step-up with no decorator on the route', async () => {
    expect(await run('flagged', actor())).toEqual([428, 'auth.step_up_required']);
    expect(await run('flagged', actor({ stepUpAt: stale() }))).toEqual([428, 'auth.step_up_required']);
    expect(await run('flagged', actor({ stepUpAt: fresh() }))).toBe('ok');
  });

  it('[S9] an unflagged permission does not need step-up', async () => {
    expect(await run('plain', actor())).toBe('ok');
  });

  it('[S9] authorization is decided before step-up: no grant → 403, never an invitation to step up', async () => {
    expect(await run('flagged', actor({ grants: [grant('identity.user.view')] }))).toEqual([403, 'auth.forbidden']);
  });

  it('[S9] a flagged privileged permission still needs MFA on the session, even after step-up', async () => {
    expect(await run('flagged', actor({ mfaAt: null, stepUpAt: fresh() }))).toEqual([403, 'auth.mfa_required']);
  });

  it('[S8] a restricted session is refused before any step-up check', async () => {
    expect(await run('flagged', actor({ restricted: true, stepUpAt: fresh() }))).toEqual([403, 'auth.mfa_enrolment_required']);
    expect(await run('explicit', actor({ restricted: true, stepUpAt: fresh() }))).toEqual([403, 'auth.mfa_enrolment_required']);
    // Even where restricted sessions are allowed, step-up is still enforced.
    expect(await run('restrictedButStepUp', actor({ restricted: true }))).toEqual([428, 'auth.step_up_required']);
  });

  it('[S1] no session → 401', async () => {
    expect(await run('explicit', null)).toEqual([401, 'auth.unauthenticated']);
  });

  it('[S1] @RequireStepUp() on a @Public() route is refused, not silently skipped', async () => {
    expect(await run('publicStepUp', null)).toEqual([403, 'auth.forbidden']);
  });
});
