// Test helper (never used by the stack): an in-memory platform database with the keys CLI's semantics, for the
// protocol's crash-injection tests (D13, BK11). It mirrors the real one: idempotent by op (a repeat is answered from
// its row, a mismatch refused as a conflict), preconditions re-checked in the "transaction", the row, its audit event
// and the keys' states. The integration test runs the same protocol against the real CLI and database.
import type { DestructionKind, Entry } from './chain.js';
import type { CheckResult, DestroyOutcome, Evidence, EvidenceRow, KeysDb, KeyState, ReapplyOutcome } from './protocol.js';

interface Key {
  status: 'ACTIVE' | 'RETIRED' | 'DESTROYED';
  wrapErased: boolean;
  /** D15 decided: true when a retired version may be destroyed now. */
  eligible: boolean;
}
interface Tenant {
  readonly id: string;
  readonly slug: string;
  keys: Map<number, Key>;
}
interface State {
  tenants: Map<string, Tenant>;
  rows: Map<string, EvidenceRow>;
  audits: Map<string, NonNullable<EvidenceRow['audit']>>;
  seq: number;
}

const clone = (s: State): State => ({
  tenants: new Map([...s.tenants].map(([id, t]) => [id, { ...t, keys: new Map([...t.keys].map(([v, k]) => [v, { ...k }])) }])),
  rows: new Map(s.rows),
  audits: new Map(s.audits),
  seq: s.seq,
});

export type Fault = 'lost-before-commit' | 'commit-then-lost' | 'evidence-fails';

export class FakeKeysDb implements KeysDb {
  private s: State = { tenants: new Map(), rows: new Map(), audits: new Map(), seq: 0 };
  readonly calls: string[] = [];
  readonly audited: string[] = [];
  readonly bucket: Entry[] = [];
  /** The next destroy (or evidence) misbehaves this way, once. */
  fault: Fault | null = null;

  addTenant(id: string, slug: string, keys: Record<number, 'ACTIVE' | 'RETIRED' | 'DESTROYED'>, eligible: readonly number[] = []): void {
    this.s.tenants.set(id, { id, slug, keys: new Map(Object.entries(keys).map(([v, status]) => [Number(v), { status, wrapErased: status === 'DESTROYED', eligible: eligible.includes(Number(v)) }])) });
  }
  /** The state as a backup would hold it. */
  snapshot(): State {
    return clone(this.s);
  }
  /** Total stack loss: the platform DB replaced by an older backup's state. */
  restore(state: State): void {
    this.s = clone(state);
  }
  keysOf(tenantId: string): Record<number, string> {
    return Object.fromEntries([...(this.s.tenants.get(tenantId)?.keys ?? new Map<number, Key>())].map(([v, k]) => [v, k.status]));
  }
  rowOf(op: string): EvidenceRow | undefined {
    return this.s.rows.get(op);
  }
  /** A row as tampering (or a bug) would leave it, for the conflicting-evidence cases. */
  forgeRow(row: EvidenceRow, audit: EvidenceRow['audit'] = null): void {
    this.s.rows.set(row.op, row);
    if (audit) this.s.audits.set(row.auditSeq, audit);
  }
  setKey(tenantId: string, version: number, k: Partial<Key>): void {
    const key = this.s.tenants.get(tenantId)?.keys.get(version);
    if (key) Object.assign(key, k);
  }

  private bySlug(slug: string): Tenant | undefined {
    return [...this.s.tenants.values()].find((t) => t.slug === slug);
  }

  check(slug: string, version?: number): Promise<CheckResult> {
    this.calls.push(`check:${slug}`);
    const t = this.bySlug(slug);
    if (!t) return Promise.resolve({ eligible: false, why: 'no_tenant' });
    const keys = [...t.keys].map(([v, k]) => ({ version: v, status: k.status }));
    if (version === undefined) {
      const live = [...t.keys].filter(([, k]) => k.status !== 'DESTROYED').map(([v]) => v);
      return Promise.resolve(live.length ? { eligible: true, tenantId: t.id, kind: 'TENANT', versions: live, preconditions: { keys } } : { eligible: false, why: 'nothing_to_destroy' });
    }
    const k = t.keys.get(version);
    if (k?.status !== 'RETIRED') return Promise.resolve({ eligible: false, why: 'not_retired' });
    if (!k.eligible) return Promise.resolve({ eligible: false, why: 'sweep_pending' });
    return Promise.resolve({ eligible: true, tenantId: t.id, kind: 'RETIRED', versions: [version], preconditions: { keys } });
  }

