// Spec 0013 CS7 / ADR-029: the exception file and the "no ignore-unfixed" policy, checked before any scan.
//   node tools/images/exceptions.mjs [--today YYYY-MM-DD] [--root DIR]
// --root checks another tree laid out like the repository (the CS13 gate proofs use fixture trees).
// Fails when: an entry lacks id, purls/paths, statement (evidence), owner or expired_at; an expiry is past or
// more than 30 days ahead; or `ignore-unfixed` appears in the workflows or the Trivy config. Prints every
// active exception, because an active exception means the zero-findings exit can't be claimed.
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_DAYS = 30;
const rootArg = process.argv.indexOf('--root');
const repo = rootArg >= 0 ? pathToFileURL(`${resolve(process.argv[rootArg + 1])}/`) : new URL('../../', import.meta.url);
const todayArg = process.argv.indexOf('--today');
const today = todayArg >= 0 ? process.argv[todayArg + 1] : new Date().toISOString().slice(0, 10);

/** Reads the small YAML subset the exception file uses: three lists of flat maps with scalar or list values. */
export function parseExceptions(text) {
  const out = { vulnerabilities: [], secrets: [], misconfigurations: [] };
  let section = null;
  let entry = null;
  let listKey = null;
  let entryIndent = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '').replace(/^#.*$/, '');
    if (!line.trim()) continue;
    let m;
    if ((m = /^([a-z]+):\s*(\[\])?\s*$/.exec(line))) {
      if (!(m[1] in out)) throw new Error(`unknown section "${m[1]}"`);
      section = m[1];
      entry = null;
      continue;
    }
    if (!section) throw new Error(`entry outside a section: ${raw}`);
    const indent = line.length - line.trimStart().length;
    // A list value under the current key is indented deeper than the entry's own dash.
    if (listKey && entry && indent > entryIndent && (m = /^\s+-\s+(.+)$/.exec(line))) {
      entry[listKey] = [...(Array.isArray(entry[listKey]) ? entry[listKey] : []), unquote(m[1])];
      continue;
    }
    if ((m = /^\s*-\s+([a-z_]+):\s*(.*)$/.exec(line))) {
      entryIndent = indent;
      entry = {};
      out[section].push(entry);
      listKey = null;
      setValue(entry, m[1], m[2]);
      if (m[2] === '') listKey = m[1];
      continue;
    }
    if ((m = /^\s+([a-z_]+):\s*(.*)$/.exec(line)) && entry) {
      setValue(entry, m[1], m[2]);
      listKey = m[2] === '' ? m[1] : null;
      continue;
    }
    throw new Error(`can't read line: ${raw}`);
  }
  return out;
}
function setValue(entry, key, value) {
  entry[key] = value === '' ? [] : /^\[.*\]$/.test(value) ? value.slice(1, -1).split(',').map((v) => unquote(v.trim())).filter(Boolean) : unquote(value);
}
const unquote = (v) => v.replace(/^['"]|['"]$/g, '');

/** Problems with the exception entries, given today's date (YYYY-MM-DD). */
export function exceptionProblems(parsed, todayIso) {
  const problems = [];
  const t = Date.parse(`${todayIso}T00:00:00Z`);
  for (const [section, list] of Object.entries(parsed)) {
    list.forEach((e, i) => {
      const where = `${section}[${i}] ${e.id ?? '(no id)'}`;
      for (const k of ['id', 'statement', 'owner', 'expired_at']) if (!e[k] || (Array.isArray(e[k]) && e[k].length === 0)) problems.push(`${where}: missing ${k}`);
      const scope = section === 'vulnerabilities' ? 'purls' : 'paths';
      if (!Array.isArray(e[scope]) || e[scope].length === 0) problems.push(`${where}: missing ${scope} (an exception names the exact ${section === 'vulnerabilities' ? 'package' : 'path'})`);
      if (e.expired_at) {
        const exp = Date.parse(`${e.expired_at}T00:00:00Z`);
        if (Number.isNaN(exp)) problems.push(`${where}: expired_at "${e.expired_at}" is not YYYY-MM-DD`);
        else if (exp < t) problems.push(`${where}: expired on ${e.expired_at}`);
        else if (exp - t > MAX_DAYS * 86_400_000) problems.push(`${where}: expires ${e.expired_at}, more than ${MAX_DAYS} days ahead`);
      }
    });
  }
  return problems;
}

/** Files that must never ask Trivy to ignore unfixed findings. */
export function ignoreUnfixedProblems(files) {
  return files.filter(({ text }) => /ignore[-_]unfixed/i.test(text.replace(/^\s*#.*$/gm, ''))).map(({ path }) => `${path}: uses ignore-unfixed (ADR-029: unfixed HIGH/CRITICAL findings block too)`);
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/').replace(/^([A-Za-z]):/, '/$1:')}` || process.argv[1]?.endsWith('exceptions.mjs')) {
  const parsed = parseExceptions(readFileSync(new URL('.trivyignore.yaml', repo), 'utf8'));
  const workflowDir = new URL('.github/workflows/', repo);
  const files = [
    ...readdirSync(workflowDir).filter((f) => /\.ya?ml$/.test(f)).map((f) => ({ path: `.github/workflows/${f}`, text: readFileSync(new URL(f, workflowDir), 'utf8') })),
    { path: '.trivyignore.yaml', text: readFileSync(new URL('.trivyignore.yaml', repo), 'utf8') },
    { path: 'tools/images/trivy-secret.yaml', text: readFileSync(new URL('tools/images/trivy-secret.yaml', repo), 'utf8') },
  ];
  const problems = [...exceptionProblems(parsed, today), ...ignoreUnfixedProblems(files)];
  const active = Object.entries(parsed).flatMap(([s, l]) => l.map((e) => `${s}: ${e.id} (${(e.purls ?? e.paths ?? []).join(', ')}) owner ${e.owner}, expires ${e.expired_at}`));
  console.log(active.length === 0 ? '[exceptions] none active: zero-findings can be claimed if the gates pass' : `[exceptions] ${active.length} ACTIVE — zero-findings can NOT be claimed:\n  ${active.join('\n  ')}`);
  if (problems.length > 0) {
    for (const p of problems) console.error(`[exceptions] FAIL ${p}`);
    process.exit(1);
  }
  console.log('[exceptions] PASS: every entry complete and in date; no ignore-unfixed anywhere');
}
