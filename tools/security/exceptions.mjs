// Spec 0024 G4: one exceptions discipline for the five scanners, checked before any scan, as CS7's is for Trivy.
//   • osv-scanner.toml [[IgnoredVulns]]: an id, a reason (the evidence), and an ignoreUntil at most 30 days ahead;
//   • infra/security/license-exceptions.yaml: an id, packages, licenses, a statement, an owner, and an expired_at at
//     most 365 days ahead (a license doesn't change; it is still reviewed yearly);
//   • inline, in the code it covers: `nosemgrep: <rule-id> -- <reason>` and `checkov:skip=<ID>: <reason>`. A bare
//     `nosemgrep` (every rule) or a suppression without a reason is refused;
//   • the CodeQL config's query-filters: each `- exclude:` has a `# reason:` comment on the line above it.
// A past expiry, one too far ahead, or a missing field fails. Every active exception is printed on every run, so an
// exception is never silent.
//   node tools/security/exceptions.mjs [--root DIR] [--today YYYY-MM-DD]
// --root checks another tree laid out like the repository (the proofs use fixture trees).
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import yaml from 'js-yaml';

export const VULN_MAX_DAYS = 30;
export const LICENSE_MAX_DAYS = 365;
const MIN_REASON = 12;
const DAY = 86_400_000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Problems with one expiry: a date, not past, not further ahead than `maxDays`. */
function expiryProblems(where, value, today, maxDays) {
  const v = String(value ?? '').slice(0, 10);
  if (!DATE.test(v)) return [`${where}: no expiry date (YYYY-MM-DD)`];
  const days = (Date.parse(v) - Date.parse(today)) / DAY;
  if (days < 0) return [`${where}: expired on ${v}`];
  if (days > maxDays) return [`${where}: expires ${v}, more than ${String(maxDays)} days ahead`];
  return [];
}

/** osv-scanner.toml, the subset it uses: `[[IgnoredVulns]]` blocks of `key = value` lines. */
export function parseOsvConfig(text) {
  const out = [];
  let cur = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '').trim();
    if (!line || line.startsWith('#')) continue;
    if (line === '[[IgnoredVulns]]') out.push((cur = {}));
    else if (line.startsWith('[')) cur = null;
    else if (cur) {
      const m = /^([A-Za-z]+)\s*=\s*(.+)$/.exec(line);
      if (m) cur[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
    }
  }
  return out;
}

export function osvProblems(entries, today) {
  const problems = [];
  const active = [];
  entries.forEach((e, i) => {
    const where = `osv-scanner.toml IgnoredVulns #${String(i + 1)}${e.id ? ` (${e.id})` : ''}`;
    if (!e.id) problems.push(`${where}: no id`);
    if (!e.reason || e.reason.length < MIN_REASON) problems.push(`${where}: no reason (the evidence for ignoring it)`);
    problems.push(...expiryProblems(where, e.ignoreUntil, today, VULN_MAX_DAYS));
    active.push(`osv ${e.id ?? '?'} until ${String(e.ignoreUntil ?? '?').slice(0, 10)}: ${e.reason ?? ''}`);
  });
  return { problems, active };
}

export function licenseExceptionProblems(entries, today) {
  const problems = [];
  const active = [];
  const ids = new Set();
  (Array.isArray(entries) ? entries : []).forEach((e, i) => {
    const where = `license exception #${String(i + 1)}${e?.id ? ` (${e.id})` : ''}`;
    for (const k of ['id', 'statement', 'owner']) if (!e?.[k]) problems.push(`${where}: missing ${k}`);
    for (const k of ['packages', 'licenses']) if (!Array.isArray(e?.[k]) || !e[k].length) problems.push(`${where}: missing ${k}`);
    if (e?.statement && String(e.statement).length < MIN_REASON) problems.push(`${where}: the statement is too short to be evidence`);
    if (e?.id && ids.has(e.id)) problems.push(`${where}: duplicate id`);
    if (e?.id) ids.add(e.id);
    problems.push(...expiryProblems(where, e?.expired_at, today, LICENSE_MAX_DAYS));
    active.push(`license ${e?.id ?? '?'} until ${String(e?.expired_at ?? '?')}: ${(e?.packages ?? []).join(', ')} (${(e?.licenses ?? []).join(' | ')})`);
  });
  return { problems, active };
}

