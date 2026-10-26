// Spec 0020 B2-12: a real restore refuses before anything is read or created unless its confirmation is given word for
// word (BK10: `stack:restore` without its confirmation); the commands refuse their usage errors the same way.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { main, writeNew } from './cli.js';
import { CONFIRMATION } from './real-restore.js';

describe('[B2-12] the restore commands\' refusals', () => {
  const log = () => undefined;

  it('a real restore without the exact confirmation is refused, naming the phrase', async () => {
    for (const confirm of ['yes', `${CONFIRMATION} `, CONFIRMATION.toUpperCase()]) {
      const r = await main('restore', ['20261026T020000Z-ab12', '--key', 'k.json', '--confirm', confirm], log);
      expect(r).toEqual({ ok: false, lines: [`a real restore replaces the stack's data: give --confirm "${CONFIRMATION}", word for word`] });
    }
  });

  it('usage errors: no set, no key, an unknown flag, a repeated one, a --to that is no time', async () => {
    await expect(main('restore', ['--key', 'k.json', '--confirm', CONFIRMATION], log)).rejects.toThrow(/usage/);
    await expect(main('rehearsal', [], log)).rejects.toThrow(/usage/);
    await expect(main('rehearsal', ['--key', 'k', '--nope', 'x'], log)).rejects.toThrow(/usage/);
    await expect(main('rehearsal', ['--key', 'k', '--key', 'k'], log)).rejects.toThrow(/usage/);
    await expect(main('rehearsal', ['--key', 'k', '--to', 'yesterday'], log)).rejects.toThrow(/--to takes an ISO time/);
    await expect(main('nothing', [], log)).rejects.toThrow(/usage/);
  });

  it('a record never overwrites another: the same day\'s second is -2, the first unchanged', () => {
    const dir = mkdtempSync(join(tmpdir(), 'uv-record-'));
    try {
      expect(writeNew(dir, '2026-10-26-restore-and-shred', 'first')).toBe(join(dir, '2026-10-26-restore-and-shred.md'));
      expect(writeNew(dir, '2026-10-26-restore-and-shred', 'second')).toBe(join(dir, '2026-10-26-restore-and-shred-2.md'));
      expect(readFileSync(join(dir, '2026-10-26-restore-and-shred.md'), 'utf8')).toBe('first');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('without the passphrase in its variable, nothing starts', async () => {
    const before = process.env.UNIVARSE_BACKUP_KEY_PASSPHRASE;
    delete process.env.UNIVARSE_BACKUP_KEY_PASSPHRASE;
    try {
      await expect(main('drill', ['--key', 'k.json'], log)).rejects.toThrow(/set UNIVARSE_BACKUP_KEY_PASSPHRASE/);
    } finally {
      if (before !== undefined) process.env.UNIVARSE_BACKUP_KEY_PASSPHRASE = before;
    }
  });
});
