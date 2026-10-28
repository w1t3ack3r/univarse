import { describe, expect, it } from 'vitest';
import { CONFIG_VOLUMES, DATA_OWNERS, prepareVolumes, REHEARSAL_DATA } from './target.js';

/** Each volume's root, as the ownership step sets it: `chown <owner> /v && chmod <mode> /v`. */
function roots(): Map<string, string> {
  const set = new Map<string, string>();
  prepareVolumes(REHEARSAL_DATA, (args) => {
    const script = args.at(-1) ?? '';
    const volume = args[args.indexOf('-v') + 1]?.split(':')[0] ?? '';
    const m = /^chown (\d+:\d+) \/v && chmod (\d{4}) \/v$/.exec(script);
    if (args[0] === 'run' && m) set.set(volume, `${m[1] ?? ''} ${m[2] ?? ''}`);
    return { status: 0, stdout: '', stderr: '' };
  });
  return set;
}

describe('[BK7] the restore\'s volume roots', () => {
  // The owner's first rehearsal (2026-10-28): a 0700 root owned to root kept postgres (999) out of /certs.
  it('a configuration volume\'s root is root\'s and 0755, so its service reaches the files inside', () => {
    const r = roots();
    for (const v of Object.keys(CONFIG_VOLUMES)) expect(r.get(v)).toBe('0:0 0755');
  });

  it('a data volume\'s root is its service\'s and 0700', () => {
    const r = roots();
    for (const [v, owner] of Object.entries(DATA_OWNERS(REHEARSAL_DATA))) expect(r.get(v)).toBe(`${owner} 0700`);
    expect(r.size).toBe(Object.keys(CONFIG_VOLUMES).length + Object.keys(DATA_OWNERS(REHEARSAL_DATA)).length);
  });
});
