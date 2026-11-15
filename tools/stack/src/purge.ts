// Spec 0038 Q9–Q14 (A7, A12, T36): `pnpm stack:purge <slug> [--solo --reason "…"]`, the owner's command on the host.
// It drives the `purge` job (the deployed API image, as the migrator, with the app's storage identity: Q-C2) and the
// key-destruction protocol (spec 0020, unchanged but for the purge's note on its ledger entry), one step at a time, in
// Q10's order: keys, rows, objects, platform, certificate. Each step is recorded once by the job, so a run stopped
// anywhere is resumed by running the command again. The certificate is written here, where the backups are, and its
// SHA-256 recorded on the platform. Exit 0 only when the purge is complete.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadSettings } from './backup/config.js';
import { planPrune } from './backup/prune.js';
import { listSets, type SetOnDisk } from './backup/set.js';
import { COMPOSE_FILE, PROJECT, STACK_DIR } from './config.js';
import { docker } from './docker.js';
import { deployedImages } from './ledger/job.js';
import { committedTenantDestruction, destroy, type Result } from './ledger/protocol.js';
import { PRIMARY, realProtocolDeps } from './keys.js';

export const PURGES_DIR = process.env.UNIVARSE_PURGES_DIR ?? join(homedir(), '.univarse', 'purges');
const JOB_TIMEOUT_MS = 15 * 60_000;
const DAY = 86_400_000;

/** One run of the purge job: its exit status and its last JSON line (null when there is none). */
export interface JobRun {
  readonly status: number | null;
  readonly json: Record<string, unknown> | null;
  readonly error: string;
}

export interface PurgeDeps {
  /** Runs `purge <command> <slug> …` in the job; `input` goes to its stdin. */
  job(args: readonly string[], input?: string): JobRun;
  /** The key-destruction protocol (stack:keys destroy), with the purge's note. */
  destroyKeys(slug: string, purge: { approvalId: string | null; solo: boolean }): Promise<Result>;
  /** The ledger's committed destruction of every key of the tenant, if any (Q-C3's resume). */
  committedOp(tenantId: string): string | null;
  /** The backup sets on the destination now. */
  sets(): readonly SetOnDisk[];
  /** Writes the certificate's two files; returns their paths. */
  write(name: string, json: string, text: string): { json: string; text: string };
  log(line: string): void;
  now(): Date;
}

/**
 * Q-C6: when the last backup set taken before `purgedAt` is deleted, if a backup runs every day from now on: the
 * retention rule itself (planPrune) applied day by day to the sets there are plus one new set a day. Null if no set
 * holds the institution's data (none was taken before the purge).
 */
export function lastBackupGoneBy(sets: readonly SetOnDisk[], purgedAt: Date, now: Date): Date | null {
  const before = (s: SetOnDisk) => s.createdAt.getTime() <= purgedAt.getTime();
  let all = [...sets];
  if (!all.some(before)) return null;
  for (let day = 0; day <= 400; day++) {
    const at = new Date(now.getTime() + day * DAY);
    if (day > 0) {
      const id = `${at.toISOString().replace(/[-:]/g, '').slice(0, 15)}Z-sim${String(day)}`;
      all.push({ setId: id, createdAt: at, index: { startWal: '000000010000000000000001' } as SetOnDisk['index'] });
    }
    const plan = planPrune(all, at);
    const gone = new Set(plan.deleteSets);
    all = all.filter((s) => !gone.has(s.setId));
    if (!all.some(before)) return at;
  }
  return new Date(now.getTime() + 400 * DAY);
}

const ok = (r: JobRun, what: string): Record<string, unknown> => {
  if (r.status === 0 && r.json?.ok === true) return r.json;
  if (r.status === 3 && r.json) throw new Error(`refused at ${what}: ${String(r.json.refused)}`);
  throw new Error(`the purge job's ${what} failed (exit ${r.status === null ? 'none' : String(r.status)}${r.error ? `: ${r.error}` : ''}); run the command again to resume`);
};