  private record(op: string, t: Tenant, kind: DestructionKind, versions: number[], action: string): EvidenceRow {
    const auditSeq = String(++this.s.seq);
    const row: EvidenceRow = { op, tenantId: t.id, kind, versions, destroyedAt: new Date().toISOString(), auditSeq, audit: { action, tenantId: t.id, op, versions } };
    this.s.audits.set(auditSeq, { action, tenantId: t.id, op, versions });
    this.s.rows.set(op, row);
    return row;
  }

  destroy(op: string, slug: string, version?: number): Promise<DestroyOutcome> {
    this.calls.push(`destroy:${op}`);
    const fault = this.fault;
    this.fault = null;
    const t = this.bySlug(slug);
    if (!t) return Promise.resolve({ outcome: 'refused', why: 'no_tenant' });
    const kind: DestructionKind = version === undefined ? 'TENANT' : 'RETIRED';
    const prior = this.s.rows.get(op);
    if (prior) {
      const same = prior.tenantId === t.id && prior.kind === kind && (kind === 'TENANT' || prior.versions.join() === String(version));
      if (!same) return Promise.resolve({ outcome: 'refused', why: 'conflict' });
      return Promise.resolve(committed(prior, t.id));
    }
    if (fault === 'lost-before-commit') return Promise.resolve({ outcome: 'unknown', detail: 'the client died before the commit' });
    let versions: number[];
    if (kind === 'TENANT') {
      versions = [...t.keys].filter(([, k]) => k.status !== 'DESTROYED').map(([v]) => v);
      if (!versions.length) return Promise.resolve({ outcome: 'refused', why: 'nothing_to_destroy' });
    } else {
      const k = t.keys.get(version ?? 0);
      if (k?.status !== 'RETIRED') return Promise.resolve({ outcome: 'refused', why: 'not_retired' });
      if (!k.eligible) return Promise.resolve({ outcome: 'refused', why: 'sweep_pending' });
      versions = [version ?? 0];
    }
    for (const v of versions) Object.assign(t.keys.get(v) ?? {}, { status: 'DESTROYED', wrapErased: true });
    const row = this.record(op, t, kind, versions, 'crypto.tenant_key.destroyed');
    if (fault === 'commit-then-lost') return Promise.resolve({ outcome: 'unknown', detail: 'the client died after the commit' });
    return Promise.resolve(committed(row, t.id));
  }

  evidence(tenantIds: readonly string[]): Promise<Evidence> {
    this.calls.push('evidence');
    if (this.fault === 'evidence-fails') {
      this.fault = null;
      return Promise.reject(new Error('the keys job failed'));
    }
    const ids = new Set([...[...this.s.rows.values()].map((r) => r.tenantId), ...tenantIds]);
    const tenants: Record<string, KeyState[]> = {};
    for (const id of ids) tenants[id] = [...(this.s.tenants.get(id)?.keys ?? new Map<number, Key>())].map(([version, k]) => ({ version, status: k.status, wrapErased: k.wrapErased }));
    const rows = [...this.s.rows.values()].map((r) => ({ ...r, audit: this.s.audits.get(r.auditSeq) ?? null }));
    return Promise.resolve({ rows, tenants });
  }

  reapply(op: string, tenantId: string, kind: DestructionKind, versions: readonly number[]): Promise<ReapplyOutcome> {
    this.calls.push(`reapply:${op}`);
    const t = this.s.tenants.get(tenantId);
    if (!t) return Promise.resolve({ outcome: 'refused', why: 'no_tenant' });
    const prior = this.s.rows.get(op);
    if (prior && (prior.tenantId !== tenantId || prior.kind !== kind || prior.versions.join() !== versions.join())) return Promise.resolve({ outcome: 'refused', why: 'conflict' });
    const targets = [...t.keys].filter(([v, k]) => k.status !== 'DESTROYED' && (kind === 'TENANT' || versions.includes(v)));
    const activeDestroyed = targets.some(([, k]) => k.status === 'ACTIVE');
    for (const [, k] of targets) Object.assign(k, { status: 'DESTROYED', wrapErased: true });
    if (!prior) this.record(op, t, kind, [...versions], 'crypto.tenant_key.reapplied');
    return Promise.resolve({ outcome: 'reapplied', destroyed: targets.map(([v]) => v), recorded: !prior, activeDestroyed, forget: [] });
  }

  audit(action: string): Promise<void> {
    this.audited.push(action);
    return Promise.resolve();
  }

  copyToBucket(_ledgerId: string, entries: readonly Entry[]): Promise<string | null> {
    this.bucket.push(...entries);
    return Promise.resolve(null);
  }
}

const committed = (row: EvidenceRow, tenantId: string): DestroyOutcome => ({
  outcome: 'committed',
  tenantId,
  kind: row.kind,
  versions: row.versions,
  destroyedAt: row.destroyedAt,
  auditSeq: row.auditSeq,
  forget: [],
});
