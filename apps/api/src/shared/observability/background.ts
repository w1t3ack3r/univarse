// Spec 0031 Q10: one pass of background work, on a timer, outside any request. A failure must end here: an unhandled
// rejection kills the process (S2's mail relay did exactly that when the pool was busy). The next tick tries again.
import type { Logger } from '@nestjs/common';

export async function backgroundPass(logger: Pick<Logger, 'warn'>, event: string, pass: () => Promise<unknown>): Promise<void> {
  try {
    await pass();
  } catch (err) {
    // The error's code or type only: a driver's message can quote values.
    const reason = (err as { code?: string } | null)?.code ?? (err as Error | null)?.name ?? 'unknown';
    logger.warn({ event, reason }, 'A background pass failed; the next one retries');
  }
}
