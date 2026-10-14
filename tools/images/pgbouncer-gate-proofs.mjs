// Spec 0017 PB10: the coverage regression controls, run against REAL images and a REAL Grype database (CI runs them
// like spec 0013's CS13 gate proofs). Each control must fail for its intended reason; the real build must pass.
//
//   node tools/images/pgbouncer-gate-proofs.mjs <image> <evidence-dir> [--cache <volume|dir>] [--only <id>[,<id>…]]
//
// The controls build two images of their own (an honest PgBouncer 1.25.0, and that binary relabelled 1.26.0), make
// edited inventories, and damage only their OWN copy of the database. Every resource a run creates is named for that
// run (a random run ID) and registered for removal BEFORE it is created; the run removes exactly what it owns, even when
// it fails part-way. Nothing here changes the gated image, the real inventory or the shared database cache.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { TRIVY_CACHE } from './gates.mjs';
import {
  GRYPE_IMAGE,
  READER_IMAGE,
  runGate,
  verifyInventoryWith,
} from './pgbouncer-grype-gate.mjs';
import {
  buildInventory,
  checkFacts,
  DOCKERFILE,
  dockerfilePins,
  gatherBase,
  gatherFacts,
} from './pgbouncer-inventory.mjs';
import { hostPath, REPO, TRIVY_IMAGE } from './release-lib.mjs';

/** The known-vulnerable control version, with the checksum upstream publishes for it (fetched 2026-10-14). */
export const VULNERABLE = Object.freeze({
  version: '1.25.0',
  sourceSha256: '290bad449e4580f0174d3677c26c1076d4ce5dd7ca116ae1fca10272ef74d10e',
  expectCve: 'CVE-2026-19888', // fixed in 1.26.0 (upstream changelog; Grype matches it on 1.25.0)
});
/** Every control, in order. A full run must produce exactly these results; `--only` may name only these. */
export const CONTROLS = Object.freeze([
  'clean-control',
  'known-vulnerable',
  'lying-metadata',
  'edited-inventory-no-pgbouncer',
  'edited-inventory-wrong-cpe',
  'edited-inventory-no-version',
  'warm-cache-unreachable-update',
  'stale-database',
  'corrupted-database',
]);
const PROOF_REPO = 'univarse-pgbouncer';

/** Validates a `--only` selection before any Docker work: every name must be a control, and at least one selected. */
export function selectControls(only) {
  if (only === null || only === undefined) return [...CONTROLS];
  const names = only.map((s) => s.trim()).filter(Boolean);
  if (names.length === 0) throw new Error('--only selected no controls');
  const unknown = names.filter((n) => !CONTROLS.includes(n));
  if (unknown.length)
    throw new Error(
      `--only names unknown control(s): ${unknown.join(', ')} (known: ${CONTROLS.join(', ')})`,
    );
  return CONTROLS.filter((c) => names.includes(c));
}

/**
 * The corruption control's intended reason, exactly: Grype's checksum validation rejected the database. Any other
 * failure (a killed process, a permission error, a network failure) is NOT this control's proof.
 */
