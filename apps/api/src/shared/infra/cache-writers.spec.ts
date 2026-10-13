// Spec 0015 CI9 and CI10: static guards over the API's production source, with full type information.
//   • CI10 (fail closed, type-aware; owner reviews of c6dd715 and e89e48b): see testing/cache-writer-guard.ts.
//     Writes to tenant / tenant_domain / tenant_product are accepted only in the recognised form, inside a function
//     BOUND to that table and channel, whose publishing function really calls publish(CHANNELS.<channel>, …) on an
//     InvalidationBus, with a named runtime proof test. Every bypass the owner found is a regression fixture below.
//   • CI9: full-tenant key destruction is reachable only through KeyDestruction.shredTenantKeys.
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type * as TS from 'typescript';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  API_DIR,
  apiProgram,
  productionFiles,
  writerViolations,
  type Bindings,
} from '../../testing/cache-writer-guard.js';

const SRC = join(API_DIR, 'src');

/** The reviewed writers: each binds writer, table and channel, with its runtime proof of post-commit publication. */
export const REVIEWED_BINDINGS: Bindings = {
  'modules/products/product.service.ts': [
    {
      writer: 'ProductService.setEnabled',
      table: 'tenant_product',
      channel: 'products',
      publisher: 'ProductService.invalidate',
      proof: {
        file: 'shared/infra/cache-isolation.int.spec.ts',
        test: '[CI1][CI11] a toggle through instance 1 is served by instance 2',
      },
    },
    {
      writer: 'ProductService.compensate',
      table: 'tenant_product',
      channel: 'products',
      publisher: 'ProductService.invalidate',
      calledOnlyFrom: 'ProductService.setEnabled',
      proof: {
        file: 'shared/infra/cache-isolation.int.spec.ts',
        test: '[CI1][CI10] the compensated path publishes too',
      },
    },
  ],
};

// Fixtures: virtual files compiled with the real types, so the guard sees exactly what it sees in production.
const FIX = join(SRC, '__cache_guard_fixtures__');
const HEAD = `import type { PlatformClient } from '@univarse/db';\nimport { CHANNELS, InvalidationBus } from '../shared/infra/invalidation-bus.js';\nvoid CHANNELS; void InvalidationBus;\n`;
const FIXTURES: Record<string, string> = {
  // The owner's five bypasses of e89e48b.
  alias: `${HEAD}export async function f(p: PlatformClient) { const model = p.tenant; await model.update({ where: { id: 'x' }, data: { status: 'SUSPENDED' } }); }`,
  computed: `${HEAD}export async function f(p: PlatformClient, model: 'tenant' | 'tenantProduct') { await (p[model] as PlatformClient['tenant']).update({ where: { id: 'x' }, data: {} }); }`,
  sqlQualified: `${HEAD}export async function f(p: PlatformClient, s: string) { await p.$executeRaw\`UPDATE "public"."tenant" SET status = \${s} WHERE id = 'x'\`; }`,
  productsFileTenantWrite: `${HEAD}export class ProductService {
  constructor(private readonly platform: PlatformClient, private readonly bus: InvalidationBus) {}
  async setEnabled(id: string) {
    await this.platform.tenantProduct.updateMany({ where: { id }, data: { enabled: true } });
    await this.platform.tenant.update({ where: { id }, data: { status: 'SUSPENDED' } });
    await this.bus.publish(CHANNELS.products, id);
  }
}`,
  stringPublish: `${HEAD}export class W {
  constructor(private readonly platform: PlatformClient, private readonly bus: InvalidationBus) {}
  async go(id: string) {
    await this.platform.tenant.update({ where: { id }, data: { status: 'SUSPENDED' } });
    const s = '.publish(CHANNELS.tenants, id)'; void s; void this.bus;
  }
}`,
  // The positive control: the same writer, really publishing on its bound channel.
  realPublish: `${HEAD}export class W {
  constructor(private readonly platform: PlatformClient, private readonly bus: InvalidationBus) {}
  async go(id: string) {
    await this.platform.tenant.update({ where: { id }, data: { status: 'SUSPENDED' } });
    await this.bus.publish(CHANNELS.tenants, id);
  }
}`,
  // A helper writer (like ProductService.compensate) also reached from a second, non-publishing path.
  helperLeak: `${HEAD}export class S {
  constructor(private readonly platform: PlatformClient, private readonly bus: InvalidationBus) {}
  async setEnabled(id: string) { try { await this.undo(id); } finally { await this.invalidate(id); } }
  async other(id: string) { await this.undo(id); }
  async invalidate(id: string) { await this.bus.publish(CHANNELS.products, id); }
  private async undo(id: string) { await this.platform.tenantProduct.updateMany({ where: { id }, data: { enabled: false } }); }
}`,
  // Earlier forms, and the model the first guard missed entirely (tenant_domain holds the hosts).
  upsert: `${HEAD}export async function f(p: PlatformClient, data: never) { await p.tenantProduct.upsert(data); }`,
  destructure: `${HEAD}export async function f(p: PlatformClient) { const { tenant } = p; await tenant.findMany(); }`,
  rawUnsafeVariable: `${HEAD}export async function f(p: PlatformClient, sql: string) { await p.$executeRawUnsafe(sql); }`,
  nested: `${HEAD}export async function f(p: PlatformClient) { await p.tenantDataKey.create({ data: { version: 2, status: 'ACTIVE', tenant: { update: { status: 'SUSPENDED' } } } as never }); }`,
  domain: `${HEAD}export async function f(p: PlatformClient) { await p.tenantDomain.create({ data: { hostname: 'x.example', tenantId: 'x' } as never }); }`,
  reads: `${HEAD}export async function f(p: PlatformClient) { await p.tenant.findMany({ where: { status: 'ACTIVE' } }); await p.$queryRaw\`SELECT id FROM tenant\`; }`,
};
const fixturePath = (name: string) => join(FIX, `${name}.ts`);
const W_BINDING = {
  writer: 'W.go',
  table: 'tenant',
  channel: 'tenants',
  publisher: 'W.go',
  proof: { file: '', test: '' },
} as const;

