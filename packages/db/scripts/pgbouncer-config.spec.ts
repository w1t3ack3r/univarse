// Spec 0017 PB9 / D5: what `pnpm db:setup` writes for PgBouncer. The live halves (authentication through PgBouncer,
// rotation, the file's real permissions) are in the probe file; these pin the generated content and the checks.
import { describe, expect, it } from 'vitest';
import {
  PGBOUNCER_ADMIN,
  parseIcacls,
  posixModeProblems,
  renderAuthFile,
  renderIni,
  scramVerifier,
  windowsAclProblems,
} from './pgbouncer-config.js';

// Made by PostgreSQL 18 itself for a throwaway role with the password "pencil" (a disposable container; not a secret).
const PG18_PENCIL =
  'SCRAM-SHA-256$4096:8ju0CpHEdP640DcwgoClRA==$HdfmHUd/3oIe/5TUMFLISoN8tS4Qyi1yrdxOIO0D3sU=:oGVjSy4l1taShsg7J36Y7fq9mHWSqn/bVgLKbcUOk4o=';

describe('[PB9] the admin entry verifier is computed exactly as PostgreSQL computes one', () => {
  it('reproduces a PostgreSQL 18 verifier byte for byte from its salt and iteration count', () => {
    const [, iterSalt] = PG18_PENCIL.split('$');
    const [iterations, salt] = iterSalt!.split(':');
    expect(scramVerifier('pencil', Buffer.from(salt!, 'base64'), Number(iterations))).toBe(
      PG18_PENCIL,
    );
  });

  it('uses a fresh random salt each time, and refuses passwords SASLprep could change', () => {
    expect(scramVerifier('pencil')).not.toBe(scramVerifier('pencil'));
    expect(scramVerifier('pencil')).toMatch(/^SCRAM-SHA-256\$4096:/);
    for (const bad of ['', 'has space', 'tab\tbed', 'naïve'])
      expect(() => scramVerifier(bad)).toThrow(/printable ASCII/);
  });
});

