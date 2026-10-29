import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';

/**
 * Asks for a secret without echoing it. The question goes to `output` directly; readline gets a sink, so neither its
 * per-keystroke line redraws nor anything else it writes can show what was typed. On a TTY, readline also puts the
 * input in raw mode, so the terminal doesn't echo it either. Ctrl+C rejects (readline's own AbortError).
 */
export async function promptHidden(
  question: string,
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
): Promise<string> {
  output.write(question);
  const sink = new Writable({ write: (_chunk, _encoding, done) => done() });
  const rl = createInterface({ input, output: sink, terminal: true });
  try {
    return await rl.question('');
  } finally {
    rl.close();
    output.write('\n');
  }
}
