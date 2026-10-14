// Test helpers: hand-built tar archives (ustar headers, and pax records with exact byte lengths), for the tar reader's
// and the PgBouncer inventory's tests. Not used at run time.

/** One ustar header block (the reader doesn't verify checksums). */
export function header(name, flag, { size = 0, linkname = '' } = {}) {
  const h = Buffer.alloc(512);
  h.write(name, 0, 'utf8');
  h.write('0000644\0', 100, 'latin1');
  h.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 'latin1');
  h.write(flag, 156, 'latin1');
  h.write(linkname, 157, 'utf8');
  h.write('ustar\0', 257, 'latin1');
  return h;
}

/** `s`, padded to whole 512-byte blocks. */
export const block = (s) => {
  const b = Buffer.alloc(Math.ceil(Buffer.byteLength(s) / 512) * 512);
  b.write(s, 0, 'utf8');
  return b;
};

/** One pax record `<len> key=value\n`, its length counted in BYTES including its own digits. */
export function paxRecord(key, value) {
  const body = Buffer.byteLength(` ${key}=${value}\n`);
  let n = body + 1;
  while (String(n).length + body !== n) n = String(n).length + body;
  return `${n} ${key}=${value}\n`;
}

/** A pax extended header (`x`) carrying `records`, then the entry it applies to. */
export function paxEntry(records, name, flag, linkname = '') {
  const pax = Buffer.from(records.join(''), 'utf8');
  const padded = Buffer.alloc(Math.ceil(pax.length / 512) * 512);
  pax.copy(padded);
  return Buffer.concat([
    header('PaxHeaders/x', 'x', { size: pax.length }),
    padded,
    header(name, flag, { linkname }),
  ]);
}

/** Every entry of an archive, as the tar reader reports it ({ path, type, link }). */
export function parseArchive(buf, tarParser) {
  const out = [];
  tarParser((e) => out.push(e)).push(Buffer.concat([buf, Buffer.alloc(1024)]));
  return out.map(({ path, type, link }) =>
    link === undefined ? { path, type } : { path, type, link },
  );
}
