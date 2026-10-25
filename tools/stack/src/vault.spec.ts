// Spec 0020 B-4: the tokens the env files carry, so a deploy that stops early never blanks a working one.
// Spec 0023: the tokens' lifecycle (T1 the policies, T3 renewal, T4 re-issue, T6 accessors, T9 a sealed Vault),
// against a scripted Vault that records every call's arguments, environment names and stdin.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Runner } from './docker.js';
import {
  APP_POLICY_HCL,
  classifyVaultFailure,
  configure,
  ensureVault,
  envTokens,
  initialise,
  lifeOf,
  redactTokens,
  renewBeforeSnapshot,
  renewTokens,
  SEALED_LINE,
} from './vault.js';

const withInit = (appToken: string) => {
  const dir = mkdtempSync(join(tmpdir(), 'uv-vault-'));
  writeFileSync(join(dir, 'vault-init.json'), JSON.stringify({ unsealKey: 'u', rootToken: 'r', appToken }));
  return dir;
};

describe('envTokens', () => {
  it("keeps vault-init.json's app token even before the deploy's Vault step", () => {
    // A blank one here rewrote keys.env with VAULT_TOKEN= (a refused deploy did), and the keys job failed at startup.
    expect(envTokens(false, withInit('app-token-value')).appToken).toBe('app-token-value');
    expect(envTokens(true, withInit('app-token-value')).appToken).toBe('app-token-value');
  });

  it('is blank only before Vault was initialised, and then required at the Vault step', () => {
    const dir = mkdtempSync(join(tmpdir(), 'uv-vault-'));
    expect(envTokens(false, dir).appToken).toBe('');
    expect(() => envTokens(true, dir)).toThrow(/stack:vault init/);
  });
});

// ---- spec 0023: a scripted Vault ----
interface Call {
  readonly args: readonly string[];
  readonly env: readonly string[];
  readonly input: string | undefined;
}
const ROOT = 'hvs.ROOTROOTROOTROOTROOT';
const BAD = 'Error writing data to auth/token/lookup: Error making API request.\n\nCode: 403. Errors:\n\n* bad token';
const SEALED = 'Error making API request.\n\nCode: 503. Errors:\n\n* Vault is sealed';

