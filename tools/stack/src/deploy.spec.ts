// Spec 0019 LS2/LS3: the deploy verifies first, and a rejected record creates, writes and starts nothing. These
// tests use the REAL verifyRelease (spec 0013), with a fake cosign standing for the registry's signatures, and the
// REAL registry lock in a temporary directory; every other step is recorded instead of run.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ROLES } from '../../images/release-lib.mjs';
import { acquireRegistryLock } from '../../images/registry-lock.mjs';
import { verifyRelease as realVerify } from '../../images/verify-release.mjs';
import { deploy, imagesFrom, nextState, SERVICES, type DeployDeps, type VaultState } from './deploy.js';
import type { ReleaseRecord, Verification } from './release.js';

const COMMIT = 'c'.repeat(40);
const ROLE_NAMES = Object.keys(ROLES) as (keyof typeof ROLES)[];
const digest = (n: number) => `sha256:${String(n).repeat(64).slice(0, 64)}`;
const D = Object.fromEntries(ROLE_NAMES.map((r, i) => [r, digest(i + 1)])) as Record<string, string>;
const UNSIGNED = digest(9);

/** A fake cosign: these digests are signed, with provenance naming their role, the commit and rehearsal: false. */
function fakeCosign(signed: Record<string, Record<string, unknown>>) {
  return (args: string[]) => {
    const ref = args.at(-1) ?? '';
    const entry = signed[ref.split('@')[1] ?? ''];
    if (!entry) return { status: 10, stdout: '', stderr: 'error during command execution: no signatures found' };
    if (args[0] === 'verify') return { status: 0, stdout: '[]', stderr: '' };
    if (args[args.indexOf('--type') + 1] === 'spdxjson') return { status: 0, stdout: '{}', stderr: '' };
    const payload = Buffer.from(JSON.stringify({ predicate: { buildDefinition: { externalParameters: entry } } })).toString('base64');
    return { status: 0, stdout: `${JSON.stringify({ payload })}\n`, stderr: '' };
  };
}
const prov = (role: string, over: Record<string, unknown> = {}) => ({ role, dockerfile: ROLES[role as keyof typeof ROLES].dockerfile, commit: COMMIT, rehearsal: false, ...over });
const SIGNED = Object.fromEntries(ROLE_NAMES.map((r) => [D[r], prov(r)]));
const record = (): ReleaseRecord => ({
  commit: COMMIT,
  rehearsal: false,
  images: Object.fromEntries(ROLE_NAMES.map((r) => [r, { repo: ROLES[r].repo, digest: D[r] ?? '' }])),
});

let lockDir: string;
let calls: string[];
function deps(over: Partial<DeployDeps> = {}, signed = SIGNED, vault: VaultState = 'ready'): DeployDeps {
  return {
    registry: () => (calls.push('registry'), () => calls.push('registry-stop')),
    lock: (holder) => acquireRegistryLock(lockDir, holder),
    verify: (rec, { commit }) =>
      (realVerify as unknown as (r: ReleaseRecord, o: object) => Verification)(rec, { commit, pub: '/keys/cosign.pub', cosign: fakeCosign(signed) }),
    prepare: (withVault) => void calls.push(`prepare:${String(withVault)}`),
    scanThirdParty: () => (calls.push('scan'), []),
    compose: (args) => (calls.push(`compose:${args.join(' ')}`), { status: 0 }),
    vaultState: () => (calls.push('vaultState'), vault),
    ensureVault: () => void calls.push('ensureVault'),
    buckets: () => (calls.push('buckets'), []),
    smoke: () => (calls.push('smoke'), Promise.resolve([])),
    logs: () => '',
    saveState: () => void calls.push('saveState'),
    log: () => undefined,
    ...over,
  };
}
/** Steps that create, write or start something: none may run for a rejected record. */
const effects = () => calls.filter((c) => !c.startsWith('registry'));

beforeEach(() => {
  lockDir = mkdtempSync(join(tmpdir(), 'uv-stack-lock-'));
  calls = [];
});
afterEach(() => rmSync(lockDir, { recursive: true, force: true }));

