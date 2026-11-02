// Spec 0028 Q5, Q14: the owner's command, against a fake platform database (the shared test database already holds an
// OWNER, so only the refusal can be seen there: platform-identity.int.spec.ts).
import type { PlatformClient } from '@univarse/db';
import { describe, expect, it } from 'vitest';
import type { PlatformCredentials } from './credentials.js';
import { createFirstOwner, recoverOwner } from './owner.js';

interface Row {
  id: string;
  email: string;
  role: string;
  passwordHash: string | null;
  isActive: boolean;
}

function fake(users: Row[]) {
  const log: string[] = [];
  const tx = {
    $executeRaw: () => {
      log.push('lock');
      return Promise.resolve(1);
    },
    platformUser: {
      count: ({ where }: { where: { role: string } }) => Promise.resolve(users.filter((u) => u.role === where.role).length),
      findUnique: ({ where }: { where: { email: string } }) => Promise.resolve(users.find((u) => u.email === where.email) ?? null),
      create: ({ data }: { data: Omit<Row, 'id' | 'passwordHash' | 'isActive'> }) => {
        const row = { ...data, id: `u${String(users.length + 1)}`, passwordHash: null, isActive: true };
        users.push(row);
        log.push(`create ${row.role}`);
        return Promise.resolve({ id: row.id });
      },
      update: ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
        Object.assign(users.find((u) => u.id === where.id) ?? {}, data);
        log.push(`update ${Object.keys(data).sort().join(',')}`);
        return Promise.resolve({});
      },
    },
    platformSession: { updateMany: () => (log.push('end sessions'), Promise.resolve({ count: 2 })) },
    platformAuditEvent: {
      findFirst: () => Promise.resolve(null),
      create: ({ data }: { data: { action: string; actorId: string | null; metadata: unknown } }) => (log.push(`audit ${data.action} actor=${String(data.actorId)} ${JSON.stringify(data.metadata)}`), Promise.resolve({})),
    },
    platformMailOutbox: { create: ({ data }: { data: { toAddress: string; body: string } }) => (log.push(`mail ${data.toAddress} ${/code is \d{6}/.test(data.body) ? 'with code' : 'no code'}`), Promise.resolve({})) },
  };
  const db = { $transaction: (fn: (t: typeof tx) => Promise<unknown>) => fn(tx) } as unknown as PlatformClient;
  const creds = {
    issueCode: () => (log.push('code'), Promise.resolve('123456')),
    retireFactor: () => (log.push('retire factor'), Promise.resolve()),
  } as unknown as PlatformCredentials;
  return { db, creds, log, users };
}

describe('createFirstOwner (Q5)', () => {
  it('on an empty platform: an OWNER with no password, an activation code by email, audited with no actor', async () => {
    const f = fake([]);
    const out = await createFirstOwner(f.db, f.creds, { email: '  Ada@Example.NG ', displayName: ' Ada Owner ' });
    expect(out).toEqual({ ok: true, memberId: 'u1' });
    expect(f.users).toEqual([{ id: 'u1', email: 'ada@example.ng', displayName: 'Ada Owner', role: 'OWNER', passwordHash: null, isActive: true }]);
    expect(f.log).toEqual(['lock', 'create OWNER', 'code', 'lock', 'audit platform.owner.created actor=null {"memberId":"u1","via":"cli"}', 'mail ada@example.ng with code']);
  });

  it('refuses when any OWNER exists, even an inactive one, and creates nothing', async () => {
    const f = fake([{ id: 'x', email: 'old@example.ng', role: 'OWNER', passwordHash: 'h', isActive: false }]);
    const out = await createFirstOwner(f.db, f.creds, { email: 'new@example.ng', displayName: 'New Owner' });
    expect(out.ok).toBe(false);
    expect(f.log).toEqual(['lock']);
  });

  it('refuses a malformed email or name before touching the database', async () => {
    const f = fake([]);
    expect((await createFirstOwner(f.db, f.creds, { email: 'not-an-email', displayName: 'Ada' })).ok).toBe(false);
    expect((await createFirstOwner(f.db, f.creds, { email: 'a@b.ng', displayName: 'A' })).ok).toBe(false);
    expect(f.log).toEqual([]);
  });
});

describe('recoverOwner (Q14)', () => {
  it('clears the OWNER\'s password and factor, unlocks, ends sessions, and sends a new activation code', async () => {
    const f = fake([{ id: 'o1', email: 'ada@example.ng', role: 'OWNER', passwordHash: 'h', isActive: true }]);
    expect(await recoverOwner(f.db, f.creds, 'ADA@example.ng')).toEqual({ ok: true, memberId: 'o1' });
    expect(f.users[0]?.passwordHash).toBeNull();
    expect(f.log).toEqual(['lock', 'update failedLoginCount,isActive,lockedUntil,passwordHash', 'retire factor', 'end sessions', 'code', 'lock', 'audit platform.owner.recovered actor=null {"memberId":"o1","sessionsEnded":2,"via":"cli"}', 'mail ada@example.ng with code']);
  });

  it('only for an OWNER: anyone else is reset by an OWNER in the console', async () => {
    const f = fake([{ id: 's1', email: 'sam@example.ng', role: 'SUPPORT', passwordHash: 'h', isActive: true }]);
    expect((await recoverOwner(f.db, f.creds, 'sam@example.ng')).ok).toBe(false);
    expect(f.log).toEqual(['lock']);
  });
});
