// Spec 0020 B-12, B2-11: `pnpm stack:drill --key <path>`, the shred drill as one command, stopping at the first failure.
//   1. `keys drill-tenant create shred-drill-<YYYYMMDD>` on the stack: a suspended tenant with a key and a few values;
//   2. `pnpm stack:backup`: a set that holds that tenant's keys;
//   3. `pnpm stack:keys destroy shred-drill-<YYYYMMDD>`: the real protocol, every ledger destination needed;
//   4. the rehearsal of that set, expecting the tenant to decrypt before recovery (the control) and to be destroyed
//      after it, every other tenant as the control found it (D11).
// The order is the point: the backup comes between the tenant and its destruction, so the set holds keys the ledger
// says are gone. What it leaves, by design: a suspended tenant with destroyed keys, and one accepted destruction.
import type { RestoreResult } from './engine.js';
import type { DrillFacts } from './record.js';

export interface DrillDeps {
  log(line: string): void;
  /** Step 1, on the stack: the keys job's `drill-tenant create`. A tenant from today already existing stops it. */
  createTenant(slug: string): { ok: true; tenantId: string; keyVersion: number; values: number } | { ok: false; lines: readonly string[] };
  /** Step 2: one backup set, as `pnpm stack:backup` takes it. */
  backup(): Promise<{ ok: true; setId: string } | { ok: false; lines: readonly string[] }>;
  /** Step 3: the destruction protocol. */
  destroy(slug: string): Promise<{ ok: true; op: string } | { ok: false; lines: readonly string[] }>;
  /** Step 4: the rehearsal of that set, with the drill's expectations. */
  rehearse(setId: string, drill: string): Promise<RestoreResult>;
}

export const drillSlug = (d: Date) => `shred-drill-${d.toISOString().slice(0, 10).replace(/-/g, '')}`;

export async function drill(now: Date, deps: DrillDeps): Promise<{ ok: boolean; lines: string[]; result: RestoreResult | null; facts: DrillFacts | null }> {
  const lines: string[] = [];
  const say = (l: string) => {
    lines.push(l);
    deps.log(l);
  };
  // A step's reason has not been printed yet: the CLI prints only the last line of a failed drill.
  const stop = (step: string, more: readonly string[]) => {
    for (const l of more) say(l);
    return { ok: false, lines: [...lines, `STOP at ${step}: the drill did not complete`], result: null, facts: null };
  };
  const slug = drillSlug(now);

  say(`1/4: the drill tenant ${slug}`);
  const t = deps.createTenant(slug);
  if (!t.ok) return stop('1/4 (the drill tenant)', t.lines);
  say(`${slug} (${t.tenantId}): suspended, key version ${String(t.keyVersion)}, ${String(t.values)} encrypted values`);

  say('2/4: a backup set holding its keys');
  const b = await deps.backup();
  if (!b.ok) return stop('2/4 (the backup)', b.lines);
  say(`set ${b.setId}`);

  say(`3/4: ${slug} destroyed through the protocol`);
  const d = await deps.destroy(slug);
  if (!d.ok) return stop('3/4 (the destruction)', d.lines);
  say(`destroyed: op ${d.op}, accepted (durable on every ledger destination)`);

  say(`4/4: the rehearsal of set ${b.setId}`);
  const r = await deps.rehearse(b.setId, slug);
  const facts: DrillFacts = { tenant: slug, tenantId: t.tenantId, keyVersion: t.keyVersion, values: t.values, op: d.op };
  if (!r.ok) return { ok: false, lines: [...lines, ...r.lines, 'STOP at 4/4 (the rehearsal): the drill failed'], result: r, facts };
  return { ok: true, lines: [...lines, ...r.lines, `the drill passed: ${slug} decrypted from the set before recovery, and is destroyed after it`], result: r, facts };
}