/** The certificate's plain-text rendering: what was destroyed, when, by whose authority, and when the last copy goes. */
export function certificateText(c: Record<string, unknown>): string {
  const f = c as {
    institution: { id: string; slug: string; legalName: string; type: string };
    authority: { solo: boolean; reason?: string | null; askedBy?: string | null; approvedBy?: string | null; approvedAt?: string | null; approvalId?: string | null };
    keys: { op: string | null; destroyedAt: string | null };
    rows: { deletedAt: string | null; perTable: Record<string, number> | null };
    objects: { deletedAt: string | null; perBucket: Record<string, number> | null };
    platform: { deletedAt: string | null; perTable: Record<string, number> | null };
    completedAt: string;
    lastBackupGoneBy: string | null;
  };
  const sum = (o: Record<string, number> | null) => Object.values(o ?? {}).reduce((a, b) => a + b, 0);
  const lines = [
    'CERTIFICATE OF DELETION',
    '',
    `Institution: ${f.institution.legalName} (${f.institution.slug}, ${f.institution.type}), id ${f.institution.id}`,
    f.authority.solo
      ? `Authority: one person (solo), because no second person could approve it. Reason: ${f.authority.reason ?? ''}`
      : `Authority: asked by ${f.authority.askedBy ?? 'a former member'} and approved by ${f.authority.approvedBy ?? 'a former member'} on ${f.authority.approvedAt ?? ''} (approval ${f.authority.approvalId ?? ''})`,
    '',
    `1. Encryption keys: every data key destroyed at ${f.keys.destroyedAt ?? ''} (shred ledger op ${f.keys.op ?? ''}). Every later restore of any backup re-destroys them.`,
    `2. Records: ${String(sum(f.rows.perTable))} rows deleted at ${f.rows.deletedAt ?? ''}, its audit trail included.`,
    ...Object.entries(f.rows.perTable ?? {}).map(([t, n]) => `     ${t}: ${String(n)}`),
    `3. Files: ${String(sum(f.objects.perBucket))} stored objects deleted at ${f.objects.deletedAt ?? ''}.`,
    `4. Platform records: ${String(sum(f.platform.perTable))} rows deleted at ${f.platform.deletedAt ?? ''}; the institution's entry remains as a closed record, its address reserved for good.`,
    '',
    `Completed: ${f.completedAt}`,
    f.lastBackupGoneBy
      ? `Backups: sets taken before the deletion still hold its records and files, unreadable for want of its keys. With daily backups, the last of them is deleted by ${f.lastBackupGoneBy}.`
      : 'Backups: no backup set taken before the deletion holds its data.',
    '',
  ];
  return lines.join('\r\n');
}

/** The whole purge, resuming where it stopped. */
export async function purge(deps: PurgeDeps, req: { slug: string; solo: boolean; reason?: string }): Promise<{ ok: boolean; lines: string[] }> {
  const lines: string[] = [];
  const say = (l: string) => {
    lines.push(l);
    deps.log(l);
  };
  const flags = req.solo ? ['--solo', '--reason', req.reason ?? ''] : [];
  const checked = ok(deps.job(['check', req.slug, ...flags]), 'check');
  const tenantId = String(checked.tenantId);
  if (checked.resuming) say(`${req.slug}: resuming its purge at the ${typeof checked.next === 'string' ? checked.next : 'final'} step`);
  ok(deps.job(['begin', req.slug, ...flags]), 'begin');
  const facts0 = ok(deps.job(['facts', req.slug]), 'facts').facts as { authority: { solo: boolean; approvalId?: string | null }; keys: { op: string | null } };

  // 1. keys: the protocol, unless it already committed for this institution (a run that stopped before recording it).
  if (!facts0.keys.op) {
    let op = deps.committedOp(tenantId);
    if (!op) {
      const r = await deps.destroyKeys(req.slug, { approvalId: facts0.authority.approvalId ?? null, solo: facts0.authority.solo });
      for (const l of r.lines) say(`keys: ${l}`);
      if (!r.ok || !r.op) return { ok: false, lines: [...lines, 'stopped: the keys were not destroyed; nothing else was touched. Run the command again once the protocol says why.'] };
      op = r.op;
    } else say(`keys: already destroyed (op ${op}), recording it`);
    ok(deps.job(['keys-done', req.slug, '--op', op]), 'keys');
  }
  say(`${req.slug}: keys destroyed`);
  // 2–4: rows, objects, platform; each a no-op if done.
  const rows = ok(deps.job(['rows', req.slug]), 'rows');
  say(`${req.slug}: rows deleted (${JSON.stringify(rows.rows)})`);
  const objects = ok(deps.job(['objects', req.slug]), 'objects');
  say(`${req.slug}: stored objects deleted (${JSON.stringify(objects.objects)})`);
  ok(deps.job(['platform', req.slug]), 'platform');
  say(`${req.slug}: platform rows deleted; the institution is PURGED`);

  // 5. the certificate (Q12): from the records, with the backups' last date, written here, then its hash recorded.
  const facts = ok(deps.job(['facts', req.slug]), 'facts').facts as Record<string, unknown> & { platform: { deletedAt: string | null }; certificate: { sha256: string } | null };
  if (facts.certificate) {
    say(`${req.slug}: complete; its certificate's SHA-256 is ${facts.certificate.sha256}`);
    return { ok: true, lines };
  }
  const now = deps.now();
  const purgedAt = new Date(facts.platform.deletedAt ?? now.toISOString());
  const gone = lastBackupGoneBy(deps.sets(), purgedAt, now);
  const { certificate: _none, ...stated } = facts;
  const certificate = { format: 'univarse-purge-certificate-1', ...stated, completedAt: now.toISOString(), lastBackupGoneBy: gone ? gone.toISOString().slice(0, 10) : null };
  const json = `${JSON.stringify(certificate, null, 2)}\n`;
  const sha256 = createHash('sha256').update(json, 'utf8').digest('hex');
  const name = `${req.slug}-${now.toISOString().slice(0, 10)}`;
  const files = deps.write(name, json, certificateText(certificate));
  ok(deps.job(['finish', req.slug, '--sha256', sha256], json), 'certificate');
  say(`${req.slug}: complete. Certificate: ${files.json} and ${files.text} (SHA-256 ${sha256})`);
  return { ok: true, lines };
}