describe('[LS3] a rejected record starts nothing', () => {
  const edits: [string, (r: ReleaseRecord) => ReleaseRecord, RegExp, Record<string, Record<string, unknown>>?][] = [
    ['a changed digest (unsigned)', (r) => ({ ...r, images: { ...r.images, api: { repo: ROLES.api.repo, digest: UNSIGNED } } }), /api: signature does not verify/],
    ['an extra role', (r) => ({ ...r, images: { ...r.images, worker: { repo: ROLES.api.repo, digest: D.api ?? '' } } }), /unknown image role "worker"/],
    ['a missing role', (r) => ({ ...r, images: Object.fromEntries(Object.entries(r.images).filter(([k]) => k !== 'pgbouncer')) }), /no pgbouncer image/],
    ['a different commit', (r) => ({ ...r, commit: 'd'.repeat(40) }), /record commit d{40} is not the expected c{40}/],
    ['a rehearsal', (r) => r, /rehearsal is never deployable/, Object.fromEntries(ROLE_NAMES.map((n) => [D[n], prov(n, { rehearsal: true })]))],
    ['an image signed for another role', (r) => ({ ...r, images: { ...r.images, web: { repo: ROLES.web.repo, digest: D.api ?? '' } } }), /web: signed provenance does not name role web/],
  ];
  for (const [name, edit, reason, signed] of edits)
    it(`[LS3] ${name}: rejected at verification; nothing prepared, scanned, composed or saved; the lock released`, async () => {
      const r = await deploy(edit(record()), COMMIT, deps({}, signed ?? SIGNED));
      expect(r.ok).toBe(false);
      expect(r.problems.join('\n')).toMatch(reason);
      expect(effects()).toEqual([]);
      // The lock was released: it can be taken again.
      acquireRegistryLock(lockDir, 'after').release();
    });

  it('[LS3] the lock is held for the whole deploy: a concurrent deploy or prune is refused while it runs', async () => {
    let whileRunning = '';
    const d = deps({
      smoke: () => {
        try {
          acquireRegistryLock(lockDir, 'prune --apply');
          whileRunning = 'ACQUIRED';
        } catch (e) {
          whileRunning = (e as Error).message;
        }
        return Promise.resolve([]);
      },
    });
    expect((await deploy(record(), COMMIT, d)).ok).toBe(true);
    expect(whileRunning).toMatch(/locked by deploy/);
  });

  it('[LS3] a failure before verification (no registry) still releases the lock', async () => {
    const d = deps({ registry: () => { throw new Error('no local registry'); } });
    await expect(deploy(record(), COMMIT, d)).rejects.toThrow(/no local registry/);
    expect(effects()).toEqual([]);
    acquireRegistryLock(lockDir, 'after').release();
  });

  it('[LS3] while another holder has the lock, the deploy refuses before verifying or starting anything', async () => {
    const held = acquireRegistryLock(lockDir, 'release');
    try {
      await expect(deploy(record(), COMMIT, deps())).rejects.toThrow(/locked by release/);
      expect(calls).toEqual([]);
    } finally {
      held.release();
    }
  });
});

