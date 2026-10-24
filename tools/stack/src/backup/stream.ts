// Spec 0020 PR B1: a command's stdout as a stream, for what is too large to buffer (a base backup, a Vault snapshot,
// staged WAL). The stream fails if the command exits non-zero, so a writer of a sealed artifact (set.ts) keeps nothing
// from a failed command. Arguments are an array, never a shell; secrets reach a container by `-e NAME` or an env file.
import { spawn } from 'node:child_process';

export type StreamRunner = (args: readonly string[], opts?: { env?: Record<string, string>; onStderr?: (text: string) => void }) => AsyncIterable<Buffer>;

/** `docker <args>`'s stdout. On a non-zero exit, the iteration throws with the exit code and stderr's last lines. */
export const dockerStream: StreamRunner = (args, { env = {}, onStderr } = {}) => ({
  async *[Symbol.asyncIterator]() {
    const child = spawn('docker', args, { env: { ...process.env, MSYS_NO_PATHCONV: '1', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (b: Buffer) => {
      onStderr?.(b.toString('utf8'));
      stderr = (stderr + b.toString('utf8')).slice(-4000);
    });
    const exit = new Promise<number>((res, rej) => {
      child.on('error', rej);
      child.on('close', (code) => res(code ?? 1));
    });
    try {
      for await (const b of child.stdout as AsyncIterable<Buffer>) yield b;
    } finally {
      if (child.exitCode === null) child.kill();
    }
    const code = await exit;
    if (code !== 0) throw new Error(`docker ${args[0] ?? ''} exited ${String(code)}: ${stderr.trim().split('\n').slice(-4).join(' | ')}`);
  },
});