/** The `purge` job from the deployed images: its env file is purge.env, nothing else (Q-C2). */
function runJob(images: Readonly<Record<string, string>>, args: readonly string[], input?: string): JobRun {
  const name = `uv-purge-${String(Date.now())}`;
  const r = spawnSync('docker', ['compose', '-p', PROJECT, '-f', COMPOSE_FILE, '--profile', 'job', 'run', '--rm', '-T', '--name', name, 'purge', '--enable-source-maps', 'dist/cli/purge.js', ...args], {
    encoding: 'utf8',
    timeout: JOB_TIMEOUT_MS,
    ...(input === undefined ? {} : { input }),
    env: { ...process.env, MSYS_NO_PATHCONV: '1', UNIVARSE_STACK_DIR: STACK_DIR, ...images },
  });
  if (r.status !== 0 && r.status !== 3) docker(['rm', '-f', '-v', name], { allowFail: true });
  const last = r.stdout.trim().split('\n').at(-1) ?? '';
  let json: Record<string, unknown> | null;
  try {
    const v = JSON.parse(last) as unknown;
    json = typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    json = null;
  }
  return { status: r.error ? null : r.status, json, error: (r.stderr.trim().split('\n').at(-1) ?? '').slice(0, 200) };
}

export function realPurgeDeps(): PurgeDeps {
  const images = deployedImages();
  return {
    job: (args, input) => runJob(images, args, input),
    destroyKeys: (slug, p) => destroy(realProtocolDeps(images), { slug, purge: p }),
    committedOp: (tenantId) => committedTenantDestruction({ primary: PRIMARY }, tenantId),
    sets: () => listSets(loadSettings().destination),
    write: (name, json, text) => {
      mkdirSync(PURGES_DIR, { recursive: true, mode: 0o700 });
      const paths = { json: join(PURGES_DIR, `${name}.json`), text: join(PURGES_DIR, `${name}.txt`) };
      writeFileSync(paths.json, json, { mode: 0o600 });
      writeFileSync(paths.text, text, { mode: 0o600 });
      return paths;
    },
    log: (l) => console.log(`[stack:purge] ${l}`),
    now: () => new Date(),
  };
}

const USAGE = 'usage: pnpm stack:purge <slug> [--solo --reason "why one person"]';

export function parseArgs(argv: readonly string[]): { slug: string; solo: boolean; reason?: string } {
  const [slug, ...rest] = argv;
  if (!slug || slug.startsWith('-')) throw new Error(USAGE);
  let solo = false;
  let reason: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--solo') solo = true;
    else if (rest[i] === '--reason' && rest[i + 1] !== undefined) reason = rest[++i];
    else throw new Error(USAGE);
  }
  if (reason !== undefined && !solo) throw new Error(`${USAGE}\n--reason is for a solo purge; a two-person one carries its approval's`);
  return { slug, solo, ...(reason === undefined ? {} : { reason }) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const r = await purge(realPurgeDeps(), parseArgs(process.argv.slice(2)));
    if (!r.ok) for (const l of r.lines.slice(-1)) console.error(`[stack:purge] ${l}`);
    process.exit(r.ok ? 0 : 1);
  } catch (e) {
    console.error(`[stack:purge] ${(e as Error).message}`);
    process.exit(1);
  }
}
