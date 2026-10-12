// Spec 0013 CS16 evidence: counts of Trivy vulnerability findings by severity, fixed vs unfixed, from a JSON
// report. Informational only; the gate is the separate `--exit-code 1` run.
//   node tools/images/trivy-summary.mjs <report.json> <label>
import { readFileSync } from 'node:fs';

const [file, label] = process.argv.slice(2);
const report = JSON.parse(readFileSync(file, 'utf8'));
const counts = {};
for (const r of report.Results ?? []) {
  for (const v of r.Vulnerabilities ?? []) {
    const k = v.Severity ?? 'UNKNOWN';
    counts[k] ??= { fixed: 0, unfixed: 0 };
    counts[k][v.FixedVersion ? 'fixed' : 'unfixed']++;
  }
}
const order = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'UNKNOWN'];
const line = order.filter((k) => counts[k]).map((k) => `${k} ${counts[k].fixed + counts[k].unfixed} (fixed ${counts[k].fixed}, unfixed ${counts[k].unfixed})`).join('; ');
console.log(`[trivy] ${label}: ${line || 'no vulnerabilities'}`);
