// Spec 0013 LR8 regression tests for the prune plan, against a synthetic registry laid out the way cosign 3
// stores signatures here (an index tagged `sha256-<hex>` listing the signature and attestation manifests), with
// `trust` standing in for cosign's verdict against the trusted key. Pure: no registry, no Docker.
// Run with `node --test tools/images/prune.test.mjs`.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  classify,
  fallbackTag,
  keptCommits,
  nominations,
  planPrune,
  verificationTargets,
} from './prune.mjs';

const dg = (n) => `sha256:${String(n).padStart(64, '0')}`;
const commit = (c) => c.repeat(40).slice(0, 40);
let next = 1000;

function registry() {
  const repos = {};
  const repo = (r) => (repos[r] ??= { tags: {}, indexes: {} });
  return {
    snapshot: { repos },
    push(r, tag, digest) {
      repo(r).tags[tag] = digest;
    },
    /** Signature + SBOM + provenance: n referrer manifests listed in the fallback index. Returns [index, ...]. */
    sign(r, digest, n = 3) {
      const children = Array.from({ length: n }, () => dg(next++));
      const idx = dg(next++);
      repo(r).tags[fallbackTag(digest)] = idx;
      repo(r).indexes[idx] = children;
      return [idx, ...children];
    },
  };
}

/** A record as release.mjs writes it, and the registry state it pushed (both images signed). */
function release(reg, trust, c, { rehearsal = false, at, api, web, trustKind } = {}) {
  const tag = `sha-${c.slice(0, 7)}${rehearsal ? '-rehearsal' : ''}`;
  const record = {
    file: `${c.slice(0, 7)}${rehearsal ? '-rehearsal' : ''}.json`,
    rehearsal,
    startedAt: at,
    commit: c,
    images: {
      api: { repo: 'univarse-api', tag, digest: api },
      web: { repo: 'univarse-web', tag, digest: web },
    },
  };
  const sigs = {};
  for (const [role, img] of Object.entries(record.images)) {
    reg.push(img.repo, tag, img.digest);
    sigs[role] = reg.sign(img.repo, img.digest);
    const kind = trustKind ?? (rehearsal ? 'unsigned' : 'release'); // rehearsals here are test-key signed
    trust[`${img.repo}@${img.digest}`] =
      kind === 'unsigned' ? { kind } : { kind, commit: c, role, startedOn: at };
  }
  return { record, sigs };
}

const A = commit('a');
const B = commit('b');
/** The real registry on 2026-10-13, in miniature: one real release, one test-key rehearsal, both fully signed. */
function world() {
  const reg = registry();
  const trust = {};
  const real = release(reg, trust, A, { at: '2026-10-12T23:05:52Z', api: dg(1), web: dg(2) });
  const reh = release(reg, trust, B, {
    rehearsal: true,
    at: '2026-10-12T21:53:14Z',
    api: dg(3),
    web: dg(4),
  });
  return { reg, trust, real, reh, records: [real.record, reh.record] };
}
const deleted = (plan) => new Set(plan.deleteManifests.map((m) => `${m.repo}@${m.digest}`));
/** Every artifact of the real release survives: images, signature indexes, signatures and attestations. */
function assertRealReleaseIntact(plan, real) {
  const del = deleted(plan);
  for (const [role, repo] of [
    ['api', 'univarse-api'],
    ['web', 'univarse-web'],
  ]) {
    for (const d of [real.record.images[role].digest, ...real.sigs[role]]) {
      assert.ok(!del.has(`${repo}@${d}`), `${repo}@${d} must not be deleted`);
      assert.ok(plan.live[repo].has(d), `${repo}@${d} must be kept`);
    }
  }
  assert.ok(!plan.untag.some((u) => u.tag === 'sha-aaaaaaa'), 'the real release tags stay');
}

test('[LR8] a rehearsal is removed with its signatures and attestations; the kept release keeps all of its own', () => {
  const { reg, trust, real, reh, records } = world();
  const plan = planPrune(reg.snapshot, { records, trust });
  const del = deleted(plan);
  for (const d of [dg(3), ...reh.sigs.api]) assert.ok(del.has(`univarse-api@${d}`));
  for (const d of [dg(4), ...reh.sigs.web]) assert.ok(del.has(`univarse-web@${d}`));
  assertRealReleaseIntact(plan, real);
});