function fakeVault(o: { sealed?: boolean; initialized?: boolean; lookupError?: string } = {}) {
  const calls: Call[] = [];
  const live = new Map<string, string>(); // token → accessor
  const policies: Record<string, string> = {};
  let n = 0;
  const ok = (v: unknown) => ({ status: 0, stdout: typeof v === 'string' ? v : JSON.stringify(v), stderr: '' });
  const fail = (stderr: string) => ({ status: 2, stdout: '', stderr });
  const run: Runner = (args, opts = {}) => {
    const v = args.slice(args.indexOf('vault') + 1);
    calls.push({ args: [...args], env: Object.keys(opts.env ?? {}), input: opts.input });
    if (v[0] === 'status') return { status: o.sealed ? 2 : 0, stdout: JSON.stringify({ initialized: o.initialized ?? true, sealed: o.sealed ?? false }), stderr: '' };
    if (o.sealed) return fail(SEALED);
    if (v[0] === 'operator' && v[1] === 'init') return ok({ unseal_keys_b64: ['UNSEAL'], root_token: ROOT });
    if (v[0] === 'write' && v[2] === 'sys/unseal') return ok({ sealed: false });
    if (v[0] === 'audit' || v[0] === 'secrets') return ok(v[0] === 'audit' ? { 'file/': {} } : { 'transit/': {} });
    if (v[0] === 'read') return ok({});
    if (v[0] === 'policy') {
      policies[v[2] ?? ''] = opts.input ?? '';
      return ok('');
    }
    if (v[0] === 'token' && v[1] === 'create') {
      n++;
      const t = `hvs.NEWTOKEN${String(n)}xxxxxxxxxx`;
      live.set(t, `accessor-${String(n)}`);
      return ok({ auth: { client_token: t, accessor: `accessor-${String(n)}` } });
    }
    if (v[0] === 'write' && v[2] === 'auth/token/lookup') {
      if (o.lookupError) return fail(o.lookupError);
      const t = opts.input ?? '';
      if (!live.has(t)) return fail(BAD);
      return ok({ data: { ttl: 2_340_000, expire_time: '2026-11-21T19:42:31.913252177Z', period: 2764800, accessor: live.get(t) } });
    }
    if (v[0] === 'token' && v[1] === 'renew') {
      if (!live.has(opts.env?.VAULT_TOKEN ?? '')) return fail('Error renewing token: Error making API request.\n\nCode: 403. Errors:\n\n* permission denied');
      return ok({ auth: { lease_duration: 2764800 } });
    }
    throw new Error(`unscripted ${v.join(' ')}`);
  };
  return { run, calls, live, policies };
}
const TARGET = { container: 'v', tls: false };
function stackDir(tokens: { appToken?: string; backupToken?: string; appTokenAccessor?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'uv-vault-'));
  writeFileSync(join(dir, 'vault-init.json'), JSON.stringify({ unsealKey: 'UNSEAL', rootToken: ROOT, appToken: '', ...tokens }));
  return dir;
}
const saved = (dir: string) => JSON.parse(readFileSync(join(dir, 'vault-init.json'), 'utf8')) as Record<string, string>;
/** No call carries a secret among its arguments: the root token, or any token the fake issued or was given. */
const noTokenInArguments = (v: ReturnType<typeof fakeVault>, extra: string[] = []) => {
  const secrets = [ROOT, ...v.live.keys(), ...extra];
  for (const c of v.calls) for (const a of c.args) for (const s of secrets) expect(a.includes(s), `${s} in the arguments of ${c.args.join(' ')}`).toBe(false);
};
const APP = 'hvs.APPAPPAPPAPPAPPAPP';
const BACKUP = 'hvs.BACKUPBACKUPBACKUP';
const DEAD = 'hvs.DEADDEADDEADDEAD';

describe('[0023 T1] the policies', () => {
  it("the app policy is Transit's encrypt and decrypt on the KEK, and its token's own renewal and lookup; nothing else", () => {
    expect(APP_POLICY_HCL).toBe(
      'path "transit/encrypt/univarse-kek" { capabilities = ["update"] }\npath "transit/decrypt/univarse-kek" { capabilities = ["update"] }\n' +
        'path "auth/token/renew-self" { capabilities = ["update"] }\npath "auth/token/lookup-self" { capabilities = ["read"] }\n',
    );
  });

  it('configure writes both policies on every run, so existing tokens gain the new paths', () => {
    const v = fakeVault();
    configure(v.run, stackDir(), TARGET);
    expect(v.policies['univarse-app']).toBe(APP_POLICY_HCL);
    expect(v.policies['univarse-backup']).toContain('auth/token/renew-self');
  });
});

