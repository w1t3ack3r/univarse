// Spec 0013 LR9: verify a release for deployment. The release record is an editable index, never proof: this
// re-verifies everything against the trusted public key, offline, on the exact digests named.
//   node tools/images/verify-release.mjs <record.json> [--pub path] [--commit sha]
// Exits non-zero (naming each failure) unless:
//   • the record names EXACTLY the roles in ROLES (api, web) — no more, no fewer — each with its trusted repository;
//   • for each image, the signature, the SBOM attestation and the provenance attestation verify against the key;
//   • the signed provenance names that role, its trusted Dockerfile (from ROLES, never the record), the expected
//     commit (--commit, else the repository's HEAD; never the record's own value), and `rehearsal: false`.
// A rehearsal is accepted only when the release verifies its own rehearsal (allowRehearsal), never by the deploy:
// the rehearsal flag is bound into the signed provenance, so editing the record's JSON changes nothing.
import { readFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { cosign as realCosign, DEFAULT_PUB, PREDICATES, predicatesFrom, ROLES, sh, TOOL_REGISTRY, VERIFY_FLAGS } from './release-lib.mjs';

const gitHead = () => sh('git', ['rev-parse', 'HEAD']).stdout.trim();

export function verifyRelease(record, { pub = DEFAULT_PUB, commit, allowRehearsal = false, cosign = realCosign, head = gitHead } = {}) {
  const problems = [];
  const expectedCommit = commit ?? head();
  if (record.commit !== expectedCommit) problems.push(`record commit ${record.commit} is not the expected ${expectedCommit}`);

  // Roles: exactly the trusted set, each with its trusted repository.
  const roles = Object.keys(record.images ?? {});
  for (const role of Object.keys(ROLES)) if (!roles.includes(role)) problems.push(`the record has no ${role} image`);
  for (const role of roles) if (!(role in ROLES)) problems.push(`the record names an unknown image role "${role}"`);

  const mounts = [[dirname(pub), '/trusted']];
  const key = `/trusted/${basename(pub)}`;
  const results = {};
  for (const [role, trusted] of Object.entries(ROLES)) {
    const img = record.images?.[role];
    if (!img) continue;
    if (img.repo !== trusted.repo) {
      problems.push(`${role}: repository "${img.repo}" is not the trusted ${trusted.repo}`);
      continue;
    }
    if (!/^sha256:[0-9a-f]{64}$/.test(img.digest ?? '')) {
      problems.push(`${role}: "${img.digest}" is not a sha256 digest`);
      continue;
    }
    const ref = `${TOOL_REGISTRY}/${trusted.repo}@${img.digest}`;
    const sig = cosign(['verify', '--key', key, ...VERIFY_FLAGS, ref], { mounts, allowFail: true });
    if (sig.status !== 0) {
      problems.push(`${role}: signature does not verify against ${basename(pub)} (${ref}): ${lastLine(sig)}`);
      continue;
    }
    const sbom = cosign(['verify-attestation', '--key', key, '--type', PREDICATES.sbom, ...VERIFY_FLAGS, ref], { mounts, allowFail: true });
    if (sbom.status !== 0) problems.push(`${role}: SBOM attestation does not verify (${ref}): ${lastLine(sbom)}`);
    const prov = cosign(['verify-attestation', '--key', key, '--type', PREDICATES.provenance, ...VERIFY_FLAGS, ref], { mounts, allowFail: true });
    if (prov.status !== 0) {
      problems.push(`${role}: provenance attestation does not verify (${ref}): ${lastLine(prov)}`);
      continue;
    }
    const params = predicatesFrom(prov.stdout).map((p) => p?.buildDefinition?.externalParameters ?? {});
    const why = provenanceProblem(params, { role, dockerfile: trusted.dockerfile, commit: expectedCommit, allowRehearsal });
    if (why) problems.push(`${role}: ${why} (${ref})`);
    else results[role] = ref;
  }
  return { ok: problems.length === 0, problems, results };
}

/** Why no signed provenance statement matches what's trusted, or null when one does. */
export function provenanceProblem(params, { role, dockerfile, commit, allowRehearsal }) {
  if (params.length === 0) return 'no provenance statement';
  const matching = params.filter((p) => p.role === role && p.dockerfile === dockerfile && p.commit === commit);
  if (matching.length === 0) {
    const seen = params.map((p) => `role ${p.role}, ${p.dockerfile}, commit ${p.commit}`).join('; ');
    return `signed provenance does not name role ${role}, ${dockerfile} and commit ${commit} (it names: ${seen})`;
  }
  if (!allowRehearsal && !matching.some((p) => p.rehearsal === false)) return 'signed provenance marks this a rehearsal (or omits the flag); a rehearsal is never deployable';
  return null;
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
  // The deploy's check: never the record's own commit (it is editable), never a rehearsal.
  const { ok, problems, results } = verifyRelease(record, { pub: arg('pub') ?? DEFAULT_PUB, commit: arg('commit') });
  if (!ok) {
    for (const p of problems) console.error(`[verify-release] REJECT ${p}`);
    process.exit(1);
  }
  for (const [n, ref] of Object.entries(results)) console.log(`[verify-release] ${n}: ${ref} — signature, SBOM and provenance verified offline`);
}