test('[LR8] deletion is leaf-first: referrers, then the signature index, then the image', () => {
  const { reg, trust, reh, records } = world();
  const order = planPrune(reg.snapshot, { records, trust })
    .deleteManifests.filter((m) => m.repo === 'univarse-api')
    .map((m) => m.digest);
  const [idx, ...children] = reh.sigs.api;
  for (const c of children)
    assert.ok(order.indexOf(c) < order.indexOf(idx), 'referrer before its index');
  assert.ok(order.indexOf(idx) < order.indexOf(dg(3)), 'index before its subject');
});

test('[LR8] edited records never cause a kept release, its signatures or attestations to be deleted', () => {
  const edits = {
    'the real release relabelled a rehearsal': (r) => ({ ...r.real.record, rehearsal: true }),
    'the real release record deleted': () => null,
    'the rehearsal record claims the real release digests and tags': (r) => ({
      ...r.reh.record,
      rehearsal: false,
      commit: A,
      images: { api: { ...r.real.record.images.api }, web: { ...r.real.record.images.web } },
    }),
    'the rehearsal record keeps its tags but names the real digests': (r) => ({
      ...r.reh.record,
      images: {
        api: { ...r.reh.record.images.api, digest: dg(1) },
        web: { ...r.reh.record.images.web, digest: dg(2) },
      },
    }),
    'refs claiming every tag, including signature indexes': (r) => ({
      ...r.reh.record,
      refs: Object.entries(r.reg.snapshot.repos).flatMap(([repo, { tags }]) =>
        Object.keys(tags).map((tag) => ({ repo, tag })),
      ),
    }),
  };
  for (const [what, edit] of Object.entries(edits)) {
    const w = world();
    const edited = edit(w);
    const records = what.startsWith('the real')
      ? [edited, w.reh.record].filter(Boolean)
      : [w.real.record, edited];
    const plan = planPrune(w.reg.snapshot, { records, trust: w.trust });
    assert.doesNotThrow(() => assertRealReleaseIntact(plan, w.real), what);
  }
});

