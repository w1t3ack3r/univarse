// Spec 0013 LR9: verify a release for deployment. The release record is an editable index, never proof: this
// re-verifies everything against the trusted public key, offline, on the exact digests named.
//   node tools/images/verify-release.mjs <record.json> [--pub path] [--commit sha]
// Exits non-zero (naming the failure) unless, for every image in the record:
//   • the signature verifies against the committed public key;
//   • the SBOM and provenance attestations verify against it;
//   • the record and the provenance name the expected commit (--commit, else the repository's HEAD; never the
//     record's own value) and the image's Dockerfile.
import { readFileSync } from 'node:fs';
import { dirname, basename } from 'node:path';
import { cosign, DEFAULT_PUB, PREDICATES, predicatesFrom, sh, TOOL_REGISTRY, VERIFY_FLAGS } from './release-lib.mjs';

export function verifyRelease(record, { pub = DEFAULT_PUB, commit }) {
  const problems = [];
  const expectedCommit = commit ?? sh('git', ['rev-parse', 'HEAD']).stdout.trim();
  if (record.commit !== expectedCommit) problems.push(`record commit ${record.commit} is not the expected ${expectedCommit}`);
  const mounts = [[dirname(pub), '/trusted']];
  const key = `/trusted/${basename(pub)}`;
  const results = {};
  for (const [name, img] of Object.entries(record.images ?? {})) {
    const ref = `${TOOL_REGISTRY}/${img.repo}@${img.digest}`;
    const sig = cosign(['verify', '--key', key, ...VERIFY_FLAGS, ref], { mounts, allowFail: true });
    if (sig.status !== 0) {
      problems.push(`${name}: signature does not verify against ${basename(pub)} (${ref}): ${lastLine(sig)}`);
      continue;
    }
    for (const [what, type] of Object.entries(PREDICATES)) {
      const att = cosign(['verify-attestation', '--key', key, '--type', type, ...VERIFY_FLAGS, ref], { mounts, allowFail: true });
      if (att.status !== 0) {
        problems.push(`${name}: ${what} attestation does not verify (${ref}): ${lastLine(att)}`);
        continue;
      }
      if (what === 'provenance') {
        const preds = predicatesFrom(att.stdout);
        const ok = preds.some((p) => p?.buildDefinition?.externalParameters?.commit === expectedCommit && p?.buildDefinition?.externalParameters?.dockerfile === img.dockerfile);
        if (!ok) problems.push(`${name}: provenance doesn't name commit ${expectedCommit} and ${img.dockerfile}`);
      }
    }
    results[name] = ref;
  }
  if (Object.keys(record.images ?? {}).length === 0) problems.push('the record names no images');
  return { ok: problems.length === 0, problems, results };
}

const lastLine = (r) => (r.stderr || r.stdout || '').trim().split('\n').at(-1);

if (process.argv[1]?.endsWith('verify-release.mjs')) {
  const [file, ...rest] = process.argv.slice(2);
  const arg = (n) => (rest.includes(`--${n}`) ? rest[rest.indexOf(`--${n}`) + 1] : undefined);
  if (!file) {
    console.error('usage: verify-release.mjs <record.json> [--pub path] [--commit sha]');
    process.exit(2);
  }
  const record = JSON.parse(readFileSync(file, 'utf8'));
  const { ok, problems, results } = verifyRelease(record, { pub: arg('pub') ?? DEFAULT_PUB, commit: arg('commit') }); // never the record's own commit: it is editable
  if (!ok) {
    for (const p of problems) console.error(`[verify-release] REJECT ${p}`);
    process.exit(1);
  }
  for (const [n, ref] of Object.entries(results)) console.log(`[verify-release] ${n}: ${ref} — signature, SBOM and provenance verified offline`);
}
