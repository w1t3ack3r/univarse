// Spec 0028 Q9, Q11, Q12: every platform route declares its access (the guard refuses one that doesn't); the routes
// anyone can reach are exactly the sign-in ones, each rate-limited; staff changes need a step-up; and nothing creates a
// member except an OWNER's invite (no sign-up route, Q5, T27).
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants.js';
import { RequestMethod } from '@nestjs/common';
import { PLATFORM_PERMISSION_CATALOG } from '@univarse/domain';
import { describe, expect, it } from 'vitest';
import { PLATFORM_CONTROLLERS } from '../platform.module.js';
import { AddressLimiter, platformRouteAccess } from './access.js';

interface Route {
  readonly key: string;
  readonly access: ReturnType<typeof platformRouteAccess>;
}

function routes(): Route[] {
  return PLATFORM_CONTROLLERS.flatMap((type) => {
    const base = String(Reflect.getMetadata(PATH_METADATA, type) ?? '');
    const proto = type.prototype as unknown as Record<string, unknown>;
    return Object.getOwnPropertyNames(proto).flatMap((name) => {
      const handler = proto[name];
      if (typeof handler !== 'function' || name === 'constructor') return [];
      const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
      if (method === undefined) return [];
      const path = String(Reflect.getMetadata(PATH_METADATA, handler) ?? '');
      const key = `${RequestMethod[method]} /${[base, path].filter((p) => p && p !== '/').join('/')}`;
      return [{ key, access: platformRouteAccess(handler, type) }];
    });
  });
}

describe('the platform routes (spec 0028 Q12)', () => {
  const all = routes();

  it('finds them all, and each declares its access', () => {
    expect(all.length).toBeGreaterThanOrEqual(20);
    expect(all.filter((r) => !r.access.access).map((r) => r.key)).toEqual([]);
  });

  it('the public routes are exactly health and sign-in, and every sign-in route is rate-limited', () => {
    const open = all.filter((r) => r.access.access?.kind === 'public').map((r) => r.key).sort();
    expect(open).toEqual(
      [
        'GET /health/live',
        'GET /health/ready',
        'POST /api/platform/v1/auth/activate',
        'POST /api/platform/v1/auth/login',
        'POST /api/platform/v1/auth/mfa',
        'POST /api/platform/v1/auth/password-reset/confirm',
        'POST /api/platform/v1/auth/password-reset/request',
      ].sort(),
    );
    for (const r of all.filter((x) => x.access.access?.kind === 'public' && x.key.includes('/auth/'))) expect([r.key, r.access.ratePerMinute]).toEqual([r.key, 20]);
  });

  it('no route creates a member but the OWNER\'s invite: there is no sign-up (Q5, T27)', () => {
    const creating = all.filter((r) => r.key.startsWith('POST') && /\/(staff|users|members|signup|sign-up|register)$/.test(r.key));
    expect(creating.map((r) => r.key)).toEqual(['POST /api/platform/v1/staff']);
    expect(creating[0]?.access.access).toEqual({ kind: 'permission', permission: 'platform.staff.manage' });
  });

  it('every staff change needs platform.staff.manage, which the catalogue flags for step-up (Q11, Q13)', () => {
    const writes = all.filter((r) => r.key.includes('/staff') && !r.key.startsWith('GET'));
    expect(writes.length).toBe(5); // invite, role, deactivate, reinstate, MFA reset
    for (const r of writes) expect([r.key, r.access.access]).toEqual([r.key, { kind: 'permission', permission: 'platform.staff.manage' }]);
    expect(PLATFORM_PERMISSION_CATALOG['platform.staff.manage'].stepUp).toBe(true);
  });

  it('regenerating recovery codes needs an explicit step-up (Q11)', () => {
    const r = all.find((x) => x.key === 'POST /api/platform/v1/me/mfa/recovery-codes');
    expect(r?.access.stepUp).toBe(true);
  });
});

describe('the per-address limit (spec 0028 Q9)', () => {
  it('allows the limit in a minute, refuses the next, and opens again after the minute', () => {
    let t = 0;
    const l = new AddressLimiter(() => t);
    for (let i = 0; i < 3; i++) expect(l.take('a', 3)).toBe(true);
    expect(l.take('a', 3)).toBe(false);
    expect(l.take('b', 3)).toBe(true);
    t = 60_000;
    expect(l.take('a', 3)).toBe(true);
  });
});
