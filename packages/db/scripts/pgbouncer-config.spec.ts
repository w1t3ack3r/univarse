// Spec 0017 PB9 / D5: what `pnpm db:setup` writes for PgBouncer. The live halves (authentication through PgBouncer,
// rotation, the file's real permissions) are in the probe file; these pin the generated content and the checks.
import {
  closeSync,
  mkdtempSync,
  openSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PGBOUNCER_ADMIN,
  type OwnerOnlyOps,
  ownerOnlyDirProblems,
  ownerOnlyProblems,
  parseIcacls,
  posixModeProblems,
  realOwnerOnlyOps,
  restrictDirToOwner,
  renderAuthFile,
  renderIni,
  scramVerifier,
  windowsAclProblems,
  writeOwnerOnly,
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

describe("[PB9] the auth file is written fresh, owner-only, and swapped in atomically (owner's review of 14c787f)", () => {
  const DIR = 'dir';
  const target = join(DIR, 'userlist.txt');
  const tmp = join(DIR, '.userlist.txt.r4nd.tmp');
  const USER = String.raw`HOST\someone`;
  type Hook = (path: string) => unknown;

  /** A recording world; `over` makes one operation misbehave. */
  function world(
    platform: NodeJS.Platform,
    over: Partial<Record<'aclCheck' | 'modeCheck' | 'rename' | 'create' | 'close', Hook>> = {},
  ) {
    const log: string[] = [];
    const ops: OwnerOnlyOps = {
      platform,
      createExclusive: (path) => {
        log.push(`create ${path}`);
        over.create?.(path);
        return 7;
      },
      fchmod: (_fd, mode) => log.push(`fchmod ${mode.toString(8)}`),
      chmod: (path, mode) => log.push(`chmod ${path} ${mode.toString(8)}`),
      setOwnerOnlyDirAcl: (path) => log.push(`setacl ${path}`),
      write: () => log.push('write'),
      fsync: () => log.push('fsync'),
      close: () => {
        log.push('close');
        over.close?.('');
      },
      rename: (from, to) => {
        log.push(`rename ${from} -> ${to}`);
        over.rename?.(from);
      },
      unlink: (path) => log.push(`unlink ${path}`),
      stat: (path) => {
        log.push(`stat ${path}`);
        const fallback = path === DIR ? 0o40700 : 0o100600;
        return { mode: (over.modeCheck?.(path) as number | undefined) ?? fallback, uid: 1001 };
      },
      uid: () => 1001,
      icacls: (args) => {
        log.push(`icacls ${args.join(' ')}`);
        const [file = ''] = args;
        if (args.length > 1) return '';
        const rights = file === DIR ? '(OI)(CI)(F)' : '(F)';
        return (
          (over.aclCheck?.(file) as string | undefined) ??
          `${file} ${USER}:${rights}\n\nSuccessfully processed 1 files`
        );
      },
      windowsUser: () => USER,
      random: () => 'r4nd',
    };
    return { ops, log };
  }
  /** An operation that can change permissions: an icacls call with options, a DACL write, chmod or fchmod. */
  const changesPermissions = (entry: string) =>
    /^icacls \S+ \//.test(entry) || /^(f?chmod|setacl) /.test(entry);

  it('Windows: the directory first (one DACL write, owner-only, inheritable), then the empty file narrowed, written, checked read only, renamed, checked read only; never /reset', () => {
    const { ops, log } = world('win32');
    writeOwnerOnly(target, 'verifiers', ops);
    expect(log).toEqual([
      `setacl ${DIR}`,
      `icacls ${DIR}`,
      `create ${tmp}`,
      `icacls ${tmp} /inheritance:r /grant:r ${USER}:F`,
      `icacls ${tmp}`,
      'write',
      'fsync',
      'close',
      `icacls ${tmp}`,
      `rename ${tmp} -> ${target}`,
      `icacls ${target}`,
    ]);
    expect(log.join('\n')).not.toContain('/reset');
    expect(log.slice(0, log.indexOf(`create ${tmp}`)).filter(changesPermissions)).toEqual([
      `setacl ${DIR}`,
    ]); // exactly one change to the directory
    expect(log.slice(log.indexOf('write')).filter(changesPermissions)).toEqual([]);
  });

  it('POSIX: the directory 0700 first, then created 0600, set 0600 while empty, then only read-only checks', () => {
    const { ops, log } = world('linux');
    writeOwnerOnly(target, 'verifiers', ops);
    expect(log).toEqual([
      `chmod ${DIR} 700`,
      `stat ${DIR}`,
      `create ${tmp}`,
      'fchmod 600',
      `stat ${tmp}`,
      'write',
      'fsync',
      'close',
      `stat ${tmp}`,
      `rename ${tmp} -> ${target}`,
      `stat ${target}`,
    ]);
    expect(log.slice(log.indexOf('write')).filter(changesPermissions)).toEqual([]);
  });

  it('a wider empty file is never written to: removed, nothing renamed', () => {
    const { ops, log } = world('win32', {
      aclCheck: (p) => (p === tmp ? `${p} ${USER}:(F)\n BUILTIN\\Users:(I)(RX)\n` : undefined),
    });
    expect(() => {
      writeOwnerOnly(target, 'verifiers', ops);
    }).toThrow(/\(empty\).*ACL must be exactly/);
    expect(log).not.toContain('write');
    expect(log.some((l) => l.startsWith('rename'))).toBe(false);
    expect(log.at(-1)).toBe(`unlink ${tmp}`);
  });

  it('a file found wider after writing is not swapped in: removed, the target untouched', () => {
    let checks = 0;
    const { ops, log } = world('linux', {
      modeCheck: (p) => (p === tmp && ++checks === 2 ? 0o100644 : undefined),
    });
    expect(() => {
      writeOwnerOnly(target, 'verifiers', ops);
    }).toThrow(/mode is 0644/);
    expect(log.some((l) => l.startsWith('rename'))).toBe(false);
    expect(log.at(-1)).toBe(`unlink ${tmp}`);
  });

  it('a failed rename removes the temporary file; an existing temporary name is refused, not reused', () => {
    const r = world('linux', {
      rename: () => {
        throw new Error('EPERM');
      },
    });
    expect(() => {
      writeOwnerOnly(target, 'verifiers', r.ops);
    }).toThrow(/EPERM/);
    expect(r.log.at(-1)).toBe(`unlink ${tmp}`);
    const c = world('linux', {
      create: () => {
        throw new Error('EEXIST');
      },
    });
    expect(() => {
      writeOwnerOnly(target, 'verifiers', c.ops);
    }).toThrow(/EEXIST/);
    expect(c.log.slice(c.log.indexOf(`create ${tmp}`))).toEqual([`create ${tmp}`]); // nothing written, closed or removed: it wasn't ours
  });

  it("a directory that isn't the owner's alone (or not inheritably) stops the write before any file is created (owner's review of 5438022)", () => {
    for (const [platform, over] of [
      ['win32', { aclCheck: (p: string) => (p === DIR ? `${p} ${USER}:(F)\n` : undefined) }], // not inheritable
      [
        'win32',
        {
          aclCheck: (p: string) =>
            p === DIR ? `${p} ${USER}:(OI)(CI)(F)\n Everyone:(OI)(CI)(R)\n` : undefined,
        },
      ],
      ['linux', { modeCheck: (p: string) => (p === DIR ? 0o40755 : undefined) }],
    ] as const) {
      const { ops, log } = world(platform, over);
      expect(() => {
        writeOwnerOnly(target, 'verifiers', ops);
      }).toThrow(/^dir: /);
      expect(log.some((l) => l.startsWith('create'))).toBe(false);
    }
  });

  it("a failed close still removes the temporary file, with one close attempt (owner's review of 5438022)", () => {
    const { ops, log } = world('linux', {
      close: () => {
        throw new Error('EIO on close');
      },
    });
    expect(() => {
      writeOwnerOnly(target, 'verifiers', ops);
    }).toThrow(/EIO on close/);
    expect(log.filter((l) => l === 'close')).toHaveLength(1);
    expect(log.some((l) => l.startsWith('rename'))).toBe(false);
    expect(log.at(-1)).toBe(`unlink ${tmp}`);
    // and when closing fails in the cleanup path (an earlier failure left the file open), unlinking is still attempted
    const early = world('linux', {
      modeCheck: (p) => (p === tmp ? 0o100644 : undefined),
      close: () => {
        throw new Error('EIO on close');
      },
    });
    expect(() => {
      writeOwnerOnly(target, 'verifiers', early.ops);
    }).toThrow(/EIO on close/);
    expect(early.log.filter((l) => l === 'close')).toHaveLength(1);
    expect(early.log.at(-1)).toBe(`unlink ${tmp}`);
  });

  it('on the real filesystem: a file already at the temporary name (possibly wide) is refused, never reused', () => {
    const dir = mkdtempSync(join(tmpdir(), 'uv-authfile-'));
    try {
      const file = join(dir, 'userlist.txt');
      const planted = join(dir, '.userlist.txt.fixed.tmp');
      writeFileSync(planted, 'PLANTED\n');
      expect(() => {
        writeOwnerOnly(file, 'NEW-CONTENT\n', { ...realOwnerOnlyOps, random: () => 'fixed' });
      }).toThrow(/EEXIST/);
      expect(readFileSync(planted, 'utf8')).toBe('PLANTED\n'); // not written into, not removed: it isn't ours
      expect(readdirSync(dir)).toEqual(['.userlist.txt.fixed.tmp']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The temporary file's FIRST permissions, captured the moment it's created (before its own narrowing step), with
  // the directory deliberately broad beforehand: Windows grants Everyone read, inheritably; POSIX is 0777. They must
  // already be the current account's alone, so no other account can open the file in that gap. This checks the ACL
  // or mode another account would be refused by; it doesn't open the file as a second account (none exists here).
  it("on the real filesystem: the new temporary file is owner-only from its creation, under a broad directory (owner's review of 5438022)", () => {
    const dir = mkdtempSync(join(tmpdir(), 'uv-authfile-'));
    const atCreation: string[][] = [];
    const ops: OwnerOnlyOps = {
      ...realOwnerOnlyOps,
      createExclusive: (path) => {
        const fd = realOwnerOnlyOps.createExclusive(path);
        atCreation.push(
          process.platform === 'win32'
            ? parseIcacls(realOwnerOnlyOps.icacls([path]), path)
            : [(realOwnerOnlyOps.stat(path).mode & 0o777).toString(8)],
        );
        return fd;
      },
    };
    try {
      if (process.platform === 'win32') {
        realOwnerOnlyOps.icacls([dir, '/grant', 'Everyone:(OI)(CI)R']);
        expect(parseIcacls(realOwnerOnlyOps.icacls([dir]), dir).join(' ')).toMatch(/Everyone/); // really broad
      } else {
        realOwnerOnlyOps.chmod(dir, 0o777);
      }
      writeOwnerOnly(join(dir, 'userlist.txt'), 'NEW-CONTENT\n', ops);
      expect(atCreation).toHaveLength(1);
      if (process.platform === 'win32') {
        expect(atCreation[0]).toEqual([`${realOwnerOnlyOps.windowsUser()}:(I)(F)`]); // inherited from the narrowed dir only
      } else {
        expect(atCreation[0]).toEqual(['600']);
      }
      expect(ownerOnlyDirProblems(dir)).toEqual([]);
      expect(ownerOnlyProblems(join(dir, 'userlist.txt'))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Native Windows only (it's about ACL inheritance): an existing auth file that still INHERITS the private
  // directory's ACL, under a broadly permissive ancestor, with a failure injected immediately after the first change
  // to the directory. The existing file must stay private after every directory change and at the end. A `/reset`
  // (or any widening step) on the directory would propagate the ancestor's entries to it.
  it.runIf(process.platform === 'win32')(
    "native Windows: an existing inheriting auth file stays private through the directory change, even if the next step fails (owner's review of df04c06)",
    () => {
      const root = mkdtempSync(join(tmpdir(), 'uv-authfile-'));
      try {
        const user = realOwnerOnlyOps.windowsUser();
        const dir = join(root, 'priv');
        mkdirSync(dir);
        realOwnerOnlyOps.icacls([root, '/grant', 'Everyone:(OI)(CI)R']); // the broad ancestor
        realOwnerOnlyOps.icacls([dir, '/inheritance:r', '/grant:r', `${user}:(OI)(CI)F`]); // private, inheritable
        const existing = join(dir, 'userlist.txt');
        writeFileSync(existing, 'SYNTHETIC-VERIFIERS\n');
        const aclOf = (p: string) => parseIcacls(realOwnerOnlyOps.icacls([p]), p);
        const PRIVATE = [`${user}:(I)(F)`];
        expect(aclOf(existing)).toEqual(PRIVATE); // it inherits, unprotected: the unchecked case
        expect(aclOf(root).join(' ')).toMatch(/Everyone/);

        const afterEachDirChange: string[][] = [];
        let changes = 0;
        const changedDir = () => {
          afterEachDirChange.push(aclOf(existing));
          if (++changes === 1) throw new Error('injected failure after the first directory change');
        };
        const ops: OwnerOnlyOps = {
          ...realOwnerOnlyOps,
          setOwnerOnlyDirAcl: (p) => {
            realOwnerOnlyOps.setOwnerOnlyDirAcl(p);
            if (p === dir) changedDir();
          },
          icacls: (args) => {
            const out = realOwnerOnlyOps.icacls(args);
            if (args[0] === dir && args.length > 1) changedDir(); // any icacls change to the directory counts too
            return out;
          },
        };
        expect(() => {
          restrictDirToOwner(dir, ops);
        }).toThrow(/injected failure/);
        expect(afterEachDirChange).toEqual([PRIVATE]);
        expect(aclOf(existing)).toEqual(PRIVATE);

        // and without the injected failure, the directory ends exactly owner-only and the file stays private
        restrictDirToOwner(dir);
        expect(ownerOnlyDirProblems(dir)).toEqual([]);
        expect(aclOf(existing)).toEqual(PRIVATE);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  // POSIX swaps the name to the new file and the reader keeps the old one. Windows refuses to replace a file another
  // handle holds open (EPERM): the write fails closed, leaving the old file in place. Either way the old handle can
  // never read the new verifiers, and no temporary file is left. CI (Linux) runs the first branch; Windows the second.
  it('on the real filesystem: a reader holding the old file open never sees the new content', () => {
    const dir = mkdtempSync(join(tmpdir(), 'uv-authfile-'));
    const readHeld = (fd: number) => {
      const buf = Buffer.alloc(64);
      return buf.subarray(0, readSync(fd, buf, 0, buf.length, 0)).toString();
    };
    try {
      const file = join(dir, 'userlist.txt');
      writeFileSync(file, 'OLD-CONTENT\n');
      const held = openSync(file, 'r'); // opened while the old file existed (and might have been wide)
      try {
        if (process.platform === 'win32') {
          expect(() => {
            writeOwnerOnly(file, 'NEW-CONTENT\n');
          }).toThrow(/EPERM/);
          expect(readHeld(held)).toBe('OLD-CONTENT\n');
          expect(readFileSync(file, 'utf8')).toBe('OLD-CONTENT\n'); // untouched: replaced only once nothing holds it
        } else {
          writeOwnerOnly(file, 'NEW-CONTENT\n');
          expect(readHeld(held)).toBe('OLD-CONTENT\n'); // the old inode, not the new verifiers
          expect(readFileSync(file, 'utf8')).toBe('NEW-CONTENT\n');
        }
      } finally {
        closeSync(held);
      }
      if (process.platform === 'win32') {
        writeOwnerOnly(file, 'NEW-CONTENT\n'); // with the reader gone, the swap goes through
        expect(readFileSync(file, 'utf8')).toBe('NEW-CONTENT\n');
      }
      expect(ownerOnlyProblems(file)).toEqual([]);
      expect(readdirSync(dir)).toEqual(['userlist.txt']); // no temporary file left behind
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
