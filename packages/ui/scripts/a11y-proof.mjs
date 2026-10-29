// Spec 0026 SB6: the accessibility gate bites. Runs the `a11y-proof` project, whose two stories each carry one known
// violation, and passes only if both fail, each for its own axe rule. A proof that passes (a gate that stopped
// checking) or fails for another reason (a story that stopped rendering) fails this script.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EXPECTED, failures, problems } from './a11y-proof-lib.mjs';

const dir = mkdtempSync(join(tmpdir(), 'uv-a11y-proof-'));
const out = join(dir, 'report.json');
try {
  const r = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--project', 'a11y-proof', '--reporter=json', `--outputFile=${out}`], { encoding: 'utf8' });
  let report;
  try {
    report = JSON.parse(readFileSync(out, 'utf8'));
  } catch {
    console.error(`[a11y-proof] no report (vitest exited ${String(r.status)}):\n${(r.stderr || r.stdout).slice(-3000)}`);
    process.exit(1);
  }
  const p = problems(r.status, failures(report));
  if (p.length) {
    for (const line of p) console.error(`[a11y-proof] FAIL ${line}`);
    process.exit(1);
  }
  for (const [story, rule] of Object.entries(EXPECTED)) console.log(`[a11y-proof] ${story}: failed for ${rule}, as required`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