let program: TS.Program;
beforeAll(() => {
  program = apiProgram(
    Object.fromEntries(Object.entries(FIXTURES).map(([n, t]) => [fixturePath(n), t])),
  );
}, 120_000);

const check = (name: string, bindings: Bindings = {}) => {
  const sf =
    program.getSourceFile(fixturePath(name).replace(/\\/g, '/')) ??
    program
      .getSourceFiles()
      .find((s) => s.fileName.replace(/\\/g, '/').endsWith(`__cache_guard_fixtures__/${name}.ts`));
  if (!sf) throw new Error(`fixture ${name} not in the program`);
  return writerViolations(program, [sf], bindings);
};
const rel = (name: string) => `__cache_guard_fixtures__/${name}.ts`;

describe('[CI10] writers are bound to table and channel, fail closed (type-aware)', { timeout: 60_000 }, () => {
  it('[CI10][CI11] production code writes guarded tables only through bound writers that really publish', () => {
    expect(writerViolations(program, productionFiles(program), REVIEWED_BINDINGS)).toEqual([]);
  });

  it('[CI10] every binding names a runtime post-commit publication test that exists', () => {
    for (const [file, list] of Object.entries(REVIEWED_BINDINGS)) {
      for (const b of list) {
        const proof = readFileSync(join(SRC, b.proof.file), 'utf8');
        expect(proof.includes(b.proof.test), `${file} ${b.writer}: proof "${b.proof.test}"`).toBe(
          true,
        );
      }
    }
  });

  it("[CI10] the owner's bypasses of e89e48b are all refused", () => {
    expect(check('alias').join('\n')).toMatch(/delegate is used other than/);
    expect(check('computed').join('\n')).toMatch(/computed access on a Prisma client/);
    expect(check('sqlQualified').join('\n')).toMatch(/writes tenant \(raw SQL/);
    // In the products file, bound to tenant_product + products: its tenant-status write has no binding.
    const products = {
      [rel('productsFileTenantWrite')]: [
        {
          writer: 'ProductService.setEnabled',
          table: 'tenant_product',
          channel: 'products',
          publisher: 'ProductService.setEnabled',
          proof: { file: '', test: '' },
        },
      ],
    } as Bindings;
    expect(check('productsFileTenantWrite', products)).toEqual([
      expect.stringMatching(
        /ProductService\.setEnabled writes tenant \(update\(\)\) with no binding for that writer and table/,
      ),
    ]);
    // A quoted string shaped like a publish call is not a publish call.
    expect(check('stringPublish', { [rel('stringPublish')]: [W_BINDING] })).toEqual([
      expect.stringMatching(/W\.go makes no publish\(CHANNELS\.tenants/),
    ]);
  });

  it('[CI10] the positive control: a bound writer that really publishes on its channel passes; the wrong channel does not', () => {
    expect(check('realPublish', { [rel('realPublish')]: [W_BINDING] })).toEqual([]);
    expect(
      check('realPublish', { [rel('realPublish')]: [{ ...W_BINDING, channel: 'products' }] }),
    ).toEqual([expect.stringMatching(/no publish\(CHANNELS\.products/)]);
    expect(check('realPublish')).toEqual([
      expect.stringMatching(/W\.go writes tenant \(update\(\)\) with no binding/),
    ]);
  });

  it('[CI10] a helper writer reached from any path other than its bound, publishing caller is refused', () => {
    const b = {
      writer: 'S.undo',
      table: 'tenant_product',
      channel: 'products',
      publisher: 'S.invalidate',
      calledOnlyFrom: 'S.setEnabled',
      proof: { file: '', test: '' },
    } as const;
    expect(check('helperLeak', { [rel('helperLeak')]: [b] })).toEqual([
      expect.stringMatching(
        /S\.undo must be called only from S\.setEnabled \(called from: .*S\.other/,
      ),
    ]);
  });

  it('[CI10] earlier forms and tenant_domain are refused; reads are not writes', () => {
    expect(check('upsert').join('\n')).toMatch(/writes tenant_product \(upsert\(\)\)/);
    expect(check('destructure').join('\n')).toMatch(/destructuring a Prisma client/);
    expect(check('rawUnsafeVariable').join('\n')).toMatch(/SQL that isn't a literal/);
    expect(check('nested').join('\n')).toMatch(/writes tenant \(nested update via tenant\)/);
    expect(check('domain').join('\n')).toMatch(/writes tenant_domain \(create\(\)\)/);
    expect(check('reads')).toEqual([]);
  });
});

describe('[CI9] one path to full-tenant destruction', { timeout: 60_000 }, () => {
  it('[CI9][CI11] only shared/crypto/key-forget.ts uses destroyTenantKeys', () => {
    const users = productionFiles(program)
      .filter((sf) => /\bdestroyTenantKeys\b/.test(sf.text))
      .map((sf) => relative(SRC, sf.fileName).replace(/\\/g, '/'));
    expect(users).toEqual(['shared/crypto/key-forget.ts']);
  });
});
