// Spec 0020 B2-6 (steps 9 and 11), B2-9, B2-11: what a restore's checks decide, from the keys job's reports. Pure, so
// each rule is unit-tested at its edge: the decision is never the job's exit code alone.
//   counts   at the set's own target, every table's row count equals the manifest's, platform and per tenant;
//   control  before recovery, every tenant decrypts, except one destroyed before the set was taken; the drill tenant
//            must decrypt (D11: otherwise the set never held its keys, and the drill proves nothing);
//   after    after recovery, every tenant with an accepted destruction is key_destroyed, and every other tenant is
//            exactly as the control found it.

import { opStates, planStates, type Entry } from '../ledger/chain.js';

/**
 * The tenants whose every key the ledger's accepted destructions destroyed (TENANT, committed), by slug: all of them
 * (`accepted`, what recovery must make hold), and those committed by the set's own ledger head (`before`, the only
 * ones the control may find destroyed). A RETIRED destruction leaves the tenant decrypting, so it counts in neither.
 * A set from another ledger or generation can't be placed in this one's sequence: then every accepted one counts as
 * before, the cautious reading for the control.
 */
export function destroyedTenants(entries: readonly Entry[], setLedger: { readonly ledgerId: string; readonly generation: number; readonly seq: number }): { accepted: Set<string>; before: Set<string> } {
  const g = entries[0];
  const sameLedger = g?.type === 'genesis' && g.ledgerId === setLedger.ledgerId && g.generation === setLedger.generation;
  const accepted = new Set<string>();
  const before = new Set<string>();
  // A3: a waiver's plan carries the destructions of the generation before, re-applied in this one. They predate it.
  for (const s of planStates(entries).plan.values())
    if (s.result?.type === 'reapplied' && s.item.kind === 'TENANT') {
      accepted.add(s.item.tenant.slug);
      before.add(s.item.tenant.slug);
    }
  for (const s of opStates(entries).ops.values()) {
    if (s.outcome?.type !== 'committed' || s.pending.kind !== 'TENANT') continue;
    accepted.add(s.pending.tenant.slug);
    if (!sameLedger || s.outcome.seq <= setLedger.seq) before.add(s.pending.tenant.slug);
  }
  return { accepted, before };
}

export type DecryptStatus = 'ok' | 'key_destroyed' | 'failed' | 'empty';
/** `keys verify-decrypt`'s report: per tenant slug. */
export type DecryptReport = Readonly<Record<string, { readonly status: DecryptStatus; readonly sampled: number }>>;

export interface TenantFacts {
  readonly slug: string;
  readonly chain: { readonly seq: string; readonly hash: string } | null;
  readonly counts: Readonly<Record<string, string>>;
}
/** `keys backup-facts`'s report, as the manifest records it. */
export interface Facts {
  readonly platform: { readonly lsn: string; readonly chain: { readonly seq: string; readonly hash: string } | null; readonly counts: Readonly<Record<string, string>> };
  readonly tenants: Readonly<Record<string, TenantFacts>>;
}

/** B-7, B2-9: every count the manifest holds, compared exactly; a table missing on either side counts as a mismatch. */
export function countProblems(want: Facts, got: Facts): string[] {
  const problems: string[] = [];
  const compare = (where: string, a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>) => {
    for (const t of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort())
      if (a[t] !== b[t]) problems.push(`${where}: ${t} has ${b[t] ?? 'no table'} rows, the set recorded ${a[t] ?? 'no table'}`);
  };
  compare('platform', want.platform.counts, got.platform.counts);
  for (const [id, t] of Object.entries(want.tenants)) {
    const g = got.tenants[id];
    if (!g) problems.push(`tenant ${t.slug}: in the set's facts, not restored`);
    else compare(`tenant ${t.slug}`, t.counts, g.counts);
  }
  for (const [id, g] of Object.entries(got.tenants)) if (!want.tenants[id]) problems.push(`tenant ${g.slug}: restored, but not in the set's facts`);
  return problems;
}

/** The checkpoint `keys verify-chains --checkpoint-stdin` holds the restored chains to (D12). */
export const checkpointOf = (f: Facts) => ({
  platform: f.platform.chain,
  tenants: Object.fromEntries(Object.entries(f.tenants).map(([id, t]) => [id, { chain: t.chain }])),
});

/**
 * Before recovery (the control, D11). `destroyedBefore`: the slugs whose destruction the set's own ledger copy already
 * records, the only tenants allowed to be key_destroyed in the set.
 */
export function controlProblems(r: DecryptReport, opts: { readonly destroyedBefore: ReadonlySet<string>; readonly drill?: string }): string[] {
  const problems: string[] = [];
  for (const [slug, v] of Object.entries(r)) {
    if (v.status === 'failed') problems.push(`${slug}: its values do not decrypt before recovery (${String(v.sampled)} sampled)`);
    else if (v.status === 'key_destroyed' && !opts.destroyedBefore.has(slug)) problems.push(`${slug}: key_destroyed before recovery, with no destruction recorded before the set was taken`);
  }
  if (opts.drill !== undefined) {
    const d = r[opts.drill];
    if (!d) problems.push(`the drill tenant ${opts.drill} is not in the restored set: the set was taken before it existed`);
    else if (d.status !== 'ok') problems.push(`the drill tenant ${opts.drill} is ${d.status} before recovery: the set never held its keys, so the drill proves nothing (D11)`);
  }
  return problems;
}

/**
 * After recovery. `accepted`: every tenant with an accepted destruction in the ledger recovery used. Each of those is
 * key_destroyed (or empty: nothing left to sample, except the drill tenant, which has values); every other tenant is
 * exactly as before. A tenant can't appear or vanish.
 */
export function afterProblems(before: DecryptReport, after: DecryptReport, opts: { readonly accepted: ReadonlySet<string>; readonly drill?: string }): string[] {
  const problems: string[] = [];
  for (const slug of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    const b = before[slug];
    const a = after[slug];
    if (!a || !b) {
      problems.push(`${slug}: ${a ? 'appeared' : 'vanished'} during recovery`);
      continue;
    }
    if (opts.accepted.has(slug)) {
      const ok = a.status === 'key_destroyed' || (a.status === 'empty' && slug !== opts.drill);
      if (!ok) problems.push(`${slug}: its destruction was accepted, yet after recovery it is ${a.status}: a restore brought its data back into use`);
    } else if (a.status !== b.status) problems.push(`${slug}: ${b.status} before recovery, ${a.status} after: recovery changed a tenant it had no destruction for`);
  }
  if (opts.drill !== undefined && !opts.accepted.has(opts.drill)) problems.push(`the drill tenant ${opts.drill} has no accepted destruction in the ledger`);
  return problems;
}