// Semgrep honours `nosem` as well as `nosemgrep`, so both are checked, in any case.
const NOSEMGREP = /\bnosem(?:grep)?\b(.*)$/i;
const CHECKOV_SKIP = /checkov:skip=([^\s:]*)(.*)$/;
/** Inline suppressions in one file's text: each must name its rule and give a reason. */
export function inlineProblems(text, file) {
  const problems = [];
  const active = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const at = `${file}:${String(i + 1)}`;
    const s = NOSEMGREP.exec(line);
    if (s) {
      const m = /^:\s*([\w.-]+)\s+--\s+(.+)$/.exec(s[1].trim());
      if (!m) problems.push(`${at}: nosemgrep must name its rule and give a reason (nosemgrep: <rule-id> -- <reason>)`);
      else if (m[2].trim().length < MIN_REASON) problems.push(`${at}: nosemgrep's reason is too short to be evidence`);
      else active.push(`semgrep ${m[1]} at ${at}: ${m[2].trim()}`);
    }
    const c = CHECKOV_SKIP.exec(line);
    if (c) {
      const reason = c[2].replace(/^:\s*/, '').trim();
      if (!/^CKV2?_[A-Z0-9_]+$/.test(c[1])) problems.push(`${at}: checkov:skip must name one check (checkov:skip=CKV_…: <reason>)`);
      else if (!c[2].startsWith(':') || reason.length < MIN_REASON) problems.push(`${at}: checkov:skip=${c[1]} has no reason`);
      else active.push(`checkov ${c[1]} at ${at}: ${reason}`);
    }
  });
  return { problems, active };
}

/** The CodeQL config's query-filters: every `- exclude:` needs a `# reason:` comment on the line above. */
export function codeqlFilterProblems(text, file) {
  const problems = [];
  const active = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    if (!/^\s*-\s*exclude:/.test(line)) return;
    const above = lines[i - 1] ?? '';
    const reason = /^\s*#\s*reason:\s*(.+)$/.exec(above)?.[1]?.trim() ?? '';
    if (reason.length < MIN_REASON) problems.push(`${file}:${String(i + 1)}: a query-filters exclude needs a "# reason: …" comment on the line above`);
    else active.push(`codeql exclude at ${file}:${String(i + 1)}: ${reason}`);
  });
  return { problems, active };
}

/** Files the inline check reads: code and config, never this tool's own tests and fixtures, which spell the forms out. */
const CODE = /\.(ts|tsx|mts|cts|js|mjs|cjs|yml|yaml|sh)$|(^|[\\/])([\w.-]+\.)?Dockerfile$/;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.next', '.turbo', 'generated']);
function walk(dir, root, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, root, out);
    else out.push(relative(root, p));
  }
  return out;
}
export function filesToCheck(root) {
  const git = existsSync(join(root, '.git')) ? spawnSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }) : null;
  const all = git && git.status === 0 ? git.stdout.split('\0').filter(Boolean) : walk(root, root);
  return all.map((f) => f.split(sep).join('/')).filter((f) => CODE.test(f) && !f.startsWith('tools/security/'));
}

export function checkAll(root, today) {
  const problems = [];
  const active = [];
  const add = (r) => {
    problems.push(...r.problems);
    active.push(...r.active);
  };
  const osv = join(root, 'osv-scanner.toml');
  if (existsSync(osv)) add(osvProblems(parseOsvConfig(readFileSync(osv, 'utf8')), today));
  const lic = join(root, 'infra', 'security', 'license-exceptions.yaml');
  if (existsSync(lic)) add(licenseExceptionProblems(yaml.load(readFileSync(lic, 'utf8'), { schema: yaml.CORE_SCHEMA }) ?? [], today));
  const cq = join(root, '.github', 'codeql', 'codeql-config.yml');
  if (existsSync(cq)) add(codeqlFilterProblems(readFileSync(cq, 'utf8'), '.github/codeql/codeql-config.yml'));
  for (const f of filesToCheck(root)) add(inlineProblems(readFileSync(join(root, f), 'utf8'), f));
  return { problems, active };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const arg = (n) => (process.argv.indexOf(n) >= 0 ? process.argv[process.argv.indexOf(n) + 1] : undefined);
  const root = arg('--root') ? resolve(arg('--root')) : fileURLToPath(new URL('../../', import.meta.url));
  const today = arg('--today') ?? new Date().toISOString().slice(0, 10);
  const r = checkAll(root, today);
  console.log(`Security exceptions (spec 0024 G4), ${today}: ${String(r.active.length)} active`);
  for (const a of r.active) console.log(`  active: ${a}`);
  for (const p of r.problems) console.error(`  FAIL ${p}`);
  process.exit(r.problems.length ? 1 : 0);
}
