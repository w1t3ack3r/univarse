// Spec 0015 CI9 and CI10: static guards over the API's production source (no DB, no Valkey).
//   • CI10: whatever first writes a tenant's status or hosts, or a product entitlement, must publish the matching
//     invalidation. Today nothing does (the seed and test fixtures live outside src/ or in *.spec.ts files).
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

/** Write calls on a Prisma model delegate, e.g. `.tenant.update(` or `tenantHost.createMany(`. */
const writes = (model: string) =>
  new RegExp(
    `\\.${model}\\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\\(`,
    'g',
  );

/** The rules: a writer of these must publish on the channel. `when` narrows writes to the guarded field. */
const RULES = [
  { what: 'tenant status', model: 'tenant', when: /status/, channel: 'CHANNELS.tenants' },
  { what: 'tenant hosts', model: 'tenantHost', when: /./, channel: 'CHANNELS.tenants' },
  {
    what: 'product entitlements',
    model: 'tenantProduct',
    when: /entitled\s*:/,
    channel: 'CHANNELS.products',
  },
] as const;

/** Violations in one file's text: guarded writes in a file that never publishes on the channel. */
export function writerViolations(file: string, text: string): string[] {
  const out: string[] = [];
  for (const r of RULES) {
    for (const m of text.matchAll(writes(r.model))) {
      // The call's argument text, up to its matching close (a bounded window is enough for these literals).
      const call = text.slice(m.index, m.index + 600);
      const data = /data:\s*\{([^}]*)\}/.exec(call)?.[1] ?? (r.model === 'tenantHost' ? 'x' : '');
      if (!r.when.test(data)) continue;
      if (!text.includes(r.channel))
        out.push(`${file}: writes ${r.what} (${m[0]}) without publishing on ${r.channel}`);
    }
  }
  return out;
}

describe('[CI10] future writers are bound', () => {
  it('[CI10][CI11] no production code writes tenant status/hosts or product entitlements without publishing', () => {
    const problems = productionFiles().flatMap((f) =>
      writerViolations(relative(SRC, f), readFileSync(f, 'utf8')),
    );
    expect(problems).toEqual([]);
  });

  it('[CI10] the guard catches each kind of writer, and accepts one that publishes', () => {
    expect(
      writerViolations(
        'a.ts',
        `await tx.tenant.update({ where: { id }, data: { status: 'SUSPENDED' } });`,
      ),
    ).toHaveLength(1);
    expect(
      writerViolations('b.ts', `await this.platform.tenantHost.create({ data: { host } });`),
    ).toHaveLength(1);
    expect(
      writerViolations(
        'c.ts',
        `await p.tenantProduct.updateMany({ where: {}, data: { entitled: false } });`,
      ),
    ).toHaveLength(1);
    // Toggling `enabled` is not an entitlement write (ProductService already publishes for it anyway).
    expect(
      writerViolations(
        'd.ts',
        `await p.tenantProduct.updateMany({ where: { entitled: true }, data: { enabled } });`,
      ),
    ).toEqual([]);
    expect(
      writerViolations(
        'e.ts',
        `await tx.tenant.update({ data: { status: 'X' } }); await bus.publish(CHANNELS.tenants, id);`,
      ),
    ).toEqual([]);
  });
});

describe('[CI9] one path to full-tenant destruction', () => {
  it('[CI9][CI11] only shared/crypto/key-forget.ts imports destroyTenantKeys', () => {
    const importers = productionFiles()
      .filter((f) => /\bdestroyTenantKeys\b/.test(readFileSync(f, 'utf8')))
      .map((f) => relative(SRC, f).replace(/\\/g, '/'));
    expect(importers).toEqual(['shared/crypto/key-forget.ts']);
  });
});
