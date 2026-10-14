// Spec 0017 PB10: the coverage regression controls, run against REAL images and a REAL Grype database (CI runs them
// like spec 0013's CS13 gate proofs). Each control must fail for its intended reason; the real build must pass.
//
//   node tools/images/pgbouncer-gate-proofs.mjs <image> <evidence-dir> [--cache <volume|dir>]
//
// The controls build two images of their own (an honest PgBouncer 1.25.0, and that binary relabelled 1.26.0), make
// edited inventories, and damage only their OWN copy of the database. Nothing here changes the gated image, the real
// inventory or the shared database cache.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
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
import { TRIVY_CACHE } from './gates.mjs';

/** The known-vulnerable control version, with the checksum upstream publishes for it (fetched 2026-10-14). */
export const VULNERABLE = Object.freeze({
  version: '1.25.0',
  sourceSha256: '290bad449e4580f0174d3677c26c1076d4ce5dd7ca116ae1fca10272ef74d10e',
  expectCve: 'CVE-2026-19888', // fixed in 1.26.0 (upstream changelog; Grype matches it on 1.25.0)
});
const PROOF_TAG = 'univarse-pgbouncer:proof';

function docker(args, { allowFail = false, input } = {}) {
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

/** An inventory for `image`, generated with `pins` (the controls' own builds have their own pins). */
async function inventoryFor(image, pins, file) {
  const id = docker(['image', 'inspect', '--format', '{{.Id}}', image]).stdout.trim();
  const facts = await gatherFacts(id);
  const problems = checkFacts(facts, await gatherBase(pins.runtimeImage), pins);
  if (problems.length === 0)
    writeFileSync(file, `${JSON.stringify(buildInventory(facts, pins), null, 2)}\n`);
  return { id, problems };
}

/** A Trivy report for `image`, from its saved archive (the Trivy database cache is reused, not updated). */
function trivyFor(image, work, name) {
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
}

export async function proveAll({ image, evidenceDir, cache = 'uv-grype-cache', only = null }) {
  const wanted = (id) => !only || only.some((o) => id === o || id.startsWith(`${o}-`));
  const work = resolve(evidenceDir);
  mkdirSync(work, { recursive: true });
  const pins = dockerfilePins(readFileSync(join(REPO, DOCKERFILE), 'utf8'));
  const pins125 = { ...pins, version: VULNERABLE.version, sourceSha256: VULNERABLE.sourceSha256 };
  const results = [];
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
  const gate = (name, opts) => runGate({ image, cache, evidenceDir: join(work, name), ...opts });
  const failedFor = (r, re) => ({
    proved: !r.ok && r.problems.some((p) => re.test(p)),
    detail: r.ok ? 'it passed' : r.problems.join(' | ').slice(0, 400),
  });

  // The real build, its inventory and its Trivy report.
  const real = await inventoryFor(image, pins, join(work, 'real.cdx.json'));
  if (real.problems.length)
    throw new Error(`the real image's inventory doesn't verify: ${real.problems.join('; ')}`);
  const realTrivy = trivyFor(image, work, 'real');

  await prove('clean-control', 'the real build passes the gate', async () => {
    const r = await gate('clean', {
      inventoryPath: join(work, 'real.cdx.json'),
      trivyPath: realTrivy,
    });
    return { proved: r.ok, detail: r.problems.join(' | ') };
  });

  // An honest PgBouncer 1.25.0 build, verified against its own pins: Grype must block it on CVE-2026-19888.
  const needOld = wanted('known-vulnerable') || wanted('lying-metadata');
  const created = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  if (needOld)
    docker([
      'buildx',
      'build',
      '--load',
      '-f',
      DOCKERFILE,
      '-t',
      `${PROOF_TAG}-1.25.0`,
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
  const old = needOld
    ? await inventoryFor(`${PROOF_TAG}-1.25.0`, pins125, join(work, 'old.cdx.json'))
    : null;
  const oldTrivy = needOld ? trivyFor(`${PROOF_TAG}-1.25.0`, work, 'old') : null;
  await prove(
    'known-vulnerable',
    `an honest PgBouncer ${VULNERABLE.version} build fails, with ${VULNERABLE.expectCve} blocking`,
    async () => {
      if (old.problems.length)
        return { proved: false, detail: `its inventory didn't verify: ${old.problems.join('; ')}` };
      const r = await runGate({
        image: `${PROOF_TAG}-1.25.0`,
        cache,
        evidenceDir: join(work, 'vulnerable'),
        inventoryPath: join(work, 'old.cdx.json'),
        trivyPath: oldTrivy,
        deps: { verifyInventory: verifyInventoryWith(pins125) },
      });
      return failedFor(
        r,
        new RegExp(
          `PgBouncer ${VULNERABLE.version.replace(/\./g, '\\.')}: ${VULNERABLE.expectCve} is (High|Critical) \\(blocking`,
        ),
      );
    },
  );

  // The same 1.25.0 binary relabelled 1.26.0, with the real pins: the tie check must refuse it, whatever Grype says.
  if (wanted('lying-metadata'))
    docker(['build', '-t', `${PROOF_TAG}-lying`, '-'], {
      input: `FROM ${PROOF_TAG}-1.25.0\nLABEL org.univarse.pgbouncer.version="${pins.version}" org.univarse.pgbouncer.source-sha256="${pins.sourceSha256}"\n`,
    });
  await prove(
    'lying-metadata',
    `a ${VULNERABLE.version} binary labelled ${pins.version} fails the tie check`,
    async () => {
      const lying = await inventoryFor(`${PROOF_TAG}-lying`, pins, join(work, 'lying.cdx.json'));
      const tie = lying.problems.some((p) =>
        p.includes(
          `the binary reports PgBouncer ${VULNERABLE.version}, but the image declares ${pins.version}`,
        ),
      );
      const r = await runGate({
        image: `${PROOF_TAG}-lying`,
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
  const inv = JSON.parse(readFileSync(join(work, 'real.cdx.json'), 'utf8'));
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
        c.name === 'pgbouncer' ? (({ version, ...rest }) => rest)(c) : c,
      ),
    }),
  };
  for (const [name, edit] of Object.entries(edits)) {
    writeFileSync(join(work, `${name}.cdx.json`), JSON.stringify(edit(inv), null, 2));
    await prove(
      `edited-inventory-${name}`,
      'an edited inventory fails verification, and parity with the verifier isolated',
      async () => {
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
      const st = docker(
        [
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
        ],
        { allowFail: true },
      );
      const warm = st.status === 0 && JSON.parse(st.stdout).valid === true;
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
    const st = JSON.parse(
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
    const r = await gate('stale', {
      inventoryPath: join(work, 'real.cdx.json'),
      trivyPath: realTrivy,
      now: Date.parse(st.built) + 49 * 3_600_000,
    });
    return failedFor(r, /more than 48 h ago/);
  });

  // A corrupted database: a COPY of the cache's database, whose recorded digest is damaged after a successful update.
  await prove(
    'corrupted-database',
    'a database that fails hash validation fails the gate',
    async () => {
      const node = (code) =>
        docker([
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
      node(
        "const fs=require('fs');fs.rmSync('/cache/proof-corrupt',{recursive:true,force:true});fs.cpSync('/cache/6','/cache/proof-corrupt/6',{recursive:true})",
      );
      try {
        const r = await gate('corrupt', {
          inventoryPath: join(work, 'real.cdx.json'),
          trivyPath: realTrivy,
          dbSubdir: 'proof-corrupt',
          deps: {
            afterUpdate: async () =>
              node(
                "const fs=require('fs');const p='/cache/proof-corrupt/6/import.json';const j=JSON.parse(fs.readFileSync(p));j.digest='xxh64:0000000000000000';fs.writeFileSync(p,JSON.stringify(j))",
              ),
          },
        });
        return failedFor(r, /grype db status failed|not valid/);
      } finally {
        node("require('fs').rmSync('/cache/proof-corrupt',{recursive:true,force:true})");
      }
    },
  );

  for (const tag of [`${PROOF_TAG}-1.25.0`, `${PROOF_TAG}-lying`])
    docker(['rmi', tag], { allowFail: true });
  const proved = results.filter((r) => r.proved).length;
  writeFileSync(join(work, 'gate-proofs.json'), `${JSON.stringify({ image, results }, null, 2)}\n`);
  console.log(`[gate-proofs] ${proved}/${results.length} proved`);
  return { ok: proved === results.length, results };
}

async function main() {
  const args = process.argv.slice(2);
  const i = args.indexOf('--cache');
  const cache = i >= 0 ? args.splice(i, 2)[1] : 'uv-grype-cache';
  const o = args.indexOf('--only');
  const only = o >= 0 ? args.splice(o, 2)[1].split(',') : null; // rerun named controls (e.g. after a network failure)
  const [image, evidenceDir] = args;
  if (!image || !evidenceDir) {
    console.error('usage: pgbouncer-gate-proofs.mjs <image> <evidence-dir> [--cache <volume|dir>]');
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
