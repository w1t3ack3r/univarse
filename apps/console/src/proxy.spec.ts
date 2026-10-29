import { describe, expect, it } from 'vitest';
import { environmentOf } from './environment';
import { CONSOLE_SESSION_COOKIE, csp } from './proxy';

describe('[P6] the console\'s CSP', () => {
  const prod = csp('bm9uY2U=', false);

  it('runs only nonce\'d scripts, and no inline or eval script in production', () => {
    expect(prod).toContain("script-src 'self' 'nonce-bm9uY2U=' 'strict-dynamic'");
    expect(prod).not.toMatch(/script-src[^;]*'unsafe-(inline|eval)'/);
    expect(prod).not.toMatch(/style-src [^;]*'unsafe-inline'/);
  });

  it('talks to its own host only: no storage origin, no third party, no framing', () => {
    expect(prod).toContain("connect-src 'self';");
    expect(prod).toContain("frame-ancestors 'none'");
    expect(prod).toContain("object-src 'none'");
    expect(prod).not.toMatch(/https?:\/\//);
  });
});

describe('[P6] the reserved session cookie (spec 0026 T-B)', () => {
  it('is __Host-, HttpOnly, Secure and SameSite=Strict', () => {
    expect(CONSOLE_SESSION_COOKIE).toEqual({ name: '__Host-uv_console_sid', sameSite: 'strict', httpOnly: true, secure: true, path: '/' });
  });
});

describe('the environment label', () => {
  it('names the three environments, in any case', () => {
    expect(environmentOf('local')).toBe('LOCAL');
    expect(environmentOf(' Staging ')).toBe('STAGING');
    expect(environmentOf('PRODUCTION')).toBe('PRODUCTION');
  });

  it('shows anything unknown or missing as LOCAL, never as PRODUCTION', () => {
    for (const v of [undefined, '', 'prod', 'live', 'PRODUCTIONX']) expect(environmentOf(v)).toBe('LOCAL');
  });
});