test('[LR8] twenty fabricated newer "releases" in records cannot push the real release out of retention', () => {
  const { reg, trust, real, reh } = world();
  const fakes = Array.from({ length: 20 }, (_, i) => ({
    ...real.record,
    file: `fake-${i}.json`,
    startedAt: `2027-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
    commit: commit(String.fromCharCode(99 + (i % 3))),
  }));
  const plan = planPrune(reg.snapshot, { records: [...fakes, real.record, reh.record], trust });
  assert.deepEqual(plan.keptCommits, [A], 'retention comes from signatures, not records');
  assertRealReleaseIntact(plan, real);
});

test('[LR8] a record cannot nominate an unrelated image: off-scheme tags, other repos and unowned tags', () => {
  const { reg, trust, real, reh } = world();
  reg.push('univarse-api', 'latest', dg(3)); // an unowned tag on the rehearsal's api image protects it
  reg.push('univarse-web', 'keep-me', dg(50));
  reg.sign('univarse-web', dg(50));
  trust['univarse-web@' + dg(50)] = { kind: 'unsigned' };
  const edited = {
    ...reh.record,
    images: {
      ...reh.record.images,
      web: { ...reh.record.images.web, tag: 'keep-me', digest: dg(50) },
    },
  };
  const plan = planPrune(reg.snapshot, { records: [real.record, edited, reh.record], trust });
  const del = deleted(plan);
  assert.ok(
    !del.has(`univarse-web@${dg(50)}`),
    'a tag outside the generated scheme is never nominated',
  );
  assert.ok(!del.has(`univarse-api@${dg(3)}`), 'the unowned latest tag protects the image');
  assert.ok(
    plan.unowned.some((u) => u.tag === 'latest') && plan.unowned.some((u) => u.tag === 'keep-me'),
  );
  assert.equal(nominations(edited).length, 0, 'the off-scheme record nominates nothing at all');
});

test('[LR8] an image whose signature check is inconclusive, or signed for another commit, is never deleted', () => {
  // Inconclusive; signed as a rehearsal of ANOTHER commit; signed as an expired release of another commit (keep 0).
  const C = commit('c');
  for (const [verdict, keep] of [
    [{ kind: 'unknown', why: 'registry unreachable' }, 20],
    [{ kind: 'rehearsal', commit: C, role: 'api', startedOn: 'T' }, 20],
    [{ kind: 'release', commit: C, role: 'api', startedOn: '2020-01-01T00:00:00Z' }, 0],
  ]) {
    const { reg, trust, records } = world();
    trust[`univarse-api@${dg(3)}`] = verdict;
    const plan = planPrune(reg.snapshot, { records, trust, keep });
    assert.ok(!deleted(plan).has(`univarse-api@${dg(3)}`), JSON.stringify(verdict));
    assert.ok(
      plan.ignored.some((i) => i.why.includes(`univarse-api@${dg(3)} kept`)),
      JSON.stringify(verdict),
    );
  }
});

test('[LR8] the newest 20 signed releases are kept; the 21st goes when its record nominates it; rehearsals never count', () => {
  const reg = registry();
  const trust = {};
  const recs = [];
  for (let i = 0; i < 21; i++) {
    const c = i.toString(16).padEnd(40, 'c'); // distinct 7-character tag prefixes
    recs.push(
      release(reg, trust, c, {
        at: `2026-11-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
        api: dg(100 + i),
        web: dg(200 + i),
      }).record,
    );
  }
  const reh = release(reg, trust, commit('f'), {
    rehearsal: true,
    at: '2026-12-31T00:00:00Z',
    api: dg(300),
    web: dg(301),
    trustKind: 'rehearsal',
  });
  assert.equal(keptCommits(trust).size, 20);
  assert.ok(
    !keptCommits(trust).has(recs[0].commit),
    'the oldest signed release is outside the window',
  );
  const del = deleted(planPrune(reg.snapshot, { records: [...recs, reh.record], trust }));
  assert.ok(del.has(`univarse-api@${dg(100)}`), 'the 21st release, nominated by its own record');
  for (let i = 1; i < 21; i++) assert.ok(!del.has(`univarse-api@${dg(100 + i)}`));
  assert.ok(del.has(`univarse-api@${dg(300)}`), 'a real-key rehearsal of its own commit');
});

test('[LR8] deploy current and rollback digests (pins) are kept with their signatures', () => {
  const { reg, trust, reh, records } = world();
  const plan = planPrune(reg.snapshot, {
    records,
    trust,
    pins: [{ repo: 'univarse-api', digest: dg(3) }],
  });
  for (const d of [dg(3), ...reh.sigs.api]) assert.ok(!deleted(plan).has(`univarse-api@${d}`));
  assert.ok(
    plan.untag.some((u) => u.repo === 'univarse-api' && u.tag === 'sha-bbbbbbb-rehearsal'),
    'only its tag goes',
  );
  assert.ok(deleted(plan).has(`univarse-web@${dg(4)}`), 'the unpinned web image still goes');
});

test('[LR8] a digest shared with a kept release (the unsigned-check image) is only untagged, never deleted', () => {
  const { reg, trust, records } = world();
  reg.push('univarse-api', 'unsigned-check-sha-aaaaaaa', dg(9));
  reg.push('univarse-api', 'unsigned-check-sha-bbbbbbb-rehearsal', dg(9));
  const plan = planPrune(reg.snapshot, { records, trust });
  assert.ok(!deleted(plan).has(`univarse-api@${dg(9)}`));
  assert.deepEqual(
    plan.untag.filter((u) => u.digest === dg(9)).map((u) => u.tag),
    ['unsigned-check-sha-bbbbbbb-rehearsal'],
  );
});

