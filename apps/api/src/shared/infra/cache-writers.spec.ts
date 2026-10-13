// Spec 0015 CI9 and CI10: static guards over the API's production source (no DB, no Valkey).
//   • CI10, fail closed: ANY write to a guarded table (tenant, tenant_host, tenant_product), in any form the guard
//     can see (a Prisma delegate call, raw SQL, dynamic delegate access), is refused unless its file is a REVIEWED
//     writer. A reviewed writer must make an actual publish call on its channel (comments don't count), and must
//     name a test that proves post-commit publication, which must exist (owner review of #66).
//   • CI9: full-tenant key destruction is reachable only through KeyDestruction.shredTenantKeys.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../../', import.meta.url));

/** Every production .ts file under apps/api/src (tests and test helpers excluded). */
function productionFiles(dir = SRC): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== 'testing' && e.name !== 'generated') out.push(...productionFiles(p));
    } else if (
      e.name.endsWith('.ts') &&
      !/\.(int\.)?spec\.ts$/.test(e.name) &&
      !e.name.endsWith('.d.ts')
    )
      out.push(p);
  }
  return out;
}

/** Source with comments removed, so a channel name in a comment can't satisfy the guard. */
export const stripComments = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

const OPS =
  'create|createMany|createManyAndReturn|update|updateMany|updateManyAndReturn|upsert|delete|deleteMany';
/** Every form of write to a guarded table the guard recognises. Anything matched is refused unless reviewed. */
const GUARDED_WRITES: readonly { what: string; re: RegExp }[] = [
  {
    what: 'a delegate write',
    re: new RegExp(`\\b(tenant|tenantHost|tenantProduct)\\s*\\.\\s*(${OPS})\\s*\\(`, 'g'),
  },
  {
    what: 'raw SQL',
    re: /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+"?(tenant|tenant_host|tenant_product)"?(?![\w])/gi,
  },
  { what: 'dynamic delegate access', re: /\[\s*['"`](tenant|tenantHost|tenantProduct)['"`]\s*\]/g },
];

/** Reviewed writers: file → the channel it must publish on, and the test proving post-commit publication. */
export const REVIEWED_WRITERS: Record<
  string,
  { channel: string; proof: { file: string; test: string } }
> = {
  // Writes tenant_product.enabled (P4/P5), including the compensation. Publishes in setEnabled's `finally`.
  'modules/products/product.service.ts': {
    channel: 'CHANNELS.products',
    proof: {
      file: 'shared/infra/cache-isolation.int.spec.ts',
      test: '[CI1][CI10] the compensated path publishes too',
    },
  },
};

/** Problems in one file: guarded writes outside reviewed files, and reviewed files that don't really publish. */
export function writerViolations(
  file: string,
  text: string,
  reviewed = REVIEWED_WRITERS,
): string[] {
  const code = stripComments(text);
  const hits = GUARDED_WRITES.flatMap(({ what, re }) =>
    [...code.matchAll(re)].map((m) => `${what} (${m[0].trim()})`),
  );
  if (hits.length === 0)
    return reviewed[file]
      ? [`${file}: listed as a reviewed writer but writes no guarded table (stale entry)`]
      : [];
  const r = reviewed[file];
  if (!r)
    return hits.map(
      (h) =>
        `${file}: ${h} to a guarded table, outside the reviewed writers (add it there, with a post-commit publication test)`,
    );
  const publishes = new RegExp(`\\.publish\\(\\s*${r.channel.replace('.', '\\.')}\\s*,`).test(code);
  return publishes ? [] : [`${file}: a reviewed writer that never calls publish(${r.channel}, …)`];
}

describe('[CI10] future writers are bound, fail closed', () => {
  it('[CI10][CI11] production code writes guarded tables only in reviewed writers that really publish', () => {
    const files = productionFiles().map(
      (f) => [relative(SRC, f).replace(/\\/g, '/'), readFileSync(f, 'utf8')] as const,
    );
    const problems = files.flatMap(([f, text]) => writerViolations(f, text));
    for (const f of Object.keys(REVIEWED_WRITERS))
      if (!files.some(([g]) => g === f)) problems.push(`${f}: reviewed writer file is missing`);
    expect(problems).toEqual([]);
  });

  it('[CI10] every reviewed writer names a post-commit publication test that exists', () => {
    for (const [file, r] of Object.entries(REVIEWED_WRITERS)) {
      const proof = readFileSync(join(SRC, r.proof.file), 'utf8');
      expect(
        proof.includes(r.proof.test),
        `${file}: its proof test "${r.proof.test}" exists in ${r.proof.file}`,
      ).toBe(true);
    }
  });

  it('[CI10] the guard fails closed on every form it recognises, and a comment never satisfies it', () => {
    const none = {};
    for (const src of [
      `await tx.tenant.update({ where: { id }, data: { status: 'SUSPENDED' } });`,
      `await this.platform.tenantHost.create({ data: { host } });`,
      `await p.tenantProduct.upsert({ where, create: data, update: data });`, // variable-based data, upsert
      `const { tenant } = platform; await tenant.updateMany({ data: patch });`, // no leading dot
      'await tx.$executeRaw`UPDATE tenant SET status = ${s} WHERE id = ${id}`;', // raw SQL
      'await tx.$executeRawUnsafe(`INSERT INTO "tenant_host" (host) VALUES ($1)`, h);',
      `await (platform as any)['tenantProduct'].update({ data });`, // dynamic access
    ]) {
      expect(writerViolations('x.ts', src, none).length, src).toBeGreaterThan(0);
    }
    // A reviewed writer whose only mention of the channel is a comment is refused.
    const reviewed = { 'w.ts': { channel: 'CHANNELS.tenants', proof: { file: '', test: '' } } };
    expect(
      writerViolations(
        'w.ts',
        `await tx.tenant.update({ data: { status } }); // publishes on CHANNELS.tenants`,
        reviewed,
      ),
    ).toHaveLength(1);
    expect(
      writerViolations(
        'w.ts',
        `await tx.tenant.update({ data: { status } }); /* bus.publish(CHANNELS.tenants, id) */`,
        reviewed,
      ),
    ).toHaveLength(1);
    // A reviewed writer that only MENTIONS the channel in code, with no publish call on it, is refused.
    expect(
      writerViolations(
        'w.ts',
        `await tx.tenant.update({ data: { status } }); const c = CHANNELS.tenants; void c;`,
        reviewed,
      ),
    ).toHaveLength(1);
    // …and accepted once it really publishes.
    expect(
      writerViolations(
        'w.ts',
        `await tx.tenant.update({ data: { status } }); await this.bus.publish(CHANNELS.tenants, id);`,
        reviewed,
      ),
    ).toEqual([]);
    // A reviewed entry for a file that no longer writes is stale.
    expect(writerViolations('w.ts', `const x = 1;`, reviewed)).toEqual([
      'w.ts: listed as a reviewed writer but writes no guarded table (stale entry)',
    ]);
    // Reads are not writes.
    expect(
      writerViolations('r.ts', `await p.tenant.findMany({ where: { status: 'ACTIVE' } });`, none),
    ).toEqual([]);
  });
});

describe('[CI9] one path to full-tenant destruction', () => {
  it('[CI9][CI11] only shared/crypto/key-forget.ts imports destroyTenantKeys', () => {
    const importers = productionFiles()
      .filter((f) => /\bdestroyTenantKeys\b/.test(stripComments(readFileSync(f, 'utf8'))))
      .map((f) => relative(SRC, f).replace(/\\/g, '/'));
    expect(importers).toEqual(['shared/crypto/key-forget.ts']);
  });
});
