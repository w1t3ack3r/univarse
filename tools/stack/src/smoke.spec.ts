// Spec 0019 B1/LS7: the smoke's HSTS check accepts exactly one header with exactly the stack's value. The live check
// runs after every deploy (smoke.ts); this pins what it refuses.
import { describe, expect, it } from 'vitest';
import { nextEntry, WAIVER_STATEMENT } from './ledger/chain.js';
import { auditProblems, HSTS, hstsProblems, tokenReport, waiverNotice } from './smoke.js';

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

describe('[BK17] the waiver, reported by every smoke run', () => {
  const genesis = (generation: number) =>
    nextEntry(null, {
      type: 'genesis',
      ledgerId: '20000000-0000-4000-8000-000000000001',
      generation,
      ...(generation > 1 ? { attempt: '20000000-0000-4000-8000-000000000002', transition: { reason: 'lost', at: '2026-10-23T10:00:00.000Z', oldHeads: [], statement: WAIVER_STATEMENT } } : {}),
      destinations: [{ id: 'primary', path: '/ledger' }],
    });
  const at = { generation: 1, attempt: null };

  it('[BK17] a waived generation of record: the notice, with its time', () => {
    expect(waiverNotice(() => ({ ok: true, entries: [genesis(2)], destinations: [], at }))).toBe('no-resurrection guarantee waived since 2026-10-23T10:00:00.000Z (generation 2)');
  });
  it("[BK17] generation 1, or a ledger that can't be read: no notice", () => {
    expect(waiverNotice(() => ({ ok: true, entries: [genesis(1)], destinations: [], at }))).toBeNull();
    expect(waiverNotice(() => ({ ok: false, problems: ['missing'] }))).toBeNull();
  });
});

describe('[0023 T5] the tokens in the smoke check', () => {
  const DAY = 86400;
  const info = (days: number) => ({ ttlSeconds: Math.round(days * DAY), expireTime: '2026-11-21T19:42:31.913252177Z', period: 2764800, accessor: 'acc' });

  it('each token gets a line with its life left; 7 days or more is no problem', () => {
    const r = tokenReport([
      { name: 'app', info: info(27.1) },
      { name: 'backup', info: info(7) },
    ]);
    expect(r.problems).toEqual([]);
    expect(r.lines).toEqual(['the app token has 27.1 days, until 2026-11-21T19:42:31Z', 'the backup token has 7.0 days, until 2026-11-21T19:42:31Z']);
  });

  it('just under 7 days fails, naming the token and the remedy', () => {
    const r = tokenReport([{ name: 'backup', info: { ...info(7), ttlSeconds: 7 * DAY - 1 } }]);
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toMatch(/^the backup token has only 7\.0 days.*under 7 days: its renewal is failing \(run `pnpm stack:vault renew`/);
  });

  it('a missing token, a dead one and a sealed Vault are problems, each in its own words', () => {
    const r = tokenReport([
      { name: 'app', failure: { kind: 'bad_token' } },
      { name: 'backup', missing: true },
    ]);
    expect(r.problems).toEqual([
      'the app token could not be looked up: Vault says the token is invalid or expired (`pnpm stack:deploy` re-issues it)',
      'the backup token is missing from vault-init.json: deploy once (its Vault step creates it)',
    ]);
    expect(tokenReport([{ name: 'app', failure: { kind: 'sealed' } }]).problems[0]).toMatch(/Vault is sealed: run `pnpm stack:vault unseal`/);
  });
});
