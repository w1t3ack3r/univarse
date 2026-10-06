import { describe, expect, it } from 'vitest';
import { csp, uploadOrigin } from './proxy';

describe('[W8] content security policy', () => {
  const prod = csp('abc123', false);

  it('allows scripts only with the request nonce, and no inline/eval in production', () => {
    expect(prod).toContain("script-src 'self' 'nonce-abc123' 'strict-dynamic'");
    expect(prod).not.toContain('unsafe-eval');
    expect(prod).toContain("style-src 'self' 'nonce-abc123'");
  });

  it("relaxes inline styles only for style attributes, never for scripts or <style> elements", () => {
    const inline = prod.split('; ').filter((d) => d.includes("'unsafe-inline'"));
    expect(inline).toEqual(["style-src-attr 'unsafe-inline'"]);
  });

  it('forbids framing, plugins, base-uri changes and foreign form targets', () => {
    for (const d of ["frame-ancestors 'none'", "object-src 'none'", "base-uri 'none'", "form-action 'self'"]) {
      expect(prod).toContain(d);
    }
  });

  it('names no third-party origin', () => {
    expect(prod).not.toMatch(/https?:\/\//);
  });

  it('relaxes only what dev tooling needs in development', () => {
    const dev = csp('n', true);
    expect(dev).toContain("'unsafe-eval'");
    expect(dev).toContain('ws:');
  });
});

describe('[FU5] upload origin in connect-src (spec 0010 D1)', () => {
  it('adds exactly the storage origin to connect-src and nowhere else', () => {
    const policy = csp('n', false, uploadOrigin('http://127.0.0.1:8333'));
    expect(policy).toContain("connect-src 'self' http://127.0.0.1:8333");
    expect(policy.split('; ').filter((d) => d.includes('127.0.0.1'))).toEqual(["connect-src 'self' http://127.0.0.1:8333"]);
  });

  it('accepts only a bare origin: anything that could inject directives is refused', () => {
    for (const bad of ['http://x.test; script-src *', 'http://x.test/path', "'unsafe-inline'", 'javascript:alert(1)', ' ', 'ftp://x.test']) {
      expect(uploadOrigin(bad)).toBeNull();
    }
    expect(uploadOrigin('https://files.univarse.ng')).toBe('https://files.univarse.ng');
  });
});
