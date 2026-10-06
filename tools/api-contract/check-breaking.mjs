// Spec 0011 OA12 (D4: report-only, acknowledged). Reads oasdiff's breaking-change JSON and the PR
// description; writes the report to the CI job summary; fails only when a breaking change (oasdiff level
// 3, ERR) is not acknowledged in the PR description:
//
//   ## API breaking changes
//   - PUT /api/v1/settings/{key}: what changed and why
//   Open tabs: how a browser tab still running the previous web app copes (e.g. expand → migrate → contract)
//
// Every broken operation must be named as `METHOD /path`, and the "Open tabs:" line must say something real.
//   node tools/api-contract/check-breaking.mjs <oasdiff.json> <pr-body.md>
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const ERR = 3;
const WARN = 2;

/** The `## API breaking changes` section's text, or null when the description has none. */
export function ackSection(body) {
  // HTML comments don't count: the PR template's commented-out example must never acknowledge anything.
  const visible = (body ?? '').replace(/<!--[\s\S]*?-->/g, '');
  const lines = visible.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((l) => /^##\s+API breaking changes\s*$/i.test(l.trim()));
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^##\s/.test(l.trim()));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}

const opKey = (c) => `${c.operation.toUpperCase()} ${c.path}`;

/** The verdict for one PR: which breaks are unacknowledged and why. Pure, so the gate itself is tested. */
export function evaluate(changes, body) {
  const breaking = changes.filter((c) => c.level >= ERR);
  const warnings = changes.filter((c) => c.level === WARN);
  const problems = [];
  if (breaking.length > 0) {
    const section = ackSection(body);
    if (section === null) {
      problems.push(`${breaking.length} breaking change(s), but the PR description has no "## API breaking changes" section.`);
    } else {
      const text = section.replace(/`/g, '');
      const missing = [...new Set(breaking.map(opKey))].filter((k) => !text.toUpperCase().includes(k.toUpperCase()));
      if (missing.length > 0) problems.push(`Not named in "## API breaking changes": ${missing.join(', ')}.`);
      const tabs = /^\s*[-*]?\s*Open tabs:\s*(.*)$/im.exec(section)?.[1]?.trim() ?? '';
      if (tabs.length < 15 || /^<.*>$/.test(tabs) || /\b(todo|tbd|n\/a)\b/i.test(tabs)) {
        problems.push('"Open tabs:" must say how a browser tab still running the previous web app copes (older clients stay open).');
      }
    }
  }
  return { breaking, warnings, problems, ok: problems.length === 0 };
}

/** Markdown for the job summary: every breaking change and warning, then the verdict. */
export function summary(result) {
  const rows = (list) => list.map((c) => `| ${c.level >= ERR ? 'breaking' : 'warning'} | \`${opKey(c)}\` | ${c.text.replace(/\|/g, '\\|')} |`).join('\n');
  const out = ['## API contract changes (oasdiff, against the PR base)', ''];
  if (result.breaking.length + result.warnings.length === 0) out.push('No breaking changes and no warnings.');
  else out.push('| Level | Operation | Change |', '|---|---|---|', rows([...result.breaking, ...result.warnings]));
  out.push('');
  if (result.breaking.length === 0) out.push('**Verdict:** nothing to acknowledge.');
  else if (result.ok) out.push(`**Verdict:** ${result.breaking.length} breaking change(s), acknowledged in the PR description.`);
  else out.push(`**Verdict: unacknowledged breaking change(s).**`, '', ...result.problems.map((p) => `- ${p}`));
  return `${out.join('\n')}\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [changesFile, bodyFile] = process.argv.slice(2);
  if (!changesFile || !bodyFile) {
    console.error('usage: check-breaking.mjs <oasdiff.json> <pr-body.md>');
    process.exit(2);
  }
  const raw = readFileSync(changesFile, 'utf8').trim();
  const result = evaluate(raw ? JSON.parse(raw) : [], readFileSync(bodyFile, 'utf8'));
  const md = summary(result);
  console.log(md);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
  for (const p of result.problems) console.log(`::error title=API breaking change not acknowledged::${p}`);
  process.exit(result.ok ? 0 : 1);
}
