// Spec 0019 B1/LS7: the smoke's HSTS check accepts exactly one header with exactly the stack's value. The live check
// runs after every deploy (smoke.ts); this pins what it refuses.
import { describe, expect, it } from 'vitest';
import { auditProblems, HSTS, hstsProblems } from './smoke.js';

describe('[LS7] HSTS at the edge (B1)', () => {
  it('[LS7] one header with the stack value passes', () => {
    expect(HSTS).toBe('max-age=63072000; includeSubDomains');
    expect(hstsProblems(['Content-Type', 'text/html', 'Strict-Transport-Security', HSTS])).toEqual([]);
  });

  it('[LS7] a second HSTS header left in place (the API\'s own) is refused, even when one of them is right', () => {
    expect(hstsProblems(['strict-transport-security', 'max-age=63072000; includeSubDomains; preload', 'Strict-Transport-Security', HSTS])).toEqual([
      expect.stringMatching(/^2 HSTS headers/),
    ]);
  });

  it('[LS7] preload, a missing includeSubDomains, or no header at all are refused', () => {
    expect(hstsProblems(['Strict-Transport-Security', `${HSTS}; preload`])).toEqual([expect.stringMatching(/not "max-age=63072000; includeSubDomains"/)]);
    expect(hstsProblems(['Strict-Transport-Security', 'max-age=63072000'])).toEqual([expect.stringMatching(/not "/)]);
    expect(hstsProblems(['Content-Type', 'text/html'])).toEqual(['no HSTS header']);
  });
});

describe('[LS8] the audit check (C3)', () => {
  const p = { plain: 'cGxhaW4tdGVzdC12YWx1ZQ==', context: 'dW5pdmFyc2U6c21va2U6MQ==', plainHmac: 'hmac-sha256:aaa', contextHmac: 'hmac-sha256:ccc' };
  const line = (o: unknown) => JSON.stringify(o);
  const wrap = line({ type: 'request', request: { path: 'transit/encrypt/univarse-kek', data: { plaintext: p.plainHmac, context: p.contextHmac } } });
  const unwrap = line({ type: 'response', request: { path: 'transit/decrypt/univarse-kek' }, response: { data: { plaintext: p.plainHmac } } });

  it('[LS8] the wrap and unwrap logged as HMACs pass', () => {
    expect(auditProblems([wrap, unwrap].join('\n'), p)).toEqual([]);
  });

  it('[LS8] a value in clear anywhere fails (log_raw on)', () => {
    const raw = line({ type: 'request', request: { path: 'transit/encrypt/univarse-kek', data: { plaintext: p.plain, context: p.context } } });
    expect(auditProblems([raw, unwrap].join('\n'), p)).toEqual(['the audit log holds a value in clear', 'the wrap is not in the audit log as HMACs']);
  });

  it('[LS8] a missing wrap or unwrap fails (no audit device, or another request\'s entries)', () => {
    expect(auditProblems(unwrap, p)).toEqual(['the wrap is not in the audit log as HMACs']);
    expect(auditProblems(wrap, p)).toEqual(['the unwrap is not in the audit log as an HMAC']);
    expect(auditProblems('', p)).toHaveLength(2);
  });
});