test('[LR8] signatures of signatures, and orphaned signature indexes, are never eligible', () => {
  const { reg, trust, real, records } = world();
  const nested = reg.sign('univarse-api', real.sigs.api[1], 1);
  const orphan = reg.sign('univarse-api', dg(77));
  const plan = planPrune(reg.snapshot, { records, trust });
  for (const d of [...nested, ...orphan]) assert.ok(!deleted(plan).has(`univarse-api@${d}`));
  assert.ok(plan.orphanedIndexes.some((o) => o.tag === fallbackTag(dg(77))));
});

test('[LR8] the role-swap copy in the api repository follows its own release', () => {
  const { reg, trust, records } = world();
  reg.push('univarse-api', 'role-swap-check-sha-aaaaaaa', dg(2));
  const keptSig = reg.sign('univarse-api', dg(2));
  trust[`univarse-api@${dg(2)}`] = {
    kind: 'release',
    commit: A,
    role: 'web',
    startedOn: '2026-10-12T23:05:52Z',
  };
  reg.push('univarse-api', 'role-swap-check-sha-bbbbbbb-rehearsal', dg(4));
  const rehSig = reg.sign('univarse-api', dg(4));
  trust[`univarse-api@${dg(4)}`] = { kind: 'unsigned' };
  const del = deleted(planPrune(reg.snapshot, { records, trust }));
  for (const d of [dg(2), ...keptSig]) assert.ok(!del.has(`univarse-api@${d}`));
  for (const d of [dg(4), ...rehSig]) assert.ok(del.has(`univarse-api@${d}`));
});

test('[LR8] classify: only cosign’s definitive answers mean "not signed"; anything else protects', () => {
  const pred = (p) =>
    JSON.stringify({ payload: Buffer.from(JSON.stringify({ predicate: p })).toString('base64') });
  const prov = (over = {}) => ({
    buildDefinition: { externalParameters: { role: 'api', commit: A, rehearsal: false, ...over } },
    runDetails: { metadata: { startedOn: 'T' } },
  });
  const parse = (out) =>
    out
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(Buffer.from(JSON.parse(l).payload, 'base64').toString()).predicate);
  assert.equal(classify({ status: 0, stdout: pred(prov()) }, parse).kind, 'release');
  assert.equal(
    classify({ status: 0, stdout: pred(prov({ rehearsal: true })) }, parse).kind,
    'rehearsal',
  );
  assert.equal(
    classify({ status: 0, stdout: pred(prov({ rehearsal: undefined })) }, parse).kind,
    'unknown',
  );
  assert.equal(
    classify({ status: 0, stdout: `${pred(prov())}\n${pred(prov({ rehearsal: true }))}` }, parse)
      .kind,
    'unknown',
  );
  assert.equal(
    classify({ status: 0, stdout: 'garbage' }, () => {
      throw new Error('x');
    }).kind,
    'unknown',
  );
  assert.equal(
    classify({ status: 10, stderr: 'error during command execution: no signatures found' }, parse)
      .kind,
    'unsigned',
  );
  assert.equal(
    classify(
      { status: 1, stderr: 'accepted signatures do not match threshold, Found: 0, Expected 1' },
      parse,
    ).kind,
    'unsigned',
  );
  assert.equal(
    classify({ status: 1, stderr: 'dial tcp: lookup registry: no such host' }, parse).kind,
    'unknown',
  );
});

test('[LR8] exclusion: the whole apply holds the registry lock and keeps the public registry offline', () => {
  const src = readFileSync(new URL('./prune.mjs', import.meta.url), 'utf8');
  const main = src.slice(src.indexOf('async function main('));
  const lockAt = main.indexOf("acquireRegistryLock(releases, apply ? 'prune --apply'");
  assert.ok(
    lockAt > 0 && lockAt < main.indexOf('if (!apply)'),
    'the lock is taken before either mode does anything',
  );
  const applyBody = main.slice(main.indexOf('  try {\n    if (!wasRunning) up();'));
  assert.ok(
    applyBody.indexOf('stop(); // the public registry stays offline') <
      applyBody.indexOf('planAt(base, alias)'),
    'offline before planning',
  );
  assert.ok(
    !/\n\s+up\(\);/.test(
      applyBody.slice(applyBody.indexOf('stop();'), applyBody.indexOf('} finally {')),
    ),
    'never brought back mid-apply',
  );
  assert.match(
    applyBody,
    /\} finally \{\n\s+stopPrivate\(\);\n\s+if \(wasRunning\) up\(true\);\n\s+lock\.release\(\);/,
    'restored, then unlocked, last',
  );
  const release = readFileSync(new URL('./release.mjs', import.meta.url), 'utf8');
  assert.ok(
    release.indexOf('lock = acquireRegistryLock(') < release.indexOf('  await main();'),
    'a release holds the lock from before it starts',
  );
  assert.match(
    release,
    /\} finally \{\n\s+lock\?\.release\(\);/,
    'and releases it only at the end of cleanup',
  );
});

