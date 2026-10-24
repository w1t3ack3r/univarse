import { describe, expect, it } from 'vitest';
import { printer } from './print.js';

describe('printer', () => {
  it('prints logged lines as they come and leaves only the rest of the result to print', () => {
    const out: string[] = [];
    const p = printer((l) => out.push(l));
    p.log('WAL: 4 shipped');
    p.log('set complete');
    expect(out).toEqual(['WAL: 4 shipped', 'set complete']);
    expect(p.unprinted({ ok: false, setId: 'x', lines: ['WAL: 4 shipped', 'set complete', 'the backup stopped'] })).toEqual({ ok: false, setId: 'x', lines: ['the backup stopped'] });
  });

  it('leaves a result that was never logged whole', () => {
    expect(printer(() => undefined).unprinted({ lines: ['no backup public key'] })).toEqual({ lines: ['no backup public key'] });
  });
});
