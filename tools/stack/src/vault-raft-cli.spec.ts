// Spec 0020 B-4: what migrate-raft prints, once, including why the keys job failed.
import { describe, expect, it } from 'vitest';
import { printedAsItGoes, verifyUnwrapLines } from './vault-raft-cli.js';

describe('verifyUnwrapLines', () => {
  it("reports the job's last lines when every key unwraps", () => {
    expect(verifyUnwrapLines({ status: 0, stdout: 'starting\n3 of 3 data keys unwrap\n{"ok":true}\n', stderr: 'noise' })).toEqual({ ok: true, lines: ['starting', '3 of 3 data keys unwrap', '{"ok":true}'] });
  });

  it('says why a job that failed before its check failed (stderr), and how it ended', () => {
    const r = verifyUnwrapLines({ status: 1, stdout: '', stderr: 'Invalid configuration:\n  - VAULT_TOKEN: Too small\n' });
    expect(r.ok).toBe(false);
    expect(r.lines).toEqual(['Invalid configuration:', '  - VAULT_TOKEN: Too small', 'the keys job exited 1']);
  });

  it('keeps only the last five lines of each stream, and names a job that never finished', () => {
    const many = Array.from({ length: 8 }, (_, i) => `line ${String(i)}`).join('\n');
    const r = verifyUnwrapLines({ status: null, stdout: many, stderr: '' });
    expect(r).toEqual({ ok: false, lines: ['line 3', 'line 4', 'line 5', 'line 6', 'line 7', 'the keys job did not finish'] });
  });
});

describe('printedAsItGoes', () => {
  it('prints each logged line once and returns only the outcome after them', () => {
    const printed: string[] = [];
    const r = printedAsItGoes(
      (log) => {
        log('before');
        log('after');
        return { ok: false, lines: ['before', 'after', 'not verified'] };
      },
      (l) => printed.push(l),
    );
    expect(printed).toEqual(['before', 'after']);
    expect(r).toEqual({ ok: false, lines: ['not verified'] });
  });

  it('returns lines the step never logged (a refusal before it starts) in full', () => {
    expect(printedAsItGoes(() => ({ ok: false, lines: ['Vault must be running'] }), () => undefined)).toEqual({ ok: false, lines: ['Vault must be running'] });
  });
});
