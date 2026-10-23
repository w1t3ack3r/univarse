// Spec 0020 (the bucket copy's fix): `pnpm stack:bucket-check`, each check's PASS and FAIL, against a fake S3 that
// models the bucket, its object lock and each identity's permissions. The same checks run against the real SeaweedFS
// in bucket.int.ts.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { objectKey } from '../../../apps/api/src/cli/ledger-copy.js';
import { bucketCheck, type BucketCheckInput } from './bucket-check.js';
import { canonical, nextEntry, type Entry } from './ledger/chain.js';

const LEDGER = randomUUID();
const DIR = 'gen-0001';
const BUCKET = 'uv-shred-ledger';
const SECRET = 'SECRET-never-printed-0123456789';

function chain(n: number): Entry[] {
  const out: Entry[] = [nextEntry(null, { type: 'genesis', ledgerId: LEDGER, generation: 1, destinations: [{ id: 'primary', path: '/l' }] })];
  for (let i = 1; i < n; i++) out.push(nextEntry(out[i - 1] ?? null, { type: 'audited', attempt: randomUUID(), auditSeq: String(i) }));
  return out;
}

interface Obj {
  body: string;
  lastModified: Date;
  retention: { Mode: string; RetainUntilDate: Date } | null;
  versionId: string;
}
const s3Error = (name: string, status: number) => Object.assign(new Error(`${name}: ${SECRET}`), { name, $metadata: { httpStatusCode: status } });

/** What the fake lets the ledger identity do, and the bucket's state; the defaults are the fixed stack's. */
interface World {
  objects: Map<string, Obj>;
  others: Map<string, Set<string>>;
  lockEnabled: boolean;
  ledgerCan: Set<'list' | 'read' | 'list-other' | 'write-other' | 'delete'>;
  appCanRead: boolean;
  appCanDelete: boolean;
  ledgerDenial: number;
}
function world(entries: readonly Entry[], over: Partial<World> = {}): World {
  const written = new Date('2026-10-23T12:00:00Z');
  const until = new Date(written);
  until.setUTCFullYear(until.getUTCFullYear() + 10);
  const objects = new Map(entries.map((e) => [objectKey(LEDGER, DIR, e), { body: `${canonical(e)}\n`, lastModified: written, retention: { Mode: 'COMPLIANCE', RetainUntilDate: until }, versionId: randomUUID() }]));
  return { objects, others: new Map([['uv-quarantine', new Set()], ['uv-clean', new Set()]]), lockEnabled: true, ledgerCan: new Set(), appCanRead: true, appCanDelete: false, ledgerDenial: 403, ...over };
}

type Cmd = { constructor: { name: string }; input: Record<string, unknown> };
function client(w: World, who: 'app' | 'ledger'): BucketCheckInput['app'] {
  const send = (cmd: Cmd): unknown => {
    const { Bucket, Key, VersionId, Prefix } = cmd.input as { Bucket: string; Key?: string; VersionId?: string; Prefix?: string };
    const can = (what: 'list' | 'read' | 'list-other' | 'write-other' | 'delete') => who === 'app' || w.ledgerCan.has(what);
    const refuse = () => {
      throw s3Error('AccessDenied', who === 'ledger' ? w.ledgerDenial : 403);
    };
    const mine = Bucket === BUCKET;
    switch (cmd.constructor.name) {
      case 'ListObjectsV2Command':
        if (mine ? !can('list') || (who === 'app' && !w.appCanRead) : !can('list-other')) refuse();
        return mine ? { Contents: [...w.objects].filter(([k]) => k.startsWith(Prefix ?? '')).map(([k, o]) => ({ Key: k, LastModified: o.lastModified })), IsTruncated: false } : { Contents: [] };
      case 'GetObjectCommand': {
        if (!can('read') || (who === 'app' && !w.appCanRead)) refuse();
        const o = w.objects.get(Key ?? '');
        if (!o) throw s3Error('NoSuchKey', 404);
        return { Body: { transformToString: () => Promise.resolve(o.body) } };
      }
      case 'GetObjectLockConfigurationCommand':
        return { ObjectLockConfiguration: w.lockEnabled ? { ObjectLockEnabled: 'Enabled' } : {} };
      case 'GetObjectRetentionCommand':
        return { Retention: w.objects.get(Key ?? '')?.retention ?? undefined };
      case 'PutObjectCommand':
        if (mine || !can('write-other')) refuse();
        w.others.get(Bucket)?.add(Key ?? '');
        return {};
      case 'ListObjectVersionsCommand':
        return { Versions: [...w.objects].filter(([k]) => k.startsWith(Prefix ?? '')).map(([k, o]) => ({ Key: k, VersionId: o.versionId })) };
      case 'DeleteObjectCommand':
        if (!mine) {
          w.others.get(Bucket)?.delete(Key ?? '');
          return {};
        }
        if (who === 'app' ? !w.appCanDelete : !can('delete')) refuse();
        for (const [k, o] of w.objects) if (k === Key && o.versionId === VersionId) w.objects.delete(k);
        return {};
      default:
        throw new Error(`the fake doesn't model ${cmd.constructor.name}`);
    }
  };
  return { send: (cmd: unknown) => Promise.resolve().then(() => send(cmd as Cmd)) } as BucketCheckInput['app'];
}

