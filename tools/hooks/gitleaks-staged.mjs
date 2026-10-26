// Spec 0024 H2, the pre-commit hook: gitleaks on what is staged, with the pinned binary from `pnpm tools:gitleaks`.
// Absent, it fails and says how to get it, rather than skipping silently; it never fetches anything itself.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { binary, VERSION } from './gitleaks.mjs';

const bin = binary();
if (!existsSync(bin)) {
  console.error(`gitleaks ${VERSION} isn't installed for the pre-commit hook. Run \`pnpm tools:gitleaks\` (pinned and checksum-verified).`);
  process.exit(1);
}
// --redact: a finding names its file, line and rule, never the secret.
const r = spawnSync(bin, ['git', '--staged', '--redact', '--no-banner', '--exit-code', '1', '.'], { stdio: 'inherit' });
if (r.status !== 0) console.error('gitleaks: the staged changes hold what looks like a secret (above). Remove it; a reviewed false positive goes in .gitleaksignore by fingerprint.');
process.exit(r.status ?? 1);
