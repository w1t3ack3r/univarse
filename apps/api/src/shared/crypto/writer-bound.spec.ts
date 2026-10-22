// Spec 0020 D15 (BK15): the writer bound, as a static guard over the API's production source (testing/writer-bound-guard.ts).
// The fixtures are the ways an encryption can escape its writing transaction; each must be caught.
import { join } from 'node:path';
import type * as TS from 'typescript';
import { beforeAll, describe, expect, it } from 'vitest';
import { API_DIR, apiProgram, productionFiles } from '../../testing/cache-writer-guard.js';
import { writerBoundReport, type LongTransactions } from '../../testing/writer-bound-guard.js';

const SRC = join(API_DIR, 'src');

/** Reviewed tenant transactions with their own (longer) timeout. None of them encrypts. */
export const LONG_TRANSACTIONS: LongTransactions = {
  'shared/outbox/outbox-worker.ts OutboxWorker.runTenant':
    'delivers claimed emails (SMTP inside the claim); only decrypts and updates delivery state, never writes an encrypted value',
};

const FIX = join(SRC, '__cache_guard_fixtures__', 'writer-bound');
const HEAD = `import { FieldCrypto } from '@univarse/crypto';
import { withTenantTx, type TenantShardClient, type TenantTx } from '@univarse/db';
import { ShardRegistry } from '../../shared/db/db.module.js';
void withTenantTx; void ShardRegistry;
`;
const pt = `Buffer.from('x')`;
const FIXTURES: Record<string, string> = {
  // Encrypted before the transaction, written inside it: the classic slow-writer race.
  before: `${HEAD}export async function f(fc: FieldCrypto, s: ShardRegistry) { const enc = await fc.encrypt('t', ${pt}, 'a'); await s.tx('s', 't', (tx) => tx.outboxEvent.create({ data: { tenantId: 't', type: 'email', payloadEnc: enc } })); }`,
  // Inside the callback, but deferred past the commit.
  deferred: `${HEAD}export async function f(fc: FieldCrypto, s: ShardRegistry) { await s.tx('s', 't', async () => { setTimeout(async () => { await fc.encrypt('t', ${pt}, 'a'); }, 0); }); }`,
  notAwaited: `${HEAD}export async function f(fc: FieldCrypto, s: ShardRegistry) { await s.tx('s', 't', async () => { void fc.encrypt('t', ${pt}, 'a'); }); }`,
  aliased: `${HEAD}export async function f(fc: FieldCrypto) { const e = fc.encrypt.bind(fc); return e('t', ${pt}, 'a'); }`,
  element: `${HEAD}export async function f(fc: FieldCrypto) { return fc['encrypt']('t', ${pt}, 'a'); }`,
  destructured: `${HEAD}export async function f(fc: FieldCrypto) { const { reencrypt } = fc; return reencrypt; }`,
  // A plain function that is handed something that is not a tenant transaction.
  notTx: `${HEAD}export async function f(fc: FieldCrypto, shard: TenantShardClient) { await shard.outboxEvent.create({ data: { tenantId: 't', type: 'email', payloadEnc: await fc.encrypt('t', ${pt}, 'a') } }); }`,
  // The active version read outside the sweep's transaction (the gap PR A1 fixed in key-maintenance.ts).
  activeOutside: `${HEAD}export async function f(fc: FieldCrypto, s: ShardRegistry) { const v = await fc.activeVersion('t'); await s.tx('s', 't', async (tx) => { await tx.$executeRaw\`SELECT \${v}\`; }); }`,
  // A tenant transaction with its own timeout that nobody reviewed.
  longTx: `${HEAD}export async function f(shard: TenantShardClient) { await withTenantTx(shard, 't', async () => 1, { timeoutMs: 120_000 }); }`,
  // Accepted forms: rule B (a TenantTx parameter) and rule A (inside the callback, awaited).
  okB: `${HEAD}export async function f(fc: FieldCrypto, tx: TenantTx) { await tx.outboxEvent.create({ data: { tenantId: 't', type: 'email', payloadEnc: await fc.encrypt('t', ${pt}, 'a') } }); }`,
  okA: `${HEAD}export async function f(fc: FieldCrypto, shard: TenantShardClient) { await withTenantTx(shard, 't', async (tx) => { const e = await fc.encrypt('t', ${pt}, 'a'); await tx.outboxEvent.create({ data: { tenantId: 't', type: 'email', payloadEnc: e } }); }); }`,
};

let program: TS.Program;
beforeAll(() => {
  program = apiProgram(Object.fromEntries(Object.entries(FIXTURES).map(([k, v]) => [join(FIX, `${k}.ts`), v])));
});

const fixture = (name: string) => program.getSourceFiles().filter((sf) => sf.fileName.replace(/\\/g, '/').endsWith(`/writer-bound/${name}.ts`));

describe('[D15][BK15] the writer bound', { timeout: 60_000 }, () => {
  it('[BK15] every encryption in production code runs inside its writing tenant transaction, and no long transaction encrypts', () => {
    const r = writerBoundReport(program, productionFiles(program), LONG_TRANSACTIONS);
    expect(r.violations).toEqual([]);
    // Not vacuous: the known writers are found, each under the rule that admits it.
    expect(r.sites.map((s) => `${s.file} ${s.method} ${s.rule}`).sort()).toEqual([
      'modules/identity/mfa.service.ts MfaService.beginEnrolment → encrypt B',
      'shared/crypto/key-maintenance.ts KeyMaintenance.sweepBatch → activeVersion A',
      'shared/crypto/key-maintenance.ts KeyMaintenance.sweepBatch → reencrypt A',
      'shared/outbox/outbox.ts Outbox.enqueueEmail → encrypt B',
    ]);
  });

  it.each([
    ['before', /outside its writing tenant transaction/],
    ['deferred', /outside its writing tenant transaction/],
    ['notAwaited', /is not awaited/],
    ['aliased', /referenced without being called/],
    ['element', /accessed by element/],
    ['destructured', /destructured/],
    ['notTx', /outside its writing tenant transaction/],
    ['activeOutside', /FieldCrypto\.activeVersion outside/],
    ['longTx', /not a reviewed long transaction/],
  ])('[BK15] catches %s', (name, expected) => {
    expect(writerBoundReport(program, fixture(name), {}).violations.join('\n')).toMatch(expected);
  });

  it('[BK15] accepts the two sanctioned forms', () => {
    expect(writerBoundReport(program, [...fixture('okA'), ...fixture('okB')], {}).violations).toEqual([]);
  });

  it('[BK15] a reviewed long transaction must exist, and its file must not encrypt or call a writer', () => {
    const files = productionFiles(program);
    expect(writerBoundReport(program, files, { ...LONG_TRANSACTIONS, 'shared/outbox/outbox-worker.ts Gone.method': 'x' }).violations).toEqual([
      'reviewed long transaction not found (stale entry): shared/outbox/outbox-worker.ts Gone.method',
    ]);
    const report = writerBoundReport(program, [...files, ...fixture('longTx')], {
      ...LONG_TRANSACTIONS,
      'shared/outbox/outbox.ts Outbox.enqueueEmail': 'x',
      '__cache_guard_fixtures__/writer-bound/longTx.ts f': 'x',
    });
    expect(report.violations.join('\n')).toMatch(/reviewed long transaction's file encrypts: shared\/outbox\/outbox\.ts/);
  });
});
