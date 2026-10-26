// Spec 0020 B2-12: the real restore refuses a running stack, a missing volume and a disk too small, and keeps everything
// it replaces before replacing it (BK10: `stack:restore` without its copies).
import { describe, expect, it } from 'vitest';
import type { Runner } from '../docker.js';
import { prepareRealRestore, type RealRestoreIo } from './real-restore.js';
import { STACK_DATA } from './target.js';

const NOW = new Date('2026-10-26T09:30:00Z');
function io(over: { running?: boolean; missing?: string; used?: number; free?: number; copyExists?: boolean } = {}) {
  const calls: string[] = [];
  const run: Runner = (args) => {
    const a = args.join(' ');
    if (args[0] === 'volume' && args[1] === 'inspect') {
      const v = args[2] ?? '';
      const exists = v.includes('before-restore') ? over.copyExists === true : v !== over.missing;
      return { status: exists ? 0 : 1, stdout: '', stderr: '' };
    }
    calls.push(a.includes('du -sb') ? `size ${args.find((x) => x.endsWith(':/v:ro')) ?? ''}` : a.includes('cp -a') ? `copy ${args.find((x) => x.endsWith(':/d')) ?? ''}` : a.includes('-delete') ? `empty ${args.find((x) => x.endsWith(':/v')) ?? ''}` : a);
    return { status: 0, stdout: a.includes('du -sb') ? `${String(over.used ?? 1000)}\n${String(over.free ?? 1e9)}\n` : '', stderr: '' };
  };
  const x: RealRestoreIo = {
    run,
    stackRunning: () => over.running === true,
    replaceStackDir: (stamp) => calls.push(`stack dir aside ${stamp}`),
    log: () => undefined,
  };
  return { x, calls };
}

describe('[B2-12] the real restore\'s preparation', () => {
  it('copies each data volume aside, then moves the stack directory, and only then empties the volumes', () => {
    const { x, calls } = io();
    expect(prepareRealRestore(STACK_DATA, [], NOW, x)).toEqual([]);
    const s = '20261026t093000z';
    expect(calls.filter((c) => !c.startsWith('size'))).toEqual([
      `volume create univarse-stack_pgdata-before-restore-${s}`,
      `copy univarse-stack_pgdata-before-restore-${s}:/d`,
      `volume create univarse-stack-vault-raft-before-restore-${s}`,
      `copy univarse-stack-vault-raft-before-restore-${s}:/d`,
      `volume create univarse-stack_seaweedfs-data-before-restore-${s}`,
      `copy univarse-stack_seaweedfs-data-before-restore-${s}:/d`,
      `stack dir aside ${s}`,
      'empty univarse-stack_pgdata:/v',
      'empty univarse-stack-vault-raft:/v',
      'empty univarse-stack_seaweedfs-data:/v',
    ]);
  });

  it('refuses a running stack, before reading anything', () => {
    const { x, calls } = io({ running: true });
    expect(prepareRealRestore(STACK_DATA, [], NOW, x).join()).toMatch(/the stack is running/);
    expect(calls).toEqual([]);
  });

  it('refuses a missing volume, a disk too small, and a copy that exists already, replacing nothing', () => {
    for (const [o, re] of [[{ missing: 'univarse-stack-vault-raft' }, /has no volume univarse-stack-vault-raft/], [{ used: 6e8, free: 1e9 }, /need 1\.80 GB.*1\.00 GB free/], [{ copyExists: true }, /exists already: nothing replaced/]] as const) {
      const { x, calls } = io(o);
      expect(prepareRealRestore(STACK_DATA, [], NOW, x).join()).toMatch(re);
      expect(calls.some((c) => c.startsWith('empty') || c.startsWith('stack dir'))).toBe(false);
    }
  });
});
