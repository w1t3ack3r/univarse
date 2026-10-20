// Spec 0019: one way to run Docker from the stack tooling. Arguments are arrays (never a shell); a secret reaches a
// container only as `-e NAME`, its value in this process's environment for the docker CLI to read, never on a
// command line. Output is returned, not printed: callers decide what (if anything) is safe to show.
import { spawnSync } from 'node:child_process';

export interface RunResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}
export type Runner = (args: readonly string[], opts?: { env?: Record<string, string>; input?: string | undefined; allowFail?: boolean }) => RunResult;

/** Windows paths as Docker Desktop wants them in `-v`; container paths untouched. */
export const hostPath = (p: string) => (process.platform === 'win32' ? p.replace(/\//g, '\\') : p);

export const docker: Runner = (args, { env = {}, input, allowFail = false } = {}) => {
  const r = spawnSync('docker', args, {
    env: { ...process.env, MSYS_NO_PATHCONV: '1', ...env },
    encoding: 'utf8',
    input,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error) throw r.error;
  const out = { status: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
  if (out.status !== 0 && !allowFail) {
    // The last stderr lines only, and never the arguments' values beyond the subcommand: they may name files.
    throw new Error(`docker ${args[0] ?? ''} ${args[1] ?? ''} exited ${String(out.status)}: ${out.stderr.trim().split('\n').slice(-6).join(' | ')}`);
  }
  return out;
};