describe('[0023 T4][T6] configure: create, keep, backfill, re-issue', () => {
  it('first use: both tokens are created, periodic and orphan, each saved with its accessor', () => {
    const v = fakeVault({ initialized: false });
    const dir = mkdtempSync(join(tmpdir(), 'uv-vault-'));
    expect(initialise(v.run, dir, TARGET).reissued).toEqual([]);
    const s = saved(dir);
    expect(s.appToken).toMatch(/^hvs\.NEWTOKEN/);
    expect(s.backupToken).toMatch(/^hvs\.NEWTOKEN/);
    expect([s.appTokenAccessor, s.backupTokenAccessor]).toEqual(['accessor-1', 'accessor-2']);
    for (const c of v.calls.filter((x) => x.args.includes('create'))) expect(c.args).toEqual(expect.arrayContaining(['-no-default-policy', '-period', '768h', '-orphan']));
    noTokenInArguments(v);
  });

  it("a test's short period reaches token create, through configure's options only", () => {
    const v = fakeVault({ initialized: false });
    initialise(v.run, mkdtempSync(join(tmpdir(), 'uv-vault-')), TARGET, { period: '5s' });
    const creates = v.calls.filter((c) => c.args.includes('create'));
    expect(creates.length).toBe(2);
    expect(creates.every((c) => c.args.includes('5s'))).toBe(true);
  });

  it('live tokens are kept, and an accessor missing from vault-init.json is backfilled once', () => {
    const v = fakeVault();
    v.live.set(APP, 'accessor-app');
    v.live.set(BACKUP, 'accessor-backup');
    const dir = stackDir({ appToken: APP, backupToken: BACKUP });
    expect(configure(v.run, dir, TARGET).reissued).toEqual([]);
    expect(saved(dir)).toMatchObject({ appToken: APP, appTokenAccessor: 'accessor-app', backupToken: BACKUP, backupTokenAccessor: 'accessor-backup' });
    expect(v.calls.filter((c) => c.args.includes('create'))).toEqual([]);
    // The lookup: the root token by environment name, the token itself on stdin.
    const lookups = v.calls.filter((c) => c.args.includes('auth/token/lookup'));
    expect(lookups.map((c) => [c.env, c.input])).toEqual([
      [['VAULT_TOKEN'], APP],
      [['VAULT_TOKEN'], BACKUP],
    ]);
    noTokenInArguments(v, [APP, BACKUP]);
  });

  it('a token Vault calls a "bad token" is re-issued, saved with its new accessor, and reported; the live one is kept', () => {
    const v = fakeVault();
    v.live.set(BACKUP, 'accessor-backup');
    const dir = stackDir({ appToken: DEAD, appTokenAccessor: 'accessor-dead', backupToken: BACKUP });
    expect(configure(v.run, dir, TARGET).reissued).toEqual(['app']);
    const s = saved(dir);
    expect(s.appToken).toMatch(/^hvs\.NEWTOKEN/);
    expect(s.appTokenAccessor).toBe('accessor-1');
    expect(s.backupToken).toBe(BACKUP);
    noTokenInArguments(v, [DEAD, BACKUP]);
  });

  for (const [what, stderr] of [
    ['a sealed Vault', SEALED],
    ['any other failure (a 500)', 'Error making API request.\n\nCode: 500. Errors:\n\n* internal error'],
  ] as const)
    it(`${what} during the lookup: configure stops, mints nothing, and saves nothing`, () => {
      const v = fakeVault({ lookupError: stderr });
      const dir = stackDir({ appToken: APP, backupToken: BACKUP });
      const before = readFileSync(join(dir, 'vault-init.json'), 'utf8');
      expect(() => configure(v.run, dir, TARGET)).toThrow(/looking up the app token failed/);
      expect(v.calls.filter((c) => c.args.includes('create'))).toEqual([]);
      expect(readFileSync(join(dir, 'vault-init.json'), 'utf8')).toBe(before);
    });
});

describe('[0023 T3] renewal', () => {
  it('each token renews itself, by its own VAULT_TOKEN, and the lines say how long it now lives', () => {
    const v = fakeVault();
    v.live.set(APP, 'a');
    v.live.set(BACKUP, 'b');
    const r = renewTokens(v.run, stackDir({ appToken: APP, backupToken: BACKUP }), TARGET);
    expect(r).toEqual({ ok: true, lines: ['app token: renewed, 32.0 days', 'backup token: renewed, 32.0 days'] });
    expect(v.calls.filter((c) => c.args.includes('renew')).map((c) => c.env)).toEqual([['VAULT_TOKEN'], ['VAULT_TOKEN']]);
    noTokenInArguments(v, [APP, BACKUP]);
  });

  it("a refused renewal is reported, never thrown, and doesn't stop the other token's", () => {
    const v = fakeVault();
    v.live.set(BACKUP, 'b');
    const r = renewTokens(v.run, stackDir({ appToken: DEAD, backupToken: BACKUP }), TARGET);
    expect(r.ok).toBe(false);
    expect(r.lines[0]).toMatch(/^app token: not renewed: exit 2: .*permission denied/);
    expect(r.lines[1]).toBe('backup token: renewed, 32.0 days');
    expect(r.lines.join()).not.toContain('DEAD');
  });

  it('a token not created yet is named, not renewed', () => {
    const v = fakeVault();
    v.live.set(APP, 'a');
    expect(renewTokens(v.run, stackDir({ appToken: APP }), TARGET).lines[1]).toMatch(/^backup token: none yet/);
  });
});

