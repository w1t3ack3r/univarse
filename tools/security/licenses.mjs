// Spec 0024 G6: the license policy. UniVarse is proprietary and hosted, so a production dependency must carry a
// license on the allowlist (or an SPDX expression that resolves to one), or a recorded exception
// (infra/security/license-exceptions.yaml, checked by exceptions.mjs). Development-only dependencies are reported,
// never blocking. The graph is pnpm's own (`pnpm licenses list --json`), so it is the workspace's real one.
//   node tools/security/licenses.mjs [--prod <file> --dev <file>] [--exceptions <file>]
// Without files it asks pnpm. Exits 1 on any production dependency outside the policy.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import yaml from 'js-yaml';

/** Permissive licenses a proprietary, hosted product can ship (G6, and MIT-0, strictly more permissive than MIT). */
export const ALLOWED = ['MIT', 'MIT-0', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', '0BSD', 'Unlicense', 'CC0-1.0', 'BlueOak-1.0.0', 'Python-2.0', 'Zlib'];

/**
 * Whether an SPDX expression is satisfied by the allowlist: `A AND B` needs both, `A OR B` either, parentheses
 * group. Case-insensitive operators (packages write "MIT and ISC"); an unknown or malformed expression is refused.
 */
export function spdxAllowed(expr, allowed = ALLOWED) {
  const tokens = String(expr ?? '')
    .replace(/[()]/g, (p) => ` ${p} `)
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!tokens.length) return false;
  let i = 0;
  const ok = new Set(allowed.map((a) => a.toLowerCase()));
  const atom = () => {
    const t = tokens[i++];
    if (t === '(') {
      const v = or();
      if (tokens[i++] !== ')') throw new Error('unbalanced');
      return v;
    }
    if (!t || /^(and|or|with)$/i.test(t) || t === ')') throw new Error('malformed');
    return ok.has(t.toLowerCase());
  };
  const and = () => {
    let v = atom();
    while (/^and$/i.test(tokens[i] ?? '')) {
      i++;
      v = atom() && v;
    }
    return v;
  };
  const or = () => {
    let v = and();
    while (/^or$/i.test(tokens[i] ?? '')) {
      i++;
      v = and() || v;
    }
    return v;
  };
  try {
    const v = or();
    return i === tokens.length && v;
  } catch {
    return false;
  }
}

/** pnpm's `licenses list --json`: { "<license>": [{ name, versions, … }] }, flattened to one row per package. */
export function rowsOf(json) {
  return Object.entries(json ?? {}).flatMap(([license, pkgs]) =>
    (Array.isArray(pkgs) ? pkgs : []).map((p) => ({ name: String(p.name), versions: p.versions ?? [p.version].filter(Boolean), license })),
  );
}

/** The packages outside the policy, and which exceptions covered the rest. An exception names packages and licenses. */
export function licenseReport(prodRows, devRows, exceptions = []) {
  const covered = (r) => exceptions.find((e) => (e.packages ?? []).includes(r.name) && (e.licenses ?? []).includes(r.license));
  const problems = [];
  const excepted = [];
  for (const r of prodRows) {
    if (spdxAllowed(r.license)) continue;
    const e = covered(r);
    if (e) excepted.push(`${r.name}@${r.versions.join('/')} (${r.license}): exception ${e.id}, until ${e.expired_at}`);
    else problems.push(`${r.name}@${r.versions.join('/')}: ${r.license} is not on the allowlist (spec 0024 G6), and no exception covers it`);
  }
  const dev = devRows.filter((r) => !spdxAllowed(r.license) && !covered(r)).map((r) => `${r.name}@${r.versions.join('/')} (${r.license})`);
  return { problems, excepted, dev, counted: prodRows.length };
}

const pnpmList = (scope) => {
  const r = spawnSync('pnpm', ['licenses', 'list', scope, '--json'], { encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`pnpm licenses list ${scope} exited ${String(r.status)}: ${r.stderr.trim().split('\n').at(-1) ?? ''}`);
  return JSON.parse(r.stdout);
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const arg = (n) => (process.argv.indexOf(n) >= 0 ? process.argv[process.argv.indexOf(n) + 1] : undefined);
  const exFile = arg('--exceptions') ?? fileURLToPath(new URL('../../infra/security/license-exceptions.yaml', import.meta.url));
  const prod = arg('--prod') ? JSON.parse(readFileSync(arg('--prod'), 'utf8')) : pnpmList('--prod');
  const dev = arg('--dev') ? JSON.parse(readFileSync(arg('--dev'), 'utf8')) : pnpmList('--dev');
  // CORE_SCHEMA: dates stay the strings written, as exceptions.mjs reads them.
  const exceptions = yaml.load(readFileSync(exFile, 'utf8'), { schema: yaml.CORE_SCHEMA }) ?? [];
  const r = licenseReport(rowsOf(prod), rowsOf(dev), exceptions);
  console.log(`Licenses (spec 0024 G6): ${String(r.counted)} production packages checked against the allowlist.`);
  for (const e of r.excepted) console.log(`  excepted: ${e}`);
  if (r.dev.length) console.log(`  development-only, reported (not shipped): ${r.dev.join('; ')}`);
  for (const p of r.problems) console.error(`  FAIL ${p}`);
  if (r.problems.length) process.exit(1);
  console.log('  every production dependency is on the allowlist or covered by an exception');
}