test('[LR8] a tag the registry contradicts is never touched: not deleted, not untagged, and reported', () => {
  const { reg, trust, real, reh } = world();
  reg.push('univarse-api', 'sha-bbbbbbb-rehearsal', dg(1)); // the tag now points at the kept release's image
  const plan = planPrune(reg.snapshot, { records: [real.record, reh.record], trust });
  assert.ok(
    !plan.untag.some((u) => u.tag === 'sha-bbbbbbb-rehearsal' && u.repo === 'univarse-api'),
    'not untagged',
  );
  assert.ok(
    plan.kept.some((k) => k.tag === 'sha-bbbbbbb-rehearsal' && k.repo === 'univarse-api'),
    'kept as is',
  );
  assert.ok(
    plan.ignored.some((i) =>
      i.why.includes(`univarse-api:sha-bbbbbbb-rehearsal points at ${dg(1)}`),
    ),
  );
  assertRealReleaseIntact(plan, real);
});

test('[LR8] a rehearsal of a kept commit with identical images (reproducible build) only loses its tags', () => {
  const { reg, trust, real, records } = world();
  const sameCommit = {
    ...real.record,
    file: 'aaaaaaa-rehearsal.json',
    rehearsal: true,
    images: {
      api: { ...real.record.images.api, tag: 'sha-aaaaaaa-rehearsal' },
      web: { ...real.record.images.web, tag: 'sha-aaaaaaa-rehearsal' },
    },
  };
  reg.push('univarse-api', 'sha-aaaaaaa-rehearsal', dg(1));
  reg.push('univarse-web', 'sha-aaaaaaa-rehearsal', dg(2));
  // Even with the real release's own record AND its own tags gone, the signatures alone keep its images.
  for (const [recs, dropRealTags] of [
    [[...records, sameCommit], false],
    [[records[1], sameCommit], true],
  ]) {
    if (dropRealTags)
      for (const r of ['univarse-api', 'univarse-web'])
        delete reg.snapshot.repos[r].tags['sha-aaaaaaa'];
    const plan = planPrune(reg.snapshot, { records: recs, trust });
    assertRealReleaseIntact(plan, real);
    assert.deepEqual(
      plan.untag
        .filter((u) => u.tag === 'sha-aaaaaaa-rehearsal')
        .map((u) => u.repo)
        .sort(),
      ['univarse-api', 'univarse-web'],
    );
  }
});

test('[LR8] remove-only tags (negative-check images) are untagged, and their digest is never deleted', () => {
  const { reg, trust, records } = world();
  reg.push('univarse-unsigned-check', 'sha-bbbbbbb-rehearsal', dg(9));
  const plan = planPrune(reg.snapshot, { records, trust });
  assert.ok(
    plan.untag.some(
      (u) => u.repo === 'univarse-unsigned-check' && u.tag === 'sha-bbbbbbb-rehearsal',
    ),
  );
  assert.ok(!deleted(plan).has(`univarse-unsigned-check@${dg(9)}`));
});

