// Spec 0012 OB2/OB7, enforced on the source: every app log call names a stable `event`, and every
// security event is both listed and actually logged somewhere.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { bucketName, SECURITY_EVENTS, securityFields } from './security.js';

const SRC = fileURLToPath(new URL('../../', import.meta.url));
const EXCLUDED = /(\.spec\.ts|\.int\.spec\.ts)$|[\\/](testing|cli)[\\/]|[\\/]shared[\\/]observability[\\/]/;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return sources(p);
    return p.endsWith('.ts') && !EXCLUDED.test(p) ? [p] : [];
  });
}

/** The text of a call's arguments, from just after `(` to its matching `)`. */
function argsAt(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')' && --depth === 0) return src.slice(open + 1, i);
  }
  return src.slice(open + 1);
}

const CALL = /(this\.logger|new Logger\([^)]*\)|app\.log)\.(log|warn|error|debug|verbose|fatal)\(/g;
const calls = sources(SRC).flatMap((file) => {
  const src = readFileSync(file, 'utf8');
  return [...src.matchAll(CALL)].map((m) => ({
    where: `${relative(SRC, file)}:${String(src.slice(0, m.index).split('\n').length)}`,
    args: argsAt(src, m.index + m[0].length - 1).trim(),
  }));
});

describe('[OB2] every app log call names its event', () => {
  it('[OB2] all log call sites were found (the migration covered 35, plus the new security lines)', () => {
    expect(calls.length).toBeGreaterThanOrEqual(38);
  });

  it('[OB2] each passes an object with `event` first, or securityFields(...): never a bare string', () => {
    const missing = calls.filter((c) => !(/^\{[\s\S]*\bevent:/.test(c.args) || c.args.startsWith('securityFields(')));
    expect(missing.map((c) => `${c.where}: ${c.args.slice(0, 80)}`)).toEqual([]);
  });

  it('[OB2] no call site interpolates tenant or user into the message text', () => {
    expect(calls.filter((c) => /\$\{[^}]*(tenant|user)/i.test(c.args)).map((c) => c.where)).toEqual([]);
  });
});

describe('[OB2] the log context is for observability only', () => {
  it('[OB2] nothing outside shared/observability reads it (tenancy and authorization use the explicit context)', () => {
    const readers = sources(SRC)
      .filter((f) => /\bcurrentLogContext\b/.test(readFileSync(f, 'utf8')))
      .map((f) => relative(SRC, f));
    expect(readers).toEqual([]);
  });
});

describe('[OB7] the security stream', () => {
  it('[OB7] the security events are exactly these', () => {
    expect([...SECURITY_EVENTS].sort()).toEqual(
      [
        'access.route_undeclared',
        'access.step_up_on_public_route',
        'auth.account.locked',
        'auth.rate_limited',
        'auth.session.invalid_token',
        'auth.step_up.failed',
        'files.scan.malware_detected',
        'http.csrf_rejected',
        'products.route_undeclared',
      ].sort(),
    );
  });

  it('[OB7] each security event is actually logged somewhere, through securityFields', () => {
    const used = new Set(calls.flatMap((c) => [...c.args.matchAll(/securityFields\('([a-z._]+)'/g)].map((m) => m[1])));
    expect(SECURITY_EVENTS.filter((e) => !used.has(e))).toEqual([]);
  });

  it('[OB7] security lines carry stream "security"; rate-limit buckets never include the IP or identifier', () => {
    expect(securityFields('auth.account.locked', { tenantId: 't' })).toEqual({ event: 'auth.account.locked', stream: 'security', tenantId: 't' });
    expect(bucketName('8a2c…tenant:login:ipid:10.0.0.9:ada@uni.ng')).toBe('login:ipid');
  });
});