describe('[PB9] the auth file holds SCRAM verifiers only, under each role’s own name', () => {
  const v = scramVerifier('pencil');

  it('writes one quoted line per entry', () => {
    expect(
      renderAuthFile([
        { user: 'univarse_app', verifier: v },
        { user: PGBOUNCER_ADMIN, verifier: v },
      ]),
    ).toBe(`"univarse_app" "${v}"\n"pgbouncer_admin" "${v}"\n`);
  });

  it('refuses anything but a SCRAM verifier, naming the user and never the value', () => {
    for (const verifier of [
      null,
      'md5' + 'a'.repeat(32),
      'plaintext-password',
      `${v} `,
      v.replace('4096', '0'),
    ]) {
      let message = '';
      try {
        renderAuthFile([{ user: 'univarse_app', verifier }]);
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toMatch(/univarse_app has no SCRAM-SHA-256 verifier/);
      if (verifier) expect(message).not.toContain(verifier);
    }
  });

  it('refuses unsafe names, duplicates and an empty file', () => {
    expect(() => renderAuthFile([{ user: 'a" "b', verifier: v }])).toThrow(/unsafe user name/);
    expect(() =>
      renderAuthFile([
        { user: 'univarse_app', verifier: v },
        { user: 'univarse_app', verifier: v },
      ]),
    ).toThrow(/appears twice/);
    expect(() => renderAuthFile([])).toThrow(/no entries/);
  });
});

describe('[PB9][D5] pgbouncer.ini: transaction pooling, the two profiles, no forced user', () => {
  const databases = ['univarse_platform', 'univarse_pool_01'];
  const settings = (ini: string) =>
    Object.fromEntries(
      ini
        .split('\n')
        .filter((l) => /^[a-z_]+ =/.test(l))
        .map((l) => [l.slice(0, l.indexOf(' =')), l.slice(l.indexOf('=') + 1).trim()]),
    );

  it('the profiles differ only in default_pool_size: 2 for the probes, 10 for the suites', () => {
    const probe = renderIni({ profile: 'probe', databases, serverPort: 5432 });
    const suite = renderIni({ profile: 'suite', databases, serverPort: 5432 });
    expect(settings(probe).default_pool_size).toBe('2');
    expect(settings(suite).default_pool_size).toBe('10');
    expect({ ...settings(probe), default_pool_size: '10' }).toEqual(settings(suite));
  });

  it('carries the Design table settings exactly', () => {
    const s = settings(renderIni({ profile: 'probe', databases, serverPort: 5433 }));
    expect(s).toMatchObject({
      pool_mode: 'transaction',
      max_client_conn: '200',
      max_prepared_statements: '0',
      query_wait_timeout: '2',
      server_round_robin: '0',
      auth_type: 'scram-sha-256',
      listen_addr: '0.0.0.0',
      listen_port: '6432',
      admin_users: PGBOUNCER_ADMIN,
      unix_socket_dir: '',
    });
    expect(s.univarse_platform).toBe(
      'host=host.docker.internal port=5433 dbname=univarse_platform',
    );
  });

  it('forces no user= on any database, and leaves ignore_startup_parameters and max_packet_size unset (revision 5)', () => {
    const ini = renderIni({ profile: 'suite', databases, serverPort: 5432 });
    expect(ini).not.toMatch(/\buser\s*=/);
    expect(ini).not.toMatch(/ignore_startup_parameters|max_packet_size/);
  });

  it('refuses an unknown profile, a bad port, or an unsafe database name', () => {
    expect(() => renderIni({ profile: 'session' as 'probe', databases, serverPort: 5432 })).toThrow(
      /unknown profile/,
    );
    expect(() => renderIni({ profile: 'probe', databases, serverPort: 0 })).toThrow(/bad port/);
    expect(() =>
      renderIni({ profile: 'probe', databases: ['x user=postgres'], serverPort: 5432 }),
    ).toThrow(/unsafe/);
  });
});

describe('[PB9] the auth file is owner-only, checked after writing', () => {
  const file = String.raw`C:\Projects\univarse\.pgbouncer\userlist.txt`;
  const user = String.raw`DESKTOP-1\someone`;

  it('Windows: exactly the current user with full control, nothing inherited', () => {
    const ok = `${file} ${user}:(F)\n\nSuccessfully processed 1 files; Failed processing 0 files\n`;
    expect(windowsAclProblems(parseIcacls(ok, file), user)).toEqual([]);
    const inherited = `${file} ${user}:(F)\n           BUILTIN\\Users:(I)(RX)\n\nSuccessfully processed 1 files\n`;
    expect(windowsAclProblems(parseIcacls(inherited, file), user)).toHaveLength(1);
    const readOnly = `${file} ${user}:(R)\n\nSuccessfully processed 1 files\n`;
    expect(windowsAclProblems(parseIcacls(readOnly, file), user)).toHaveLength(1);
    expect(
      windowsAclProblems(parseIcacls(`${file}\nSuccessfully processed 1 files\n`, file), user),
    ).toHaveLength(1);
  });

  it('POSIX: mode 0600 and owned by the current user', () => {
    expect(posixModeProblems(0o100600, 1001, 1001)).toEqual([]);
    expect(posixModeProblems(0o100644, 1001, 1001)).toEqual(['mode is 0644, expected 0600']);
    expect(posixModeProblems(0o100640, 1001, 1001)).toHaveLength(1);
    // exactly what db:setup set: an executable or read-only variant means something else changed it
    expect(posixModeProblems(0o100700, 1001, 1001)).toEqual(['mode is 0700, expected 0600']);
    expect(posixModeProblems(0o100400, 1001, 1001)).toEqual(['mode is 0400, expected 0600']);
    expect(posixModeProblems(0o100600, 0, 1001)).toEqual([
      'owned by uid 0, not the current user (1001)',
    ]);
  });
});
