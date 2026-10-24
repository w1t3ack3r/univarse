import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { header, readTar, tarStream } from './tar.js';

const collect = async (r: AsyncIterable<Buffer>) => {
  const out: Buffer[] = [];
  for await (const b of r) out.push(b);
  return Buffer.concat(out);
};
async function* chunks(b: Buffer, n: number) {
  await Promise.resolve();
  for (let i = 0; i < b.length; i += n) yield b.subarray(i, i + n);
}
const read = async (b: Buffer, n = 777) => {
  const out: { name: string; data: string }[] = [];
  for await (const e of readTar(chunks(b, n))) out.push({ name: e.name, data: e.data.toString() });
  return out;
};

describe('tar', () => {
  const long = `${'d'.repeat(120)}/${'f'.repeat(90)}`;
  const entries = [
    { name: 'a.txt', data: Buffer.from('alpha') },
    { name: 'dir/empty', data: Buffer.alloc(0) },
    { name: 'dir/block', data: Buffer.alloc(512, 7) },
    { name: long, data: Buffer.from('long') },
  ];

  it('round-trips, read in uneven pieces', async () => {
    const t = await collect(tarStream(entries));
    expect(t.length % 512).toBe(0);
    expect(await read(t)).toEqual(entries.map((e) => ({ name: e.name, data: e.data.toString() })));
  });

  it('is read by the system tar, and reads what the system tar writes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'uv-tar-'));
    const file = join(dir, 'x.tar');
    writeFileSync(file, await collect(tarStream(entries)));
    const list = spawnSync('tar', ['-tf', file], { encoding: 'utf8' });
    expect(list.status).toBe(0);
    expect(list.stdout.trim().split('\n')).toEqual(entries.map((e) => e.name));

    writeFileSync(join(dir, '000000010000000000000003'), 'segment');
    writeFileSync(join(dir, '00000002.history'), 'history');
    const made = spawnSync('tar', ['--format=ustar', '-C', dir, '-cf', '-', '000000010000000000000003', '00000002.history']);
    expect(await read(made.stdout)).toEqual([
      { name: '000000010000000000000003', data: 'segment' },
      { name: '00000002.history', data: 'history' },
    ]);
    expect(readFileSync(join(dir, '00000002.history'), 'utf8')).toBe('history');
  });

  it('refuses a truncated stream, a bad checksum, a link, an unsafe name and an oversized entry', async () => {
    const t = await collect(tarStream([{ name: 'a', data: Buffer.from('abc') }]));
    await expect(read(t.subarray(0, 512 + 512))).rejects.toThrow(/truncated/);
    await expect(read(t.subarray(0, 600))).rejects.toThrow(/truncated/);
    const bad = Buffer.from(t);
    bad[0] = 0x62;
    await expect(read(bad)).rejects.toThrow(/checksum/);

    const link = header({ name: 'l', size: 0, mode: 0o777, mtime: new Date(0), type: '0' });
    link.write('2', 156, 'ascii');
    let sum = 0;
    link.write('        ', 148, 'ascii');
    for (const b of link) sum += b;
    link.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
    await expect(read(Buffer.concat([link, Buffer.alloc(1024)]))).rejects.toThrow(/regular files only/);

    expect(() => header({ name: '../x', size: 0, mode: 0, mtime: new Date(0), type: '0' })).toThrow(/unsafe/);
    const big = await collect(tarStream([{ name: 'big', data: Buffer.alloc(2000) }]));
    await expect((async () => {
      for await (const e of readTar(chunks(big, 100), { maxEntry: 1000 })) expect(e).toBeUndefined();
    })()).rejects.toThrow(/refused/);
  });
});
