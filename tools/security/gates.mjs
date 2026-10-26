// Spec 0024 G3 and G8: each scanner's report, read and decided at its threshold. Findings below the threshold are
// printed (the job summary), never hidden.
//   node tools/security/gates.mjs <semgrep|osv|checkov|codeql> <report> [--expect <finding>]
// Without --expect, exits 1 when anything blocks. With --expect (the proofs), exits 0 only when the gate blocks AND
// the expected finding is among the blockers: a gate that fails for another reason, or passes, is a failed proof.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** One blocking or reported finding: its id, where, and what. */
const f = (id, where, what) => ({ id: String(id), where: String(where), what: String(what ?? '').replace(/\s+/g, ' ').slice(0, 200) });

/** Semgrep JSON: ERROR blocks; WARNING and INFO are reported; scan errors (partial parses) are reported. */
export function semgrepGate(report) {
  const blocking = [];
  const reported = [];
  for (const r of report?.results ?? []) {
    const x = f(r.check_id, `${r.path}:${String(r.start?.line ?? '?')}`, r.extra?.message);
    (r.extra?.severity === 'ERROR' ? blocking : reported).push(x);
  }
  for (const e of report?.errors ?? []) reported.push(f(`scan ${String(e.level ?? 'error')}`, e.path ?? '', e.message ?? e.type));
  return { blocking, reported, scanned: report?.paths?.scanned?.length ?? null };
}

/** osv-scanner JSON: any known vulnerability blocks, whatever its severity (G3). */
export function osvGate(report) {
  const blocking = [];
  for (const res of report?.results ?? [])
    for (const p of res.packages ?? [])
      for (const v of p.vulnerabilities ?? []) blocking.push(f(v.id, `${p.package?.name}@${p.package?.version}`, v.summary ?? (v.aliases ?? []).join(', ')));
  return { blocking, reported: [], scanned: null };
}

/** Checkov JSON (one report, or one per framework): every failed check blocks, and so does a file it couldn't parse.
 * `--quiet` keeps only the failed checks in `results`, so the summary's counts are trusted too: a failure it counts
 * but doesn't list still blocks, and its skips are reported by count (the exceptions check lists each one). */
export function checkovGate(report) {
  const blocking = [];
  const reported = [];
  for (const r of Array.isArray(report) ? report : [report]) {
    const type = String(r?.check_type ?? 'checkov');
    const failed = r?.results?.failed_checks ?? [];
    const skipped = r?.results?.skipped_checks ?? [];
    for (const c of failed) blocking.push(f(c.check_id, `${c.file_path}:${(c.file_line_range ?? []).join('-')}`, c.check_name));
    const s = r?.summary ?? {};
    if ((s.failed ?? 0) > failed.length) blocking.push(f(`${type} failed`, type, `the summary counts ${String(s.failed)} failed checks, ${String(failed.length)} listed`));
    if ((s.parsing_errors ?? 0) > 0) blocking.push(f(`${type} parsing errors`, type, `${String(s.parsing_errors)} files could not be parsed, so they were not checked`));
    for (const c of skipped) reported.push(f(`${c.check_id} (skipped)`, c.file_path, c.check_result?.suppress_comment));
    if ((s.skipped ?? 0) > skipped.length) reported.push(f(`${type} skipped`, type, `${String(s.skipped)} checks skipped inline (listed by the exceptions check)`));
  }
  return { blocking, reported, scanned: null };
}

/** CodeQL SARIF: `error` and `warning` results block (security-extended), `note` is reported. A result's own level, else its rule's. */
export function codeqlGate(sarif) {
  const blocking = [];
  const reported = [];
  for (const run of sarif?.runs ?? []) {
    const rules = new Map();
    for (const r of run.tool?.driver?.rules ?? []) rules.set(r.id, r);
    for (const ext of run.tool?.extensions ?? []) for (const r of ext.rules ?? []) rules.set(r.id, r);
    for (const res of run.results ?? []) {
      const level = res.level ?? rules.get(res.ruleId)?.defaultConfiguration?.level ?? 'warning';
      const loc = res.locations?.[0]?.physicalLocation;
      const x = f(res.ruleId, `${loc?.artifactLocation?.uri ?? '?'}:${String(loc?.region?.startLine ?? '?')}`, res.message?.text);
      (level === 'error' || level === 'warning' ? blocking : reported).push(x);
    }
  }
  return { blocking, reported, scanned: null };
}

export const GATES = { semgrep: semgrepGate, osv: osvGate, checkov: checkovGate, codeql: codeqlGate };

/** The decision and its lines. `expect` turns the gate into a proof: it must block, for that finding. */
export function decide(kind, gate, expect) {
  const lines = [];
  const name = { semgrep: 'Semgrep', osv: 'osv-scanner', checkov: 'Checkov', codeql: 'CodeQL' }[kind] ?? kind;
  lines.push(`${name} (spec 0024 G3): ${String(gate.blocking.length)} blocking, ${String(gate.reported.length)} reported${gate.scanned === null ? '' : `, ${String(gate.scanned)} files scanned`}`);
  for (const b of gate.blocking) lines.push(`  BLOCK ${b.id} ${b.where}: ${b.what}`);
  for (const r of gate.reported) lines.push(`  report ${r.id} ${r.where}: ${r.what}`);
  if (expect === undefined) return { ok: gate.blocking.length === 0, lines };
  const hit = gate.blocking.some((b) => b.id === expect || b.id.endsWith(`.${expect}`) || b.id.includes(expect));
  lines.push(hit ? `  proof: the gate blocks, for ${expect} (as intended)` : `  PROOF FAILED: expected the gate to block for ${expect}`);
  return { ok: hit, lines };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [kind, file] = process.argv.slice(2);
  const ei = process.argv.indexOf('--expect');
  const expect = ei >= 0 ? process.argv[ei + 1] : undefined;
  const gate = GATES[kind ?? ''];
  if (!gate || !file) {
    console.error('usage: node tools/security/gates.mjs <semgrep|osv|checkov|codeql> <report> [--expect <finding>]');
    process.exit(2);
  }
  let report;
  try {
    report = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    // An unreadable report is never a pass: the scanner didn't produce what it should have.
    console.error(`${kind}: the report ${file} can't be read (${e.message}): the scan did not complete`);
    process.exit(1);
  }
  const d = decide(kind, gate(report), expect);
  for (const l of d.lines) (l.includes('BLOCK') || l.includes('FAILED') ? console.error : console.log)(l);
  process.exit(d.ok ? 0 : 1);
}
