// Password hashing & policy — docs/08-security.md §3.1, ADR-016 (Node built-in Argon2id).
import { argon2, randomBytes, timingSafeEqual } from 'node:crypto';

const PARAMS = { memory: 19_456, passes: 2, parallelism: 1, tagLength: 32 } as const;
const PHC = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;

const b64 = (b: Buffer) => b.toString('base64').replace(/=+$/, '');

function derive(password: string, salt: Buffer, p: { memory: number; passes: number; parallelism: number; tagLength: number }) {
  return new Promise<Buffer>((resolve, reject) =>
    argon2('argon2id', { message: password.normalize('NFKC'), nonce: salt, ...p }, (err, key) =>
      err ? reject(err) : resolve(key),
    ),
  );
}

/** Returns a PHC string: $argon2id$v=19$m=…,t=…,p=…$<salt>$<hash> */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await derive(password, salt, PARAMS);
  return `$argon2id$v=19$m=${PARAMS.memory},t=${PARAMS.passes},p=${PARAMS.parallelism}$${b64(salt)}$${b64(hash)}`;
}

export async function verifyPassword(password: string, phc: string): Promise<boolean> {
  const m = PHC.exec(phc);
  if (!m) return false;
  const expected = Buffer.from(m[5]!, 'base64');
  const actual = await derive(password, Buffer.from(m[4]!, 'base64'), {
    memory: Number(m[1]),
    passes: Number(m[2]),
    parallelism: Number(m[3]),
    tagLength: expected.length,
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** True when a stored hash uses weaker parameters than current policy (rehash on next login). */
export function needsRehash(phc: string): boolean {
  const m = PHC.exec(phc);
  return !m || Number(m[1]) < PARAMS.memory || Number(m[2]) < PARAMS.passes;
}

let dummy: Promise<string> | undefined;
/** Burns comparable time for unknown users so response timing doesn't reveal account existence. */
export async function verifyAgainstDummy(password: string): Promise<void> {
  dummy ??= hashPassword('univarse-timing-equaliser');
  await verifyPassword(password, await dummy);
}

// Small offline deny-list; HIBP k-anonymity check is a later addition (docs/08 §3.1).
const COMMON = new Set([
  'password', 'password1', 'password123', 'passw0rd', '12345678', '123456789', '1234567890',
  '11111111', '00000000', 'qwerty123', 'qwertyuiop', 'iloveyou', 'abcd1234', 'admin123',
  'welcome1', 'letmein1', 'univarse', 'nigeria1', 'nigeria123', 'student1', 'lecturer1',
]);

export type PasswordProblem = 'too_short' | 'too_long' | 'too_common' | 'contains_personal_info';

/** NIST 800-63B style: length + deny-list + context, no composition rules. */
export function passwordProblems(password: string, opts: { minLength: 8 | 12; context: string[] }): PasswordProblem[] {
  const pw = password.normalize('NFKC');
  const problems: PasswordProblem[] = [];
  if ([...pw].length < opts.minLength) problems.push('too_short');
  if ([...pw].length > 128) problems.push('too_long');
  if (COMMON.has(pw.toLowerCase())) problems.push('too_common');
  const lower = pw.toLowerCase();
  if (
    opts.context
      .flatMap((c) => c.toLowerCase().split(/[^\p{L}\p{N}]+/u))
      .some((part) => part.length >= 4 && lower.includes(part))
  ) {
    problems.push('contains_personal_info');
  }
  return problems;
}
