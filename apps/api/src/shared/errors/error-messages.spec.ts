// Every problem code the API can emit has a user-facing message (spec 0005 W4, docs/11 §2).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ERROR_MESSAGES } from '@univarse/contracts';
import { describe, expect, it } from 'vitest';

const SRC = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return name.endsWith('.ts') && !name.endsWith('.spec.ts') ? [path] : [];
  });
}

describe('[W4] error messages', () => {
  it('covers every code the API can emit: thrown ProblemErrors, validation, and the filter defaults', () => {
    const codes = new Set<string>();
    for (const file of sources(SRC)) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(/(?:ProblemError|super)\(\s*\d+,\s*'([a-z_.]+)'/g)) codes.add(m[1]!); // thrown
      for (const m of text.matchAll(/\['([a-z_]+\.[a-z_.]+)',\s*'/g)) codes.add(m[1]!); // filter status defaults
      for (const m of text.matchAll(/problemType\('([a-z_.]+)'\)/g)) codes.add(m[1]!); // filter literals
    }
    expect(codes.size).toBeGreaterThan(15); // the scan actually found the codes
    const missing = [...codes].filter((c) => !Object.hasOwn(ERROR_MESSAGES, c)).sort();
    expect(missing).toEqual([]);
  });

  it('never leaks whether an account exists: credential errors share one neutral message', () => {
    expect(ERROR_MESSAGES['auth.invalid_credentials']).not.toMatch(/exist|found|unknown|no such/i);
  });
});

describe('[W11][W12] password problems have plain messages', () => {
  it('covers every code password.ts can report', async () => {
    const { PASSWORD_PROBLEM_MESSAGES } = await import('@univarse/contracts');
    const text = readFileSync(join(SRC, 'modules/identity/password.ts'), 'utf8');
    const codes = [...text.matchAll(/problems\.push\('([a-z_]+)'\)/g)].map((m) => m[1]!);
    expect(codes.length).toBeGreaterThanOrEqual(4);
    expect(codes.filter((c) => !Object.hasOwn(PASSWORD_PROBLEM_MESSAGES, c))).toEqual([]);
  });
});
