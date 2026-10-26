// Spec 0020 B2-12: `pnpm stack:restore`, the real one, for a real disaster. Never run in a drill (D9). Before anything is
// replaced it refuses unless the stack is down and the disk holds a copy of its data; then it keeps what it replaces:
//   - each data volume (pgdata, vault-raft, seaweedfs-data) copied whole into `<volume>-before-restore-<time>`;
//   - the stack directory moved to `stack.before-restore-<time>`, and the set's own parts written in its place.
// Only then are the three data volumes emptied for the restore. Nothing is deleted: removing the copies is the owner's
// step, as with the old Vault file storage. It ends by naming the deploy command for the set's release.
import { THIRD_PARTY } from '../config.js';
import type { Runner } from '../docker.js';
import type { DataVolumes } from './target.js';

export const CONFIRMATION = "replace the stack's data";

export interface RealRestoreIo {
  readonly run: Runner;
  /** Whether any of the stack project's containers runs (it must be down). */
  stackRunning(): boolean;
  /** The stack directory moved aside and the set's parts written in its place, owner-only. */
  replaceStackDir(stamp: string, parts: readonly { name: string; data: Buffer }[]): void;
  log(line: string): void;
}

const tool = (vols: string[], script: string) => ['run', '--rm', '--network', 'none', '--user', '0:0', '--label', 'univarse.restore=1', ...vols.flatMap((v) => ['-v', v]), '--entrypoint', 'sh', THIRD_PARTY.postgres, '-c', script];

/** Bytes used by a volume, and free on the file system that holds it (the Docker VM's disk). */
function sizes(run: Runner, volume: string): { used: number; free: number } {
  const r = run(tool([`${volume}:/v:ro`], 'du -sb /v | cut -f1; df -P -B1 /v | tail -1 | tr -s " " | cut -d" " -f4'), { allowFail: true });
  const [used, free] = r.stdout.trim().split('\n').map(Number);
  if (r.status !== 0 || !Number.isFinite(used) || !Number.isFinite(free)) throw new Error(`the size of ${volume} could not be read`);
  return { used: used ?? 0, free: free ?? 0 };
}

export function prepareRealRestore(data: DataVolumes, parts: readonly { name: string; data: Buffer }[], now: Date, io: RealRestoreIo): string[] {
  if (io.stackRunning()) return ['the stack is running: stop it first (`pnpm stack:down`); a restore never replaces data under a running stack'];
  const volumes = [data.pgdata, data.vaultRaft, data.seaweedfsData];
  for (const v of volumes) if (io.run(['volume', 'inspect', v], { allowFail: true }).status !== 0) return [`the stack has no volume ${v}: this isn't the stack the set came from, or it was never deployed`];
  const s = volumes.map((v) => sizes(io.run, v));
  const need = s.reduce((a, x) => a + x.used, 0);
  const free = Math.min(...s.map((x) => x.free));
  if (need > free) return [`the copies of the stack's data need ${(need / 1e9).toFixed(2)} GB, and Docker's disk has ${(free / 1e9).toFixed(2)} GB free: free some space first`];
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z').toLowerCase();
  for (const v of volumes) {
    const copy = `${v}-before-restore-${stamp}`;
    if (io.run(['volume', 'inspect', copy], { allowFail: true }).status === 0) return [`${copy} exists already: nothing replaced`];
    io.run(['volume', 'create', copy]);
    io.run(tool([`${v}:/s:ro`, `${copy}:/d`], 'cp -a /s/. /d/'));
    io.log(`kept: ${v} copied to ${copy}`);
  }
  io.replaceStackDir(stamp, parts);
  io.log(`kept: the stack directory moved to stack.before-restore-${stamp}; the set's own parts are in its place`);
  for (const v of volumes) io.run(tool([`${v}:/v`], 'find /v -mindepth 1 -delete'));
  return [];
}

/** What a real restore prints at its end: the owner deploys the set's own release; the restore doesn't. */
export const afterRestore = (record: string) => [
  'the stack\'s data volumes now hold the restored set. Nothing is running.',
  `next: \`pnpm stack:vault unseal\` if asked, then \`pnpm stack:deploy ${record}\` (the set's release).`,
  'the copies made before the restore are kept (`docker volume ls --filter name=before-restore`); removing them is your step, once the restored stack is verified.',
];