const run = (entries: readonly Entry[], w: World, opts: { tryDelete?: boolean; disk?: readonly Entry[] } = {}) =>
  bucketCheck({ ledger: { ledgerId: LEDGER, dir: DIR, entries: opts.disk ?? entries }, app: client(w, 'app'), ledgerIdentity: client(w, 'ledger'), tryDelete: opts.tryDelete ?? false });
const fails = (lines: readonly string[]) => lines.filter((l) => l.startsWith('FAIL'));

describe('[A2-10] pnpm stack:bucket-check', () => {
  const entries = chain(3);

  it('[A2-10] the fixed stack: every check passes, PASS and FAIL lines only', async () => {
    const lines = await run(entries, world(entries));
    expect(fails(lines)).toEqual([]);
    expect(lines.every((l) => /^(PASS|FAIL) /.test(l))).toBe(true);
    expect(lines).toEqual([
      'PASS the app identity can list and read uv-shred-ledger (ledger-bucket-read)',
      `PASS ledger ${LEDGER} (gen-0001): the bucket holds its chain from the genesis, seq 1 to 3, with no gap`,
      'PASS every entry on disk (3) is in the bucket, matching',
      'PASS object lock is enabled on uv-shred-ledger',
      'PASS every copied entry (3) is retained in COMPLIANCE mode for 10 years',
      "PASS the ledger identity can't list uv-shred-ledger",
      "PASS the ledger identity can't read uv-shred-ledger",
      "PASS the ledger identity can't list uv-quarantine",
      "PASS the ledger identity can't write uv-quarantine",
      "PASS the ledger identity can't list uv-clean",
      "PASS the ledger identity can't write uv-clean",
    ]);
  });

  it('[A2-10] the empty bucket (the bug): its genesis missing, every entry missing, no retention to check', async () => {
    const lines = fails(await run(entries, world(entries, { objects: new Map() })));
    expect(lines).toEqual([
      `FAIL ledger ${LEDGER} (gen-0001): its genesis is not in the bucket`,
      'FAIL 3 of 3 entries on disk are not in the bucket: seq 1, 2, 3',
      'FAIL no copied entry to check the retention of',
    ]);
  });

  it('[A2-10] an entry on disk not copied, and a gap in the bucket\'s chain', async () => {
    const w = world(entries);
    w.objects.delete(objectKey(LEDGER, DIR, entries[1] as Entry));
    expect(fails(await run(entries, w))).toEqual([`FAIL ledger ${LEDGER} (gen-0001): the bucket's chain has gaps at seq 2`, 'FAIL 1 of 3 entries on disk are not in the bucket: seq 2']);
  });

  it('[A2-10] the last entry on disk not copied yet: no gap, but it is missing', async () => {
    const w = world(entries.slice(0, 2));
    expect(fails(await run(entries, w))).toEqual(['FAIL 1 of 3 entries on disk are not in the bucket: seq 3']);
  });

  it('[A2-10] an object whose content differs from the disk', async () => {
    const w = world(entries);
    const o = w.objects.get(objectKey(LEDGER, DIR, entries[2] as Entry));
    if (o) o.body = '{"edited":true}\n';
    expect(fails(await run(entries, w))).toEqual(["FAIL 1 entries in the bucket don't match the disk (or can't be read): seq 3"]);
  });

  it('[A2-10] object lock off', async () => {
    expect(fails(await run(entries, world(entries, { lockEnabled: false })))).toEqual(['FAIL object lock is not enabled on uv-shred-ledger']);
  });

  it('[A2-10] an entry retained in GOVERNANCE mode, one retained for 9 years, and one with no retention', async () => {
    const w = world(entries);
    const [a, b, c] = entries.map((e) => w.objects.get(objectKey(LEDGER, DIR, e)));
    if (a?.retention) a.retention = { ...a.retention, Mode: 'GOVERNANCE' };
    if (b?.retention) b.retention = { Mode: 'COMPLIANCE', RetainUntilDate: new Date('2035-10-23T12:00:00Z') };
    if (c) c.retention = null;
    expect(fails(await run(entries, w))).toEqual(['FAIL 3 of 3 entries are not retained in COMPLIANCE mode for 10 years: seq 1, 2, 3']);
  });

  it('[A2-10] a retention a day short of 10 years still passes (the job\'s clock); two days short fails', async () => {
    for (const [days, ok] of [
      [0.5, true],
      [2, false],
    ] as const) {
      const w = world(entries);
      for (const o of w.objects.values()) if (o.retention) o.retention.RetainUntilDate = new Date(o.retention.RetainUntilDate.getTime() - days * 86_400_000);
      expect([days, fails(await run(entries, w)).length === 0]).toEqual([days, ok]);
    }
  });

  it('[A2-10] each thing the ledger identity must not do, allowed in turn, fails its own line; an accepted probe write is removed again', async () => {
    const cases = [
      ['list', ['FAIL the ledger identity can list uv-shred-ledger']],
      ['read', ['FAIL the ledger identity can read uv-shred-ledger']],
      ['list-other', ['FAIL the ledger identity can list uv-quarantine', 'FAIL the ledger identity can list uv-clean']],
      ['write-other', ['FAIL the ledger identity can write uv-quarantine', 'FAIL the ledger identity can write uv-clean']],
    ] as const;
    for (const [what, expected] of cases) {
      const w = world(entries, { ledgerCan: new Set([what]) });
      expect([what, fails(await run(entries, w))]).toEqual([what, expected]);
      for (const keys of w.others.values()) expect(keys.size).toBe(0);
    }
  });

  it('[A2-10] a refusal must be a refusal (403): another error is not taken for one', async () => {
    const lines = fails(await run(entries, world(entries, { ledgerDenial: 500 })));
    expect(lines).toHaveLength(6);
    expect(lines[0]).toBe("FAIL the ledger identity's attempt to list uv-shred-ledger failed, but not as refused: AccessDenied (500)");
  });

  it('[A3-5] the app identity unable to read the bucket fails (the waiver reads it), and nothing is compared through it', async () => {
    expect(await run(entries, world(entries, { appCanRead: false }))).toEqual(["FAIL the app identity can't list or read uv-shred-ledger, so nothing else can be checked: AccessDenied (403)"]);
  });

  it('[A2-10] the ledger on disk unreadable: one FAIL, nothing compared', async () => {
    const w = world(entries);
    expect(await bucketCheck({ ledger: { problem: 'the primary copy is missing' }, app: client(w, 'app'), ledgerIdentity: client(w, 'ledger') })).toEqual([
      "FAIL the ledger on disk can't be read, so there is nothing to compare: the primary copy is missing",
    ]);
  });

  it('[A2-10] --try-delete only when asked: a locked version survives both identities; one that can be deleted fails', async () => {
    const quiet = await run(entries, world(entries));
    expect(quiet.some((l) => l.includes('delete'))).toBe(false);
    const locked = await run(entries, world(entries), { tryDelete: true });
    expect(locked.slice(-2)).toEqual(["PASS the app identity can't delete a locked version", "PASS the ledger identity can't delete a locked version"]);
    const unlocked = world(entries, { appCanDelete: true });
    expect((await run(entries, unlocked, { tryDelete: true })).slice(-1)).toEqual(["FAIL the app identity deleted a locked version (the genesis's)"]);
  });

  it('[LS9] an error\'s message (which could echo a request) is never printed: its name and status only', async () => {
    const lines = [
      ...(await run(entries, world(entries, { ledgerDenial: 500 }))),
      ...(await run(entries, world(entries, { appCanRead: false }))),
    ];
    expect(lines.join('\n')).not.toContain(SECRET);
  });
});
