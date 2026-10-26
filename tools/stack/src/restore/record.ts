// Spec 0020 B2-11: the drill's record, `docs/ops/drills/YYYY-MM-DD-restore-and-shred.md` (a rehearsal alone writes
// `…-restore-rehearsal.md`), for the owner to commit. It holds slugs, ids, counts, hashes and times only, and BK9's
// scan runs over it before it is written: no secret value, no token-shaped string, no key material.
import type { RestoreRecord } from './engine.js';

export interface DrillFacts {
  readonly tenant: string;
  readonly tenantId: string;
  readonly keyVersion: number;
  readonly values: number;
  /** The destruction's op, from the ledger. */
  readonly op: string;
}

const secs = (n: number | null) => (n === null ? 'not measured' : n < 120 ? `${String(n)} s` : `${(n / 60).toFixed(1)} min`);

export function recordMarkdown(r: RestoreRecord, opts: { readonly date: string; readonly tools: string; readonly drill?: DrillFacts }): string {
  const title = opts.drill ? `Restore and shred drill, ${opts.date}` : `Restore rehearsal, ${opts.date}`;
  const out = [
    `# ${title}`,
    '',
    `Written by \`pnpm stack:${opts.drill ? 'drill' : 'restore-rehearsal'}\` (spec 0020 ${opts.drill ? 'B2-11' : 'B2-6'}), for the owner to commit. It holds slugs, ids, counts, hashes and times only.`,
    '',
    '| | |',
    '| --- | --- |',
    `| Set | \`${r.setId}\` |`,
    `| Release | \`${r.release}\` |`,
    `| Target | ${r.target} |`,
    `| Tools | \`${opts.tools}\` |`,
    `| RTO | ${secs(r.rtoSeconds)}, from the first unseal to the last check |`,
    `| RPO reached | ${secs(r.rpoSeconds)}: the newest shipped WAL segment's age when the restore began |`,
    `| Peak memory | ${r.peakMemoryMb === null ? 'not measured' : `${String(r.peakMemoryMb)} MiB`}, the restore's containers together |`,
    '',
  ];
  if (opts.drill)
    out.push(
      '## The drill (D11)',
      '',
      `- **Tenant:** \`${opts.drill.tenant}\` (\`${opts.drill.tenantId}\`), suspended, with key version ${String(opts.drill.keyVersion)} and ${String(opts.drill.values)} encrypted values.`,
      `- **Destroyed** through the protocol (\`pnpm stack:keys destroy\`), op \`${opts.drill.op}\`, **after** the set was taken: the set holds its keys.`,
      `- **Before recovery (the control):** ${statusOf(r.decryptBefore, opts.drill.tenant)}.`,
      `- **After recovery:** ${statusOf(r.decryptAfter, opts.drill.tenant)}.`,
      '- **It leaves, by design:** a suspended tenant with destroyed keys, and one accepted destruction in the ledger.',
      '',
    );
  out.push('## The checks (D10)', '', '| Check | Result | Detail |', '| --- | --- | --- |');
  for (const c of r.checks) out.push(`| ${c.name} | ${c.ok ? 'PASS' : 'FAIL'} | ${c.detail.replace(/\|/g, '\\|')} |`);
  out.push('', '## Decryption, per tenant', '', '| Tenant | Before recovery | After recovery |', '| --- | --- | --- |');
  for (const slug of Object.keys(r.decryptBefore ?? {}).sort()) out.push(`| \`${slug}\` | ${statusOf(r.decryptBefore, slug)} | ${statusOf(r.decryptAfter, slug)} |`);
  out.push('');
  return out.join('\n');
}

const statusOf = (r: RestoreRecord['decryptBefore'], slug: string) => {
  const v = r?.[slug];
  return v ? `${v.status} (${String(v.sampled)} sampled)` : 'not present';
};

/**
 * BK9: what in `text` looks secret: one of the stack's secret values, a Vault token, a PEM block, or a private-key
 * file's ciphertext. Hashes (64 hex) and ids are expected; values are never shown, only how many were found.
 */
export function secretProblems(text: string, secrets: readonly string[]): string[] {
  const problems: string[] = [];
  const found = secrets.filter((s) => s.length >= 8 && text.includes(s)).length;
  if (found) problems.push(`${String(found)} of the stack's secret values`);
  if (/\bhv[sbr]\.[A-Za-z0-9_-]{8,}/.test(text)) problems.push('a Vault token');
  if (/-----BEGIN [A-Z ]*(PRIVATE KEY|CERTIFICATE)-----/.test(text)) problems.push('a PEM block');
  if (/"ciphertext"\s*:/.test(text)) problems.push("a key file's ciphertext");
  return problems;
}