test('[LR8] "not signed by the key" never authorises deletion by itself: the tag must be validly nominated', () => {
  const { reg, trust, real, records } = world();
  const unsigned = (repo, tag, d) => {
    reg.push(repo, tag, d);
    trust[`${repo}@${d}`] = { kind: 'unsigned' };
    return [d, ...reg.sign(repo, d)];
  };
  const cases = {
    'a generated-looking tag with no record': unsigned(
      'univarse-api',
      'sha-ccccccc-rehearsal',
      dg(60),
    ),
    'an arbitrary tag': unsigned('univarse-web', 'scratch', dg(61)),
    'a tag in a repository no release uses': unsigned(
      'univarse-other',
      'sha-bbbbbbb-rehearsal',
      dg(62),
    ),
    'an untagged-looking image left only under its signature index': (() => {
      const sig = reg.sign('univarse-api', dg(63));
      trust[`univarse-api@${dg(63)}`] = { kind: 'unsigned' };
      return [dg(63), ...sig];
    })(),
  };
  // A record whose tag exists but points at a different unsigned digest: the registry contradicts it.
  const contradicted = unsigned('univarse-web', 'sha-ddddddd-rehearsal', dg(64));
  const lying = {
    ...records[1],
    file: 'ddddddd-rehearsal.json',
    commit: commit('d'),
    images: {
      api: { repo: 'univarse-api', tag: 'sha-ddddddd-rehearsal', digest: dg(65) },
      web: { repo: 'univarse-web', tag: 'sha-ddddddd-rehearsal', digest: dg(66) },
    },
  };
  reg.push('univarse-api', 'sha-ddddddd-rehearsal', dg(65));
  trust[`univarse-api@${dg(65)}`] = { kind: 'unsigned' };
  const plan = planPrune(reg.snapshot, { records: [...records, lying], trust });
  const del = deleted(plan);
  for (const [what, ds] of Object.entries({
    ...cases,
    'a tag contradicting its record': contradicted,
  })) {
    for (const d of ds)
      assert.ok(![...del].some((k) => k.endsWith(`@${d}`)), `${what}: ${d} must not be deleted`);
  }
  assert.ok(
    !plan.untag.some((u) => u.tag === 'sha-ddddddd-rehearsal' && u.repo === 'univarse-web'),
    'the contradicted tag is not even untagged',
  );
  assert.ok(
    del.has(`univarse-api@${dg(65)}`),
    'the same record’s matching, unsigned api image is the only one that goes',
  );
  assertRealReleaseIntact(plan, real);
});

/** A multi-platform image index with the given child manifests. */
function index(reg, repo, idx, children) {
  reg.snapshot.repos[repo] ??= { tags: {}, indexes: {} };
  reg.snapshot.repos[repo].indexes[idx] = children;
  return idx;
}

test('[LR8] a protected multi-platform index keeps every child, even one it shares with a deletion candidate', () => {
  const { reg, trust, real, records } = world();
  // An unknown-tagged index I (children c1, c2) shares c1 with the rehearsal's api image, itself an index J (c1, c3).
  const [c1, c2, c3] = [dg(71), dg(72), dg(73)];
  index(reg, 'univarse-api', dg(70), [c1, c2]);
  reg.push('univarse-api', 'latest', dg(70));
  index(reg, 'univarse-api', dg(3), [c1, c3]); // dg(3) is the rehearsal's (nominated, unsigned) api image
  const childSig = reg.sign('univarse-api', c1, 1);
  const plan = planPrune(reg.snapshot, { records, trust });
  const del = deleted(plan);
  for (const d of [dg(70), c1, c2, ...childSig])
    assert.ok(!del.has(`univarse-api@${d}`) && plan.live['univarse-api'].has(d), `kept ${d}`);
  assert.ok(
    del.has(`univarse-api@${dg(3)}`) && del.has(`univarse-api@${c3}`),
    'the candidate and its unshared child go',
  );
  const order = plan.deleteManifests.map((m) => m.digest);
  assert.ok(order.indexOf(c3) < order.indexOf(dg(3)), 'a child before its index');
  assertRealReleaseIntact(plan, real);
});

test('[LR8] a candidate that is itself a child of a protected index is kept', () => {
  const { reg, trust, records } = world();
  index(reg, 'univarse-api', dg(80), [dg(3)]); // the rehearsal's api image is a child of a pinned index
  const plan = planPrune(reg.snapshot, {
    records,
    trust,
    pins: [{ repo: 'univarse-api', digest: dg(80) }],
  });
  assert.ok(!deleted(plan).has(`univarse-api@${dg(3)}`));
  assert.ok(plan.live['univarse-api'].has(dg(3)));
});