export const isChecksumRejection = (problems) =>
  problems.some(
    (p) =>
      /^grype db status failed \(exit \d+\):.*\bbad db checksum\b/s.test(p) ||
      /^the database is not valid \(.*\bbad db checksum\b/s.test(p),
  );

function realDocker(args, { allowFail = false, input } = {}) {
  const r = spawnSync('docker', args, {
    encoding: 'utf8',
    maxBuffer: 1 << 28,
    input,
    env: { ...process.env, MSYS_NO_PATHCONV: '1' },
  });
  if (!allowFail && r.status !== 0)
    throw new Error(
      `docker ${args.slice(0, 3).join(' ')} … exited ${r.status}: ${(r.stderr ?? '').trim().slice(-400)}`,
    );
  return r;
}

/** The real dependencies; tests replace them. */
function realDeps() {
  const docker = realDocker;
  return {
    docker,
    runGate,
    verifyInventoryWith,
    /** An inventory for `image`, generated with `pins` (the controls' own builds have their own pins). */
    async inventoryFor(image, pins, file) {
      const id = docker(['image', 'inspect', '--format', '{{.Id}}', image]).stdout.trim();
      const facts = await gatherFacts(id);
      const problems = checkFacts(facts, await gatherBase(pins.runtimeImage), pins);
      if (problems.length === 0)
        writeFileSync(file, `${JSON.stringify(buildInventory(facts, pins), null, 2)}\n`);
      return { id, problems };
    },
    /** A Trivy report for `image`, from its saved archive (the Trivy database cache is reused, not updated). */
    trivyFor(image, work, name) {
      docker(['save', image, '-o', join(work, `${name}.tar`)]);
      docker([
        'run',
        '--rm',
        '-v',
        `${TRIVY_CACHE}:/root/.cache/trivy`,
        '-v',
        `${hostPath(work)}:/work`,
        TRIVY_IMAGE,
        'image',
        '--skip-db-update',
        '--no-progress',
        '--scanners',
        'vuln',
        '--format',
        'json',
        '--output',
        `/work/${name}.trivy.json`,
        '--input',
        `/work/${name}.tar`,
      ]);
      return join(work, `${name}.trivy.json`);
    },
    dbStatus(cache) {
      return JSON.parse(
        docker([
          'run',
          '--rm',
          '-v',
          `${cache}:/cache`,
          '-e',
          'GRYPE_DB_CACHE_DIR=/cache',
          '-e',
          'GRYPE_DB_AUTO_UPDATE=false',
          GRYPE_IMAGE,
          'db',
          'status',
          '-o',
          'json',
        ]).stdout,
      );
    },
    /** Runs Node, as root, in the cache volume (to copy, damage and remove the controls' own database copy). */
    inCache(cache, code) {
      return docker([
        'run',
        '--rm',
        '--user',
        '0:0',
        '--network',
        'none',
        '-v',
        `${cache}:/cache`,
        READER_IMAGE,
        '-e',
        code,
      ]);
    },
    runId: () => randomBytes(4).toString('hex'),
  };
}

export async function proveAll({
  image,
  evidenceDir,
  cache = 'uv-grype-cache',
  only = null,
  deps: overrides = {},
}) {
  const selected = selectControls(only); // before ANY Docker work
  const deps = { ...realDeps(), ...overrides };
  const { docker } = deps;
  const work = resolve(evidenceDir);
  mkdirSync(work, { recursive: true });
  const runId = deps.runId();
  if (!/^[0-9a-f]{8}$/.test(runId)) throw new Error(`invalid run ID ${runId}`);
  // Everything this run creates, registered BEFORE creation so a failure part-way still removes it.
  const owned = { tags: [], dbDirs: [] };
  const ownTag = (t) => {
    owned.tags.push(t);
    return t;
  };
  const ownDbDir = (d) => {
    owned.dbDirs.push(d);
    return d;
  };
  const results = [];
  try {
    const pins = dockerfilePins(readFileSync(join(REPO, DOCKERFILE), 'utf8'));
    const pins125 = { ...pins, version: VULNERABLE.version, sourceSha256: VULNERABLE.sourceSha256 };
    const wanted = (id) => selected.includes(id);
    const prove = async (id, intended, fn) => {
      if (!wanted(id)) return;
      let outcome;
      try {
        outcome = await fn();
      } catch (e) {
        outcome = { proved: false, detail: `the control itself errored: ${e.message}` };
      }
      results.push({ id, intended, ...outcome });
      console.log(
        `[gate-proofs] ${outcome.proved ? 'PROVED' : 'NOT PROVED'} ${id}: ${intended}${outcome.proved ? '' : ` (${outcome.detail})`}`,
      );
    };
    const gate = (name, opts) =>
      deps.runGate({ image, cache, evidenceDir: join(work, name), ...opts });
    const failedFor = (r, test) => ({
      proved:
        !r.ok &&
        (typeof test === 'function' ? test(r.problems) : r.problems.some((p) => test.test(p))),
      detail: r.ok ? 'it passed' : r.problems.join(' | ').slice(0, 400),
    });

    // The real build, its inventory and its Trivy report.
    const real = await deps.inventoryFor(image, pins, join(work, 'real.cdx.json'));
    if (real.problems.length)
      throw new Error(`the real image's inventory doesn't verify: ${real.problems.join('; ')}`);
    const realTrivy = deps.trivyFor(image, work, 'real');

    await prove('clean-control', 'the real build passes the gate', async () => {
      const r = await gate('clean', {
        inventoryPath: join(work, 'real.cdx.json'),
        trivyPath: realTrivy,
      });
      return { proved: r.ok, detail: r.problems.join(' | ') };
    });

    // An honest PgBouncer 1.25.0 build, verified against its own pins: Grype must block it on CVE-2026-19888.
    const oldTag = `${PROOF_REPO}:proof-${runId}-${VULNERABLE.version}`;
    const lyingTag = `${PROOF_REPO}:proof-${runId}-lying`;
    let old = null;
    let oldTrivy = null;
    let oldError = null;
    if (wanted('known-vulnerable') || wanted('lying-metadata')) {
      ownTag(oldTag); // registered before the build starts
      try {
        const created = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
        docker([
          'buildx',
          'build',
          '--load',
          '-f',
          DOCKERFILE,
          '-t',
          oldTag,
          '--build-arg',
          `PGBOUNCER_VERSION=${VULNERABLE.version}`,
          '--build-arg',
          `PGBOUNCER_SHA256=${VULNERABLE.sourceSha256}`,
          '--build-arg',
          'REVISION=proof',
          '--build-arg',
          `CREATED=${created}`,
          '--build-arg',
          'VERSION=proof',
          REPO,
        ]);
        old = await deps.inventoryFor(oldTag, pins125, join(work, 'old.cdx.json'));
        oldTrivy = deps.trivyFor(oldTag, work, 'old');
      } catch (e) {
        oldError = e; // both controls that need this build report it as not proved
      }
    }
    await prove(
      'known-vulnerable',
      `an honest PgBouncer ${VULNERABLE.version} build fails, with ${VULNERABLE.expectCve} blocking`,
      async () => {
        if (oldError) throw oldError;
        if (old.problems.length)
          return {
            proved: false,
            detail: `its inventory didn't verify: ${old.problems.join('; ')}`,
          };
        const r = await deps.runGate({
          image: oldTag,
          cache,
          evidenceDir: join(work, 'vulnerable'),
          inventoryPath: join(work, 'old.cdx.json'),
          trivyPath: oldTrivy,
          deps: { verifyInventory: deps.verifyInventoryWith(pins125) },
        });
        return failedFor(
          r,
          new RegExp(
            `^PgBouncer ${VULNERABLE.version.replace(/\./g, '\\.')}: ${VULNERABLE.expectCve} is (High|Critical) \\(blocking`,
          ),
        );
      },
    );

    // The same 1.25.0 binary relabelled 1.26.0, with the real pins: the tie check must refuse it, whatever Grype says.
    await prove(
      'lying-metadata',
      `a ${VULNERABLE.version} binary labelled ${pins.version} fails the tie check`,
      async () => {
        if (oldError) throw oldError;
        ownTag(lyingTag); // registered before the build starts
        docker(['build', '-t', lyingTag, '-'], {
          input: `FROM ${oldTag}\nLABEL org.univarse.pgbouncer.version="${pins.version}" org.univarse.pgbouncer.source-sha256="${pins.sourceSha256}"\n`,
        });
        const lying = await deps.inventoryFor(lyingTag, pins, join(work, 'lying.cdx.json'));
        const tie = lying.problems.some((p) =>
          p.includes(
            `the binary reports PgBouncer ${VULNERABLE.version}, but the image declares ${pins.version}`,
          ),
        );
        const r = await deps.runGate({
          image: lyingTag,
          cache,
          evidenceDir: join(work, 'lying'),
          inventoryPath: join(work, 'real.cdx.json'),
          trivyPath: realTrivy,
        });
        const gated = !r.ok && r.problems.some((p) => p.startsWith('inventory:'));
        return {
          proved: tie && gated,
          detail: `inventory: ${lying.problems.join('; ') || 'verified'}; gate: ${r.problems.join(' | ').slice(0, 300)}`,
        };
      },
    );

    // Edited inventories: refused by the verifier, and (with the verifier isolated) by the gate's own parity checks too.
    const edits = {
      'no-pgbouncer': (i) => ({
        ...i,
        components: i.components.filter((c) => c.name !== 'pgbouncer'),
      }),
      'wrong-cpe': (i) => ({
        ...i,
        components: i.components.map((c) =>
          c.name === 'pgbouncer'
            ? { ...c, cpe: c.cpe.replace('pgbouncer:pgbouncer', 'otherco:pgbouncer') }
            : c,
        ),
      }),
      'no-version': (i) => ({
        ...i,
        components: i.components.map((c) =>
          c.name === 'pgbouncer' ? (({ version: _version, ...rest }) => rest)(c) : c,
        ),
      }),
    };
    for (const [name, edit] of Object.entries(edits)) {
      await prove(
        `edited-inventory-${name}`,
        'an edited inventory fails verification, and parity with the verifier isolated',
        async () => {
          const inv = JSON.parse(readFileSync(join(work, 'real.cdx.json'), 'utf8'));
          writeFileSync(join(work, `${name}.cdx.json`), JSON.stringify(edit(inv), null, 2));
          const verified = await gate(`edit-${name}`, {
            inventoryPath: join(work, `${name}.cdx.json`),
            trivyPath: realTrivy,
          });
          const isolated = await gate(`edit-${name}-isolated`, {
            inventoryPath: join(work, `${name}.cdx.json`),
            trivyPath: realTrivy,
            deps: { verifyInventory: async () => [] },
          });
          const v = !verified.ok && verified.problems.some((p) => p.startsWith('inventory:'));
          const p = !isolated.ok && isolated.problems.some((x) => /PgBouncer/.test(x));
          return {
            proved: v && p,
            detail: `verifier: ${verified.problems.join(' | ').slice(0, 200)}; parity: ${isolated.problems.join(' | ').slice(0, 200)}`,
          };
        },
      );
    }

    // Database: a warm, valid cache must not mask a failed update check.
    await prove(
      'warm-cache-unreachable-update',
      'with a valid cache present, an unreachable update URL fails the gate at the update',
      async () => {
        const warm = deps.dbStatus(cache)?.valid === true;
        const r = await gate('unreachable', {
          inventoryPath: join(work, 'real.cdx.json'),
          trivyPath: realTrivy,
          extraEnv: { GRYPE_DB_UPDATE_URL: 'http://127.0.0.1:9/databases' },
        });
        const stopped = r.problems.some((p) => /^grype db update failed/.test(p));
        return {
          proved: warm && !r.ok && stopped,
          detail: `warm cache valid: ${warm}; gate: ${r.problems.join(' | ').slice(0, 300)}`,
        };
      },
    );

    await prove('stale-database', 'a database older than 48 h fails the status check', async () => {
      const st = deps.dbStatus(cache);
      const r = await gate('stale', {
        inventoryPath: join(work, 'real.cdx.json'),
        trivyPath: realTrivy,
        now: Date.parse(st.built) + 49 * 3_600_000,
      });
      return failedFor(r, /more than 48 h ago/);
    });

    // A corrupted database: the run's OWN copy of the cache's database, its recorded digest damaged after a successful
    // update. Only Grype's checksum rejection proves it.
    await prove(
      'corrupted-database',
      'a database that fails hash validation fails the gate, with a checksum rejection',
      async () => {
        const dir = ownDbDir(`proof-corrupt-${runId}`); // registered before the copy starts
        deps.inCache(cache, `require('fs').cpSync('/cache/6','/cache/${dir}/6',{recursive:true})`);
        const r = await gate('corrupt', {
          inventoryPath: join(work, 'real.cdx.json'),
          trivyPath: realTrivy,
          dbSubdir: dir,
          deps: {
            afterUpdate: async () =>
              deps.inCache(
                cache,
                `const fs=require('fs');const p='/cache/${dir}/6/import.json';const j=JSON.parse(fs.readFileSync(p));j.digest='xxh64:0000000000000000';fs.writeFileSync(p,JSON.stringify(j))`,
              ),
          },
        });
        return failedFor(r, isChecksumRejection);
      },
    );
  } finally {
    // Exactly what this run owns, whatever happened: its database copies, then its images.
    for (const d of owned.dbDirs) {
      try {
        deps.inCache(cache, `require('fs').rmSync('/cache/${d}',{recursive:true,force:true})`);
      } catch (e) {
        console.error(`[gate-proofs] couldn't remove the database copy /cache/${d}: ${e.message}`);
      }
    }
    for (const t of owned.tags) docker(['rmi', t], { allowFail: true });
  }
  // A full run must produce every expected control; a selection, exactly its selection. All must be proved. The
  // evidence file records the verdict itself: `ok` (exactly the selected controls, in order, each proved) and
  // `fullRun` (the selection is all nine), so PB10's evidence is `ok && fullRun` without re-deriving it.
  const verdict = proofVerdict(selected, results);
  writeFileSync(
    join(work, 'gate-proofs.json'),
    `${JSON.stringify({ image, runId, ...verdict, selected, results }, null, 2)}\n`,
  );
  const ids = results.map((r) => r.id);
  console.log(
    `[gate-proofs] ${verdict.proved}/${selected.length} proved${verdict.complete ? '' : ` (expected results for: ${selected.join(', ')}; got: ${ids.join(', ') || 'none'})`}${verdict.fullRun ? '' : ' (a partial run: not PB10 evidence on its own)'}`,
  );
  return { ok: verdict.ok, results, owned };
}

/**
 * The run's verdict: `complete` when the results are exactly the selected controls, in order (none missing, extra or
 * repeated); `ok` when complete and every result is proved (strictly `true`); `fullRun` when the selection is exactly
 * the nine expected controls.
 */
export function proofVerdict(selected, results) {
  const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
  const complete = same(
    results.map((r) => r.id),
    selected,
  );
  const proved = results.filter((r) => r.proved === true).length;
  return {
    ok: complete && proved === selected.length,
    fullRun: same(selected, CONTROLS),
    complete,
    proved,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const take = (n) => {
    const i = args.indexOf(`--${n}`);
    return i >= 0 ? args.splice(i, 2)[1] : undefined;
  };
  const cache = take('cache') ?? 'uv-grype-cache';
  const onlyArg = take('only');
  const only = onlyArg === undefined ? null : onlyArg.split(','); // rerun named controls (e.g. after a network failure)
  const [image, evidenceDir] = args;
  if (!image || !evidenceDir) {
    console.error(
      'usage: pgbouncer-gate-proofs.mjs <image> <evidence-dir> [--cache <volume|dir>] [--only <id>[,<id>…]]',
    );
    process.exit(2);
  }
  const { ok } = await proveAll({ image, evidenceDir, cache, only });
  process.exit(ok ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(`[gate-proofs] ERROR: ${e.message}`);
    process.exit(1);
  });
}
