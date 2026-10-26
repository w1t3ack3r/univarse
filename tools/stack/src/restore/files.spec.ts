// Spec 0020 B2-8: the keys' encoding as SigV4 signs them (the probe of 2026-10-26 failed when every byte was encoded),
// the container's input, and its report judged object by object.
import { describe, expect, it } from 'vitest';
import { readTar, tarStream } from '../backup/tar.js';
import { filesProblems, s3Path, scratchTar } from './files.js';

describe('[B2-8] object keys as URL paths', () => {
  it('keeps unreserved characters and slashes; encodes everything else by its UTF-8 bytes', () => {
    expect(s3Path('0f1e2d3c-tenant/9a8b7c6d-file')).toBe('0f1e2d3c-tenant/9a8b7c6d-file');
    expect(s3Path('tenant/sub dir/report 2026.pdf')).toBe('tenant/sub%20dir/report%202026.pdf');
    expect(s3Path('tenant/naïve-ü.txt')).toBe('tenant/na%C3%AFve-%C3%BC.txt');
    expect(s3Path("a/it's (1)*!.txt")).toBe('a/it%27s%20%281%29%2A%21.txt');
    expect(s3Path('a~b_c.d-e')).toBe('a~b_c.d-e');
  });

  it('refuses a key that is no object key', () => {
    for (const k of ['', '/abs', 'a//b', 'a/../b', 'a/./b']) expect(() => s3Path(k)).toThrow(/won't write/);
  });
});

describe('[B2-8] the container\'s input', () => {
  it('numbered entries, their index, and the host\'s hash of each object', async () => {
    const files = tarStream([{ name: 'a/one.pdf', data: Buffer.from('one') }, { name: 'b two.bin', data: Buffer.from('two') }]);
    const { stream, sent } = scratchTar(files);
    const out: { name: string; data: string }[] = [];
    for await (const e of readTar(stream as AsyncIterable<Buffer>)) out.push({ name: e.name, data: e.data.toString() });
    expect(out).toEqual([
      { name: 'o/0000001', data: 'one' },
      { name: 'o/0000002', data: 'two' },
      { name: 'index.tsv', data: '0000001\ta/one.pdf\n0000002\tb%20two.bin\n' },
    ]);
    expect(sent.map((s) => s.key)).toEqual(['a/one.pdf', 'b two.bin']);
    expect(sent[0]?.sha256).toBe('7692c3ad3540bb803c020b3aee66cd8887123234ea0c6e7143c0add73ff431ed');
  });

  it('an empty bucket sends an empty index', async () => {
    const { stream, sent } = scratchTar(tarStream([]));
    const out: string[] = [];
    for await (const e of readTar(stream as AsyncIterable<Buffer>)) out.push(e.name);
    expect(out).toEqual(['index.tsv']);
    expect(sent).toEqual([]);
  });
});

describe('[B2-8] the container\'s report', () => {
  const sent = [{ key: 'a', sha256: 'aa' }, { key: 'b', sha256: 'bb' }];
  it('every object written, read back and equal: no problem', () => {
    expect(filesProblems(sent, '0000001\t201\t200\taa\n0000002\t201\t200\tbb\n')).toEqual([]);
  });
  it('a missing object, a failed write, a failed read and a different hash each fail, by position only', () => {
    expect(filesProblems(sent, '0000001\t201\t200\taa\n')).toEqual(['object 2 of 2: not restored']);
    expect(filesProblems(sent, '0000001\t500\t200\taa\n0000002\t201\t200\tbb\n')).toEqual(['object 1 of 2: the filer answered 500 to its write']);
    expect(filesProblems(sent, '0000001\t201\t403\taa\n0000002\t201\t200\tbb\n')).toEqual(['object 1 of 2: S3 answered 403 to its read']);
    expect(filesProblems(sent, '0000001\t201\t200\tzz\n0000002\t201\t200\tbb\n')).toEqual(['object 1 of 2: read back over S3, its SHA-256 differs']);
  });
});
