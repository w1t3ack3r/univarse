// Spec 0019 D7: what Prisma's schema engine is given, so it verifies PostgreSQL. The forms were measured against a
// TLS endpoint (spec 0019's notes): only `require` + `sslcert` + `sslaccept=strict` checks the chain and the name.
import { describe, expect, it } from 'vitest';
import { schemaEngineUrl, verifiesServer } from './tls.js';

const SECRET = 'not-a-real-password-0123456789';
const BASE = `postgresql://univarse_migrator:${SECRET}@postgres:5432/univarse_platform`;
const engine = (url: string) => schemaEngineUrl('PLATFORM_MIGRATOR_URL', { PLATFORM_MIGRATOR_URL: url });

describe('schemaEngineUrl', () => {
  it("turns libpq's verify-full into the only form the schema engine verifies with, keeping the CA file", () => {
    const out = new URL(engine(`${BASE}?sslmode=verify-full&sslrootcert=/ca/ca.crt`) ?? '');
    expect(Object.fromEntries(out.searchParams)).toEqual({ sslmode: 'require', sslcert: '/ca/ca.crt', sslaccept: 'strict' });
    expect(`${out.protocol}//${out.username}:${out.password}@${out.host}${out.pathname}`).toBe(BASE);
  });

  it('passes a URL with no TLS settings unchanged (the smoke), and an unset variable as unset', () => {
    expect(engine(BASE)).toBe(BASE);
    expect(schemaEngineUrl('PLATFORM_MIGRATOR_URL', {})).toBeUndefined();
  });

  it("refuses any TLS setting it can't make verify, naming the variable and never the password", () => {
    for (const q of ['sslmode=require', 'sslmode=verify-full', 'sslmode=verify-ca&sslrootcert=/ca/ca.crt', 'sslmode=disable', 'sslrootcert=/ca/ca.crt', 'sslmode=prefer&sslrootcert=/ca/ca.crt']) {
      let message = '';
      try {
        engine(`${BASE}?${q}`);
      } catch (e) {
        message = (e as Error).message;
      }
      expect([q, message]).toEqual([q, expect.stringMatching(/^PLATFORM_MIGRATOR_URL: the migrate job needs sslmode=verify-full with sslrootcert/)]);
      expect(message).not.toContain(SECRET);
    }
  });
});

describe('verifiesServer', () => {
  it('is true only for verify-full with a CA file', () => {
    expect(verifiesServer(`${BASE}?sslmode=verify-full&sslrootcert=/ca/ca.crt`)).toBe(true);
    for (const q of ['', '?sslmode=verify-full', '?sslmode=require&sslrootcert=/ca/ca.crt', '?sslmode=verify-full&sslrootcert=']) expect([q, verifiesServer(`${BASE}${q}`)]).toEqual([q, false]);
    expect(verifiesServer('not a url')).toBe(false);
  });
});
