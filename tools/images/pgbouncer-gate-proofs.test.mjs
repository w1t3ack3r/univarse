// Spec 0017 PB10: the coverage-controls harness, with Docker, the gate, inventories and Trivy mocked, so its own logic
// (what counts as proved, what it cleans up, what it accepts) is tested in seconds, without the real 45-minute scans.
// Run: node --test tools/images/pgbouncer-gate-proofs.test.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DOCKERFILE, dockerfilePins, pgbouncerCpe } from './pgbouncer-inventory.mjs';
import { REPO } from './release-lib.mjs';
import {
  CONTROLS,
  isChecksumRejection,
  proofVerdict,
  proveAll,
  selectControls,
  VULNERABLE,
} from './pgbouncer-gate-proofs.mjs';

// The harness labels its lying image with the real pin, so the mocked world takes the same pin.
const PINNED = dockerfilePins(readFileSync(join(REPO, DOCKERFILE), 'utf8')).version;
const RUN = 'deadbeef';
const OLD_TAG = `univarse-pgbouncer:proof-${RUN}-${VULNERABLE.version}`;
const LYING_TAG = `univarse-pgbouncer:proof-${RUN}-lying`;
const DB_DIR = `proof-corrupt-${RUN}`;
const CHECKSUM =
  'grype db status failed (exit 1): [0033] ERROR bad db checksum (/cache/x/6/vulnerability.db): "xxh64:0000000000000000" vs "xxh64:752abfb9c5b8e818"';

/** A mocked world in which every control behaves as it should, unless `over` says otherwise. */
function mocks(over = {}) {
  const calls = { docker: [], inCache: [] };
  const inventory = {
    components: [
      {
        name: 'pgbouncer',
        version: PINNED,
        cpe: pgbouncerCpe(PINNED),
      },
    ],
  };
  const deps = {
    runId: () => RUN,
    docker: (args, opts = {}) => {
      calls.docker.push(args);
      const fail = over.docker?.(args);
      if (fail && !opts.allowFail) throw new Error(fail);
      return { status: fail ? 1 : 0, stdout: '', stderr: fail ?? '' };
    },
    inventoryFor: async (image, _pins, file) => {
      if (over.inventoryFor) return over.inventoryFor(image, file);
      writeFileSync(file, JSON.stringify(inventory));
      return {
        problems:
          image === LYING_TAG
            ? [
                `the binary reports PgBouncer ${VULNERABLE.version}, but the image declares ${PINNED}`,
              ]
            : [],
      };
    },
    trivyFor: (image, work, name) => {
      if (over.trivyFor) over.trivyFor(image);
      writeFileSync(join(work, `${name}.trivy.json`), '{}');
      return join(work, `${name}.trivy.json`);
    },
    dbStatus: () => ({ valid: true, built: '2026-10-14T06:00:00Z' }),
    inCache: (_cache, code) => {
      calls.inCache.push(code);
      if (over.inCache) over.inCache(code);
    },
    verifyInventoryWith: () => async () => [],
    runGate: async (opts) => {
      const r = over.runGate?.(opts);
      if (r) return r;
      const fail = (p) => ({ ok: false, problems: [p] });
      if (opts.image === OLD_TAG)
        return fail(
          `PgBouncer ${VULNERABLE.version}: ${VULNERABLE.expectCve} is High (blocking under the declared policy)`,
        );
      if (opts.image === LYING_TAG)
        return fail(
          `inventory: the binary reports PgBouncer 1.25.0, but the image declares ${PINNED}`,
        );
      if (/edit-.*-isolated$/.test(opts.evidenceDir))
        return fail('the inventory has 0 PgBouncer components, expected 1');
      if (/edit-/.test(opts.evidenceDir))
        return fail("inventory: the inventory differs from what the image's own facts produce");
      if (opts.extraEnv?.GRYPE_DB_UPDATE_URL)
        return fail('grype db update failed (exit 1): unreachable');
      if (opts.now) return fail('the database was built 2026-10-14T06:00:00Z, more than 48 h ago');
      if (opts.dbSubdir) {
        await opts.deps.afterUpdate();
        return fail(over.corruptProblem ?? CHECKSUM);
      }
      return { ok: true, problems: [] };
    },
  };
  return { deps, calls };
}