describe('[LS3][LS4] a verified record: the order of the deploy', () => {
  it('[LS3][LS4] verification, configuration, Vault, PostgreSQL, the migrate job, then the stack, the smoke and the state', async () => {
    const r = await deploy(record(), COMMIT, deps());
    expect(r).toEqual({ ok: true, problems: [] });
    expect(effects()).toEqual([
      'prepare:false',
      'scan',
      'compose:up -d --wait vault',
      'vaultState',
      'ensureVault',
      'prepare:true',
      'compose:up -d --wait postgres',
      'compose:--profile job run --rm migrate',
      'compose:up -d --wait seaweedfs',
      'buckets',
      `compose:up -d --wait --remove-orphans ${SERVICES.join(' ')}`,
      'smoke',
      'saveState',
    ]);
    expect(calls.at(-1)).toBe('registry-stop');
  });

  it('[LS4] a failed migrate job starts nothing new and saves no state', async () => {
    const d = deps({ compose: (args) => (calls.push(`compose:${args.join(' ')}`), { status: args.includes('migrate') ? 1 : 0 }) });
    const r = await deploy(record(), COMMIT, d);
    expect(r.problems.join()).toMatch(/migrate job failed/);
    expect(calls.some((c) => c.includes('--remove-orphans'))).toBe(false);
    expect(calls).not.toContain('saveState');
  });

  it('[LS4] buckets that cannot be created stop the deploy before the API and worker start', async () => {
    const r = await deploy(record(), COMMIT, deps({ buckets: () => (calls.push('buckets'), ['bucket uv-clean was not created']) }));
    expect(r).toEqual({ ok: false, problems: ['bucket uv-clean was not created'] });
    expect(calls.some((c) => c.includes('--remove-orphans'))).toBe(false);
    expect(calls).not.toContain('saveState');
  });

  it('[LS3] a sealed Vault stops the deploy before the database, naming the owner\'s step', async () => {
    const r = await deploy(record(), COMMIT, deps({}, SIGNED, 'sealed'));
    expect(r.problems.join()).toMatch(/pnpm stack:vault unseal/);
    expect(calls.some((c) => c.includes('postgres'))).toBe(false);
  });

  it('[LS3] the first deploy initialises Vault (ensureVault) before configuring with its token', async () => {
    await deploy(record(), COMMIT, deps({}, SIGNED, 'uninitialised'));
    expect(effects().slice(3, 6)).toEqual(['vaultState', 'ensureVault', 'prepare:true']);
  });

  it('[LS6] a failed smoke fails the deploy and saves no state', async () => {
    const r = await deploy(record(), COMMIT, deps({ smoke: () => Promise.resolve(['web /login: HTTP 502']) }));
    expect(r).toEqual({ ok: false, problems: ['web /login: HTTP 502'] });
    expect(calls).not.toContain('saveState');
  });
});

describe('[LS2] only digests', () => {
  it('[LS2] the compose variables are the verified digests, as the host pulls them', () => {
    const v: Verification = { ok: true, problems: [], results: Object.fromEntries(ROLE_NAMES.map((r) => [r, `registry:5000/${ROLES[r].repo}@${D[r] ?? ''}`])) };
    const { images, problems } = imagesFrom(v);
    expect(problems).toEqual([]);
    expect(images).toEqual({
      UNIVARSE_API_IMAGE: `localhost:5000/univarse-api@${D.api ?? ''}`,
      UNIVARSE_WEB_IMAGE: `localhost:5000/univarse-web@${D.web ?? ''}`,
      UNIVARSE_MIGRATE_IMAGE: `localhost:5000/univarse-migrate@${D.migrate ?? ''}`,
      UNIVARSE_PGBOUNCER_IMAGE: `localhost:5000/univarse-pgbouncer@${D.pgbouncer ?? ''}`,
    });
  });

  it('[LS2] a reference without a digest is refused, and so is one outside the local registry', () => {
    const tag: Verification = { ok: true, problems: [], results: { ...Object.fromEntries(ROLE_NAMES.map((r) => [r, `registry:5000/${ROLES[r].repo}@${D[r] ?? ''}`])), api: 'registry:5000/univarse-api:latest' } };
    expect(imagesFrom(tag).problems.join()).toMatch(/api: localhost:5000\/univarse-api:latest is not pinned by digest/);
    const elsewhere: Verification = { ...tag, results: { ...tag.results, api: `ghcr.io/x/univarse-api@${D.api ?? ''}` } };
    expect(() => imagesFrom(elsewhere)).toThrow(/not a reference into the local registry/);
  });

  it('[LS3] the deploy state keeps the running digests and the two before them (images:prune never removes them)', () => {
    const a = { UNIVARSE_API_IMAGE: `localhost:5000/univarse-api@${digest(1)}` };
    const b = { UNIVARSE_API_IMAGE: `localhost:5000/univarse-api@${digest(2)}` };
    const c = { UNIVARSE_API_IMAGE: `localhost:5000/univarse-api@${digest(3)}` };
    const d = { UNIVARSE_API_IMAGE: `localhost:5000/univarse-api@${digest(4)}` };
    const s3 = nextState(nextState(nextState(undefined, a), b), c);
    expect(s3.current).toEqual([{ repo: 'univarse-api', digest: digest(3) }]);
    expect(s3.rollback).toEqual([[{ repo: 'univarse-api', digest: digest(2) }], [{ repo: 'univarse-api', digest: digest(1) }]]);
    expect(nextState(s3, d).rollback.flat().map((p) => p.digest)).toEqual([digest(3), digest(2)]);
  });
});
