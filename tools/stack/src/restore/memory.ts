// Spec 0020 B2-11, B2-14: the restore's peak memory, sampled every 5 s with `docker stats`. The restore's own steps
// block (spawnSync) for minutes at a time, so the sampler is a child process of its own: it keeps the peak sum of the
// labelled containers' usage and prints it after every sample; stopping it reads the last figure.
import { spawn } from 'node:child_process';
import { LABEL } from './target.js';

/** One `docker stats` line's memory in MiB: `512MiB / 1GiB`, `1.2GiB / …`, `800kB / …`. */
export function mib(usage: string): number {
  const m = /^\s*([\d.]+)\s*([KMGT]?i?B)/i.exec(usage);
  if (!m) return 0;
  const n = Number(m[1]);
  const unit = (m[2] ?? '').toLowerCase();
  const scale: Record<string, number> = { b: 1 / 1048576, kb: 1 / 1024, kib: 1 / 1024, mb: 1, mib: 1, gb: 1024, gib: 1024, tb: 1048576, tib: 1048576 };
  return n * (scale[unit] ?? 0);
}

const SCRIPT = `
const { execFileSync } = require('node:child_process');
let peak = 0;
const sample = () => {
  try {
    const ids = execFileSync('docker', ['ps', '-q', '--filter', 'label=${LABEL}'], { encoding: 'utf8' }).split('\\n').filter(Boolean);
    if (!ids.length) return;
    const out = execFileSync('docker', ['stats', '--no-stream', '--format', '{{.MemUsage}}', ...ids], { encoding: 'utf8' });
    const sum = out.split('\\n').filter(Boolean).reduce((a, l) => a + (${mib.toString()})(l), 0);
    if (sum > peak) peak = sum;
    process.stdout.write(String(Math.round(peak)) + '\\n');
  } catch {}
};
sample();
setInterval(sample, 5000);
`;

/** Starts sampling; `stop()` ends it and returns the peak in MiB (null when nothing was sampled). */
export function sampleMemory(): { stop(): number | null } {
  const child = spawn(process.execPath, ['-e', SCRIPT], { stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
  let last: number | null = null;
  child.stdout.on('data', (b: Buffer) => {
    const n = Number(b.toString('utf8').trim().split('\n').at(-1));
    if (Number.isFinite(n)) last = n;
  });
  let stopped = false;
  return {
    stop: () => {
      if (!stopped) {
        stopped = true;
        child.kill();
      }
      return last;
    },
  };
}