test('[LR8] a kept release published as an index keeps all its children, by signature alone', () => {
  const { reg, trust, real, records } = world();
  index(reg, 'univarse-web', dg(2), [dg(91), dg(92)]); // the real web image is a multi-platform index
  index(reg, 'univarse-web', dg(4), [dg(91), dg(93)]); // the rehearsal web index shares a child with it
  const plan = planPrune(reg.snapshot, { records: [records[1]], trust }); // the real record is gone, too
  const del = deleted(plan);
  for (const d of [dg(91), dg(92)]) assert.ok(!del.has(`univarse-web@${d}`));
  assert.ok(del.has(`univarse-web@${dg(93)}`) && del.has(`univarse-web@${dg(4)}`));
  assertRealReleaseIntact(plan, real);
});

test('[LR8] every kept release is verified from signed provenance, including one with no record', () => {
  const { reg, trust, records } = world();
  // A second kept release with no record at all, rebuilt once (two signed api digests).
  const C = commit('c');
  for (const [repo, role, d] of [
    ['univarse-api', 'api', dg(40)],
    ['univarse-api', 'api', dg(41)],
    ['univarse-web', 'web', dg(42)],
  ]) {
    reg.push(repo, `x-${d.slice(-2)}`, d);
    trust[`${repo}@${d}`] = { kind: 'release', commit: C, role, startedOn: '2026-10-13T00:00:00Z' };
  }
  // The role-swap copy (web provenance, api repository) is not an api image of that release.
  trust[`univarse-api@${dg(2)}`] = {
    kind: 'release',
    commit: A,
    role: 'web',
    startedOn: '2026-10-12T23:05:52Z',
  };
  const plan = planPrune(reg.snapshot, { records, trust });
  const { targets, problems } = verificationTargets(trust, plan.keptCommits);
  assert.deepEqual(problems, []);
  const covered = new Set(
    targets.flatMap((t) => [
      `api ${t.commit} ${t.images.api.digest}`,
      `web ${t.commit} ${t.images.web.digest}`,
    ]),
  );
  for (const want of [
    `api ${A} ${dg(1)}`,
    `web ${A} ${dg(2)}`,
    `api ${C} ${dg(40)}`,
    `api ${C} ${dg(41)}`,
    `web ${C} ${dg(42)}`,
  ]) {
    assert.ok(covered.has(want), `verified: ${want}`);
  }
  assert.ok(
    targets.every(
      (t) =>
        t.rehearsal === false &&
        t.images.api.repo === 'univarse-api' &&
        t.images.web.repo === 'univarse-web',
    ),
  );
  assert.ok(
    !targets.some((t) => t.images.api.digest === dg(2)),
    'the role-swap copy is never taken as the api image',
  );
});

test('[LR8] a kept release that cannot be fully verified stops --apply before any deletion', () => {
  const trust = {
    [`univarse-api@${dg(1)}`]: { kind: 'release', commit: A, role: 'api', startedOn: 'T' },
  }; // no web
  const { targets, problems } = verificationTargets(trust, [A]);
  assert.deepEqual(targets, []);
  assert.match(
    problems.join(),
    /kept release a{40}: no web image signed for that role in univarse-web/,
  );
  const src = readFileSync(new URL('./prune.mjs', import.meta.url), 'utf8');
  const apply = src.slice(
    src.indexOf('const { snapshot: before, plan, verify } = await planAt(base, alias);'),
  );
  const refuse = apply.indexOf('if (verify.problems.length) {');
  assert.ok(
    refuse > 0 &&
      refuse < apply.indexOf("verifyAll('before')") &&
      refuse < apply.indexOf("{ method: 'DELETE' }"),
    'refused before verifying or deleting',
  );
  assert.doesNotMatch(
    src,
    /keptRecords|no record to verify by/,
    'records are no longer what gets verified',
  );
});
