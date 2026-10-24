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
    prepare: (withVault) => (calls.push(`prepare:${String(withVault)}`), []),
    markApplied: (services) => void calls.push(services ? `markApplied:${services.join(',')}` : 'markApplied'),
    scanThirdParty: () => (calls.push('scan'), []),
    compose: (args) => (calls.push(`compose:${args.join(' ')}`), { status: 0 }),
    vaultState: () => (calls.push('vaultState'), vault),
    vaultStorage: () => (calls.push('vaultStorage'), 'raft'),
    ensureVault: () => void calls.push('ensureVault'),
    buckets: () => (calls.push('buckets'), []),
    recover: (_images, { initLedger }) => (calls.push(`recover${initLedger ? ':init' : ''}`), Promise.resolve({ ok: true, lines: [] })),
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
      'vaultStorage',
      'compose:up -d --wait vault',
      'vaultState',
      'ensureVault',
      'prepare:true',
      'compose:up -d --wait postgres',
      'compose:--profile job run --rm migrate',
      'compose:up -d --wait seaweedfs',
      'buckets',
      'compose:up -d --wait pgbouncer valkey',
      'recover',
      `compose:up -d --wait --remove-orphans ${SERVICES.join(' ')}`,
      'markApplied',
      'smoke',
      'saveState',
    ]);
    expect(calls.at(-1)).toBe('registry-stop');
  });

  it('[LS5] a changed certificate or configuration restarts exactly the services that read it: PostgreSQL before the migrate job, the rest once the stack is up', async () => {
    const d = deps({ prepare: (withVault) => (calls.push(`prepare:${String(withVault)}`), withVault ? ['pgbouncer', 'caddy'] : ['postgres']) });
    expect((await deploy(record(), COMMIT, d)).ok).toBe(true);
    const e = effects();
    const at = (c: string) => e.indexOf(c);
    expect(at('compose:restart postgres')).toBe(at('compose:up -d --wait postgres') + 1);
    expect(at('compose:restart postgres')).toBeLessThan(at('compose:--profile job run --rm migrate'));
    // Spec 0020 A2-11: PgBouncer carries the keys job's connections, so it restarts before the ledger's recovery.
    expect(e.slice(at('compose:up -d --wait pgbouncer valkey'), at('recover') + 1)).toEqual([
      'compose:up -d --wait pgbouncer valkey',
      'compose:restart pgbouncer',
      'compose:up -d --wait pgbouncer',
      'markApplied:pgbouncer',
      'recover',
    ]);
    const up = at(`compose:up -d --wait --remove-orphans ${SERVICES.join(' ')}`);
    expect(e.slice(up + 1, up + 3)).toEqual(['compose:restart caddy', `compose:up -d --wait ${SERVICES.join(' ')}`]);
    expect(at('compose:restart caddy')).toBeLessThan(at('smoke'));
    // Recorded as loaded only after the restarts succeeded.
    expect(at('markApplied')).toBe(up + 3);
  });

  it('[D8][BK2] a recovery that stops fails the deploy before the API, worker and web start, and saves no state', async () => {
    const r = await deploy(record(), COMMIT, deps({ recover: () => (calls.push('recover'), Promise.resolve({ ok: false, lines: ['STOP: x'] })) }));
    expect(r.ok).toBe(false);
    expect(r.problems.join()).toMatch(/recovery stopped the deploy before the API and worker started/);
    expect(calls.some((c) => c.includes('--remove-orphans'))).toBe(false);
    expect(calls).not.toContain('saveState');
    expect(calls.indexOf('recover')).toBeGreaterThan(calls.indexOf('compose:--profile job run --rm migrate'));
  });

  it('[A2-3] the ledger is initialised only when the owner asks (--init-ledger), never by itself', async () => {
    await deploy(record(), COMMIT, deps());
    expect(calls).toContain('recover');
    calls = [];
    await deploy(record(), COMMIT, deps(), { initLedger: true });
    expect(calls).toContain('recover:init');
  });

  it('[LS8] a changed Vault certificate restarts Vault at once, records it, and stops for the owner to unseal', async () => {
    let restarted = false;
    const d = deps({
      prepare: (withVault) => (calls.push(`prepare:${String(withVault)}`), withVault ? [] : ['vault']),
      compose: (args) => (calls.push(`compose:${args.join(' ')}`), args[0] === 'restart' && (restarted = true), { status: 0 }),
      vaultState: () => (calls.push('vaultState'), restarted ? 'sealed' : 'ready'),
    });
    const r = await deploy(record(), COMMIT, d);
    expect(r.problems.join()).toMatch(/pnpm stack:vault unseal/);
    const e = effects();
    const at = (c: string) => e.indexOf(c);
    expect(e.slice(at('compose:up -d --wait vault'), at('compose:up -d --wait vault') + 5)).toEqual([
      'compose:up -d --wait vault',
      'compose:restart vault',
      'compose:up -d --wait vault',
      'markApplied:vault',
      'vaultState',
    ]);
    expect(calls.some((c) => c.includes('postgres'))).toBe(false);
  });

  it('[A2-10] changed SeaweedFS identities (s3.json) restart SeaweedFS at once: before the buckets and the ledger\'s recovery, and not again at the end', async () => {
    const d = deps({ prepare: (withVault) => (calls.push(`prepare:${String(withVault)}`), ['seaweedfs']) });
    expect((await deploy(record(), COMMIT, d)).ok).toBe(true);
    const e = effects();
    const at = (c: string) => e.indexOf(c);
    expect(e.slice(at('compose:up -d --wait seaweedfs'), at('buckets') + 1)).toEqual([
      'compose:up -d --wait seaweedfs',
      'compose:restart seaweedfs',
      'compose:up -d --wait seaweedfs',
      'markApplied:seaweedfs',
      'buckets',
    ]);
    expect(at('buckets')).toBeLessThan(at('recover'));
    expect(e.filter((c) => c.startsWith('compose:restart'))).toEqual(['compose:restart seaweedfs']);
  });

  it('[A2-10] SeaweedFS\'s identities unchanged: no early restart (another service\'s change restarts only that one, at the end)', async () => {
    const d = deps({ prepare: (withVault) => (calls.push(`prepare:${String(withVault)}`), withVault ? ['caddy'] : []) });
    expect((await deploy(record(), COMMIT, d)).ok).toBe(true);
    const e = effects();
    expect(e[e.indexOf('compose:up -d --wait seaweedfs') + 1]).toBe('buckets');
    expect(e.filter((c) => c.startsWith('compose:restart'))).toEqual(['compose:restart caddy']);
    expect(calls).not.toContain('markApplied:seaweedfs');
  });

  it('[A2-10] SeaweedFS failing to come back from its restart stops the deploy before the buckets and recovery', async () => {
    const d = deps({
      prepare: (withVault) => (calls.push(`prepare:${String(withVault)}`), ['seaweedfs']),
      compose: (args) => (calls.push(`compose:${args.join(' ')}`), { status: args.join(' ') === 'restart seaweedfs' ? 1 : 0 }),
    });
    expect(await deploy(record(), COMMIT, d)).toEqual({ ok: false, problems: ['SeaweedFS did not restart'] });
    expect(calls).not.toContain('buckets');
    expect(calls).not.toContain('recover');
    expect(calls).not.toContain('markApplied:seaweedfs');
  });

  it('[LS5] nothing changed: nothing restarts', async () => {
    await deploy(record(), COMMIT, deps());
    expect(calls.some((c) => c.startsWith('compose:restart'))).toBe(false);
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
    expect(effects().slice(4, 7)).toEqual(['vaultState', 'ensureVault', 'prepare:true']);
  });

  for (const [state, reason] of [
    ['unmigrated', /pnpm stack:vault migrate-raft <this record>.*once/],
    ['unverified', /started but never verified/],
  ] as const)
    it(`[B-4] Vault's storage ${state}: refused before Vault starts, naming the migration; nothing initialised, migrated or started`, async () => {
      const r = await deploy(record(), COMMIT, deps({ vaultStorage: () => (calls.push('vaultStorage'), state) }));
      expect(r.ok).toBe(false);
      expect(r.problems.join()).toMatch(reason);
      expect(effects()).toEqual(['prepare:false', 'scan', 'vaultStorage']);
    });

  it('[B-4] a fresh stack (no Vault data anywhere) proceeds, and Vault is initialised on Raft', async () => {
    await deploy(record(), COMMIT, deps({ vaultStorage: () => (calls.push('vaultStorage'), 'fresh') }, SIGNED, 'uninitialised'));
    expect(calls).toContain('ensureVault');
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