async function run(over = {}, only = null) {
  const work = mkdtempSync(join(tmpdir(), 'uv-proofs-'));
  const m = mocks(over);
  try {
    const out = await proveAll({
      image: 'univarse-pgbouncer:ci',
      evidenceDir: work,
      cache: 'uv-grype-cache',
      only,
      deps: m.deps,
    });
    const file = JSON.parse(readFileSync(join(work, 'gate-proofs.json'), 'utf8'));
    return { ...out, file, calls: m.calls };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
const rmis = (calls) => calls.docker.filter((a) => a[0] === 'rmi').map((a) => a[1]);
const removedDirs = (calls) =>
  calls.inCache.filter((c) => c.includes('rmSync')).map((c) => /\/cache\/([^']+)'/.exec(c)?.[1]);
const result = (r, id) => r.results.find((x) => x.id === id);

test('[PB10] proofs: a full mocked run proves all nine controls, in order, and removes exactly what it owns', async () => {
  const r = await run();
  assert.equal(r.ok, true);
  assert.deepEqual(
    r.results.map((x) => x.id),
    [...CONTROLS],
  );
  assert.ok(r.results.every((x) => x.proved));
  assert.deepEqual(rmis(r.calls), [OLD_TAG, LYING_TAG]); // the run's own tags, nothing shared
  assert.deepEqual(removedDirs(r.calls), [DB_DIR]);
});

test("[PB10] proofs: only Grype's checksum rejection proves corruption, not a kill or a permission error (owner's probe)", async () => {
  for (const problem of [
    'grype db status failed (exit 137): killed',
    'grype db status failed (exit 1): open /cache/x/6/vulnerability.db: permission denied',
    'grype db update failed (exit 1): lookup grype.anchore.io: no such host',
  ]) {
    const r = await run({ corruptProblem: problem });
    assert.equal(result(r, 'corrupted-database').proved, false, problem);
    assert.equal(r.ok, false);
  }
  assert.equal(isChecksumRejection([CHECKSUM]), true);
  assert.equal(
    isChecksumRejection([
      'the database is not valid (valid: false, error: bad db checksum (x): "a" vs "b")',
    ]),
    true,
  );
  assert.equal(isChecksumRejection(['grype db status failed (exit 137): killed']), false);
  assert.equal(isChecksumRejection(['something else mentioning bad db checksum']), false); // anchored to the status check
});

test('[PB10] proofs: a failed build is cleaned up, and both controls needing it are reported not proved', async () => {
  const r = await run({
    docker: (args) => (args[0] === 'buildx' ? 'build failed: network' : null),
  });
  assert.equal(r.ok, false);
  for (const id of ['known-vulnerable', 'lying-metadata']) {
    assert.equal(result(r, id).proved, false);
    assert.match(result(r, id).detail, /build failed: network/);
  }
  assert.deepEqual(rmis(r.calls), [OLD_TAG]); // registered before the build; the lying image was never created
  assert.equal(r.results.length, CONTROLS.length); // the other controls still ran
});

test('[PB10] proofs: a setup failure after the build still removes the built image', async () => {
  const r = await run({
    trivyFor: (image) => {
      if (image === OLD_TAG) throw new Error('trivy failed');
    },
  });
  assert.equal(result(r, 'known-vulnerable').proved, false);
  assert.deepEqual(rmis(r.calls), [OLD_TAG]);
});

test('[PB10] proofs: a partial database copy is removed, and the corruption control is not proved', async () => {
  const r = await run({
    inCache: (code) => {
      if (code.includes('cpSync')) throw new Error('no space left on device');
    },
  });
  assert.equal(result(r, 'corrupted-database').proved, false);
  assert.match(result(r, 'corrupted-database').detail, /no space left/);
  assert.deepEqual(removedDirs(r.calls), [DB_DIR]); // registered before the copy started
});

test('[PB10] proofs: an isolated corruption run builds nothing and removes only its own database copy', async () => {
  const r = await run({}, ['corrupted-database']);
  assert.equal(r.ok, true);
  assert.deepEqual(
    r.results.map((x) => x.id),
    ['corrupted-database'],
  );
  assert.deepEqual(rmis(r.calls), []); // it created no images, so it removes none
  assert.ok(!r.calls.docker.some((a) => a[0] === 'buildx' || a[0] === 'build'));
  assert.deepEqual(removedDirs(r.calls), [DB_DIR]);
});

test("[PB10] proofs: --only is validated before any Docker work: unknown or empty selections are refused (owner's probe)", async () => {
  for (const only of [['corupted-database'], [], [' '], ['corrupted-database', 'nope']]) {
    const m = mocks();
    await assert.rejects(
      proveAll({ image: 'x', evidenceDir: join(tmpdir(), 'uv-never-created'), only, deps: m.deps }),
      /--only (names unknown control|selected no controls)/,
    );
    assert.equal(m.calls.docker.length, 0);
    assert.equal(m.calls.inCache.length, 0);
  }
  assert.deepEqual(selectControls(null), [...CONTROLS]);
  assert.deepEqual(selectControls(['stale-database', 'clean-control']), [
    'clean-control',
    'stale-database',
  ]); // run order
});

test('[PB10] proofs: a full run is ok only with all nine results proved; one failure fails the run', async () => {
  const r = await run({
    runGate: (opts) =>
      opts.evidenceDir.endsWith('clean') ? { ok: false, problems: ['something'] } : null,
  });
  assert.equal(r.results.length, CONTROLS.length);
  assert.equal(result(r, 'clean-control').proved, false);
  assert.equal(r.ok, false);
  const errored = await run({
    runGate: (opts) => {
      if (opts.evidenceDir.endsWith('stale')) throw new Error('boom');
      return null;
    },
  });
  assert.equal(result(errored, 'stale-database').proved, false);
  assert.match(result(errored, 'stale-database').detail, /the control itself errored: boom/);
  assert.equal(errored.ok, false);
});

test("[PB10] proofs: the evidence file carries the verdict: ok only for exactly the expected controls, each proved (owner's review of ea610ba)", async () => {
  const full = await run();
  assert.deepEqual(
    [full.file.ok, full.file.fullRun, full.file.complete, full.file.proved],
    [true, true, true, 9],
  );
  const one = await run({
    runGate: (o) => (o.evidenceDir.endsWith('stale') ? { ok: false, problems: [] } : null),
  });
  assert.deepEqual([one.file.ok, one.file.fullRun, one.file.proved], [false, true, 8]);
  const partial = await run({}, ['corrupted-database']);
  assert.deepEqual([partial.file.ok, partial.file.fullRun], [true, false]); // proved, but not PB10 evidence alone

  const all = CONTROLS.map((id) => ({ id, proved: true }));
  const swap = (i, change) => all.map((r, j) => (j === i ? { ...r, ...change } : r));
  assert.equal(proofVerdict([...CONTROLS], all).ok, true);
  assert.equal(proofVerdict([...CONTROLS], all.slice(1)).ok, false); // one missing
  assert.equal(proofVerdict([...CONTROLS], [...all, all[0]]).ok, false); // one repeated
  assert.equal(proofVerdict([...CONTROLS], [all[1], all[0], ...all.slice(2)]).ok, false); // out of order
  assert.equal(proofVerdict([...CONTROLS], swap(0, { id: 'other' })).ok, false); // a stranger
  assert.equal(proofVerdict([...CONTROLS], swap(0, { proved: 'yes' })).ok, false); // not strictly true
  assert.equal(proofVerdict([], []).fullRun, false);
});
