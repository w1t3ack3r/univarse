// Spec 0020 D6: the backup destination is saved and read normalised. A path the owner's shell doubled the separators of
// (`D:\\univarse-backups`, seen on the owner's machine on 2026-10-25) is stored, and read, as the one directory it names.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_DESTINATION, loadSettings, saveSettings } from './config.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'uv-backup-config-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('[D6] the backup destination', () => {
  const clean = join(tmpdir(), 'univarse-backups');
  const doubled = `${tmpdir()}${sep}${sep}univarse-backups${sep}`;

  it('is saved normalised: doubled and trailing separators never reach the file', () => {
    saveSettings({ destination: doubled }, dir);
    expect((JSON.parse(readFileSync(join(dir, 'backup.json'), 'utf8')) as { destination: string }).destination).toBe(clean);
  });

  it('a path saved before that, doubled, reads as the one directory it names', () => {
    writeFileSync(join(dir, 'backup.json'), JSON.stringify({ destination: doubled }));
    expect(loadSettings(dir).destination).toBe(clean);
  });

  it('the default when nothing is saved; a relative path is refused', () => {
    expect(loadSettings(dir).destination).toBe(DEFAULT_DESTINATION);
    expect(() => saveSettings({ destination: 'relative/backups' }, dir)).toThrow(/absolute path/);
  });
});