describe('[0023 T9] a sealed Vault is named first, and is never a dead token', () => {
  it('ensureVault on a sealed Vault throws the unseal line, and calls nothing after the status', () => {
    const v = fakeVault({ sealed: true });
    expect(() => ensureVault(v.run, stackDir({ appToken: APP }), TARGET)).toThrow(SEALED_LINE);
    expect(v.calls.map((c) => c.args[c.args.indexOf('vault') + 1])).toEqual(['status']);
  });

  it('a renewal against a sealed Vault says sealed, not invalid or expired', () => {
    expect(renewTokens(fakeVault({ sealed: true }).run, stackDir({ appToken: APP }), TARGET).lines[0]).toBe(`app token: not renewed: ${SEALED_LINE}`);
  });

  it('ensureVault on a ready Vault configures, then renews both tokens', () => {
    const v = fakeVault();
    v.live.set(APP, 'a');
    v.live.set(BACKUP, 'b');
    expect(ensureVault(v.run, stackDir({ appToken: APP, backupToken: BACKUP }), TARGET).renewal.ok).toBe(true);
    const verbs = v.calls.map((c) => c.args.slice(c.args.indexOf('vault') + 1).join(' '));
    expect(verbs.findIndex((x) => x.startsWith('token renew'))).toBeGreaterThan(verbs.findIndex((x) => x.includes('policy write univarse-backup')));
  });

  it("the classification: Vault's words for sealed and for a dead token; anything else with tokens redacted", () => {
    expect(classifyVaultFailure({ status: 2, stderr: SEALED })).toEqual({ kind: 'sealed' });
    expect(classifyVaultFailure({ status: 2, stderr: BAD })).toEqual({ kind: 'bad_token' });
    expect(classifyVaultFailure({ status: 2, stderr: '* invalid token' })).toEqual({ kind: 'bad_token' });
    expect(classifyVaultFailure({ status: 2, stderr: 'Error: permission denied for hvs.CAESIJ1234567890abcdef' })).toEqual({ kind: 'error', detail: 'exit 2: Error: permission denied for <token>' });
    expect(redactTokens('x hvs.AAAAAAAAAAAAAAAA y')).toBe('x <token> y');
    expect(redactTokens('accessor 0123456789abcdefghijklmnop')).toBe('accessor <redacted>');
  });

  it('a lifetime reads in days, with its expiry to the second', () => {
    expect(lifeOf(2_340_000, '2026-11-21T19:42:31.913252177Z')).toBe('27.1 days, until 2026-11-21T19:42:31Z');
  });
});

describe('[0023] the backup renews its own token before its snapshot', () => {
  it('renewed: the snapshot goes ahead, and the renewal used the backup token by name only', () => {
    const v = fakeVault();
    v.live.set(BACKUP, 'b');
    expect(renewBeforeSnapshot(v.run, BACKUP, TARGET)).toBeNull();
    expect(v.calls.map((c) => [c.args.slice(c.args.indexOf('vault') + 1).join(' '), c.env])).toEqual([['token renew -format=json', ['VAULT_TOKEN']]]);
    noTokenInArguments(v, [BACKUP]);
  });

  it('a sealed Vault stops the run in its own words', () => {
    expect(renewBeforeSnapshot(fakeVault({ sealed: true }).run, BACKUP, TARGET)).toBe(SEALED_LINE);
  });

  it("a dead token stops the run, naming the deploy's re-issue", () => {
    const deadRun: Runner = () => ({ status: 2, stdout: '', stderr: 'Error renewing token: Code: 403. Errors:\n* invalid token' });
    expect(renewBeforeSnapshot(deadRun, DEAD, TARGET)).toMatch(/backup token is invalid or expired: `pnpm stack:deploy` re-issues it/);
  });

  it("any other renewal failure doesn't cost the day's set: the snapshot decides", () => {
    expect(renewBeforeSnapshot(fakeVault().run, DEAD, TARGET)).toBeNull(); // the fake answers "permission denied"
  });
});
