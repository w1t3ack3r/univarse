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
  // The owner's bypasses of 6d42a3a.
  nestedViaVariable: `${HEAD}export async function f(p: PlatformClient) {
  const data = { tenant: { update: { status: 'SUSPENDED' } } };
  await p.tenantDataKey.update({ where: { tenantId_version: { tenantId: 'x', version: 1 } }, data: data as never });
}`,
  nestedShorthand: `${HEAD}export async function f(p: PlatformClient, data: never) { await p.tenantDataKey.update({ where: { tenantId_version: { tenantId: 'x', version: 1 } }, data }); }`,
  nestedQuoted: `${HEAD}export async function f(p: PlatformClient) { await p.tenantDataKey.update({ where: { tenantId_version: { tenantId: 'x', version: 1 } }, data: { 'tenant': { 'update': { status: 'SUSPENDED' } } } as never }); }`,
  rawUnsafeSubstitution: `${HEAD}export async function f(p: PlatformClient, sql: string) { await p.$executeRawUnsafe(\`\${sql}\`); }`,
  rawExtracted: `${HEAD}export async function f(p: PlatformClient) { const run = p.$executeRawUnsafe.bind(p); await run('UPDATE tenant SET status = 1'); }`,
  fakeChannels: `import type { PlatformClient } from '@univarse/db';
import { InvalidationBus } from '../shared/infra/invalidation-bus.js';
const CHANNELS = { tenants: 'uv:products:invalidate' } as const;
export class W {
  constructor(private readonly platform: PlatformClient, private readonly bus: InvalidationBus) {}
  async go(id: string) {
    await this.platform.tenant.update({ where: { id }, data: { status: 'SUSPENDED' } });
    await this.bus.publish(CHANNELS.tenants, id); // a valid Channel value: no cast needed
  }
}`,
  helperBind: `${HEAD}export class S {
  constructor(private readonly platform: PlatformClient, private readonly bus: InvalidationBus) {}
  async setEnabled(id: string) { try { await this.undo(id); } finally { await this.invalidate(id); } }
  async other(id: string) { const f = this.undo.bind(this); await f(id); }
  async invalidate(id: string) { await this.bus.publish(CHANNELS.products, id); }
  private async undo(id: string) { await this.platform.tenantProduct.updateMany({ where: { id }, data: { enabled: false } }); }
}`,
  sameNamedPublisher: `${HEAD}class Other { async invalidate(id: string) { void id; } }
export class W {
  private readonly helper = new Other();
  constructor(private readonly platform: PlatformClient, private readonly bus: InvalidationBus) {}
  async go(id: string) {
    await this.platform.tenant.update({ where: { id }, data: { status: 'SUSPENDED' } });
    await this.helper.invalidate(id); // same name, another class: not the bound publisher
  }
  async invalidate(id: string) { await this.bus.publish(CHANNELS.tenants, id); }
}`,
  // A look-alike bus class: the real CHANNELS, but not the real InvalidationBus.
  fakeBus: `import type { PlatformClient } from '@univarse/db';
import { CHANNELS } from '../shared/infra/invalidation-bus.js';
class InvalidationBus { async publish(channel: string, id: string) { void channel; void id; return 1; } }
export class W {
  private readonly bus = new InvalidationBus();
  constructor(private readonly platform: PlatformClient) {}
  async go(id: string) {
    await this.platform.tenant.update({ where: { id }, data: { status: 'SUSPENDED' } });
    await this.bus.publish(CHANNELS.tenants, id);
  }
}`,
  // The owner's bypasses of 114c30e: SQL fragments in a tagged template, commented SQL, a deep nested write and
  // two differently scoped declarations sharing a label.
  rawFragment: `${HEAD}import { PlatformModels } from '@univarse/db';
export async function f(p: PlatformClient) { await p.$executeRaw\`\${PlatformModels.Prisma.raw('UPDATE tenant')} SET status = 'SUSPENDED'\`; }`,
  sqlFragment: `${HEAD}import { PlatformModels } from '@univarse/db';
export async function f(p: PlatformClient) { const t = PlatformModels.Prisma.sql\`UPDATE tenant SET status = 'SUSPENDED'\`; await p.$executeRaw\`\${t}\`; }`,
  sqlComment: `${HEAD}export async function f(p: PlatformClient) { await p.$executeRaw\`UPDATE /* comment */ tenant SET status = 'SUSPENDED'\`; }`,
  sqlNestedComment: `${HEAD}export async function f(p: PlatformClient) { await p.$executeRawUnsafe('UPDATE /* a /* b */ c */ tenant_product SET enabled = false'); }`,
  sqlLineComment: `${HEAD}export async function f(p: PlatformClient) { await p.$executeRawUnsafe('UPDATE -- note\\n tenant_domain SET hostname = hostname'); }`,
  deepNested: `${HEAD}export async function f(p: PlatformClient) {
  await p.shard.update({ where: { id: 'x' }, data: { tenants: { update: { where: { id: 'y' }, data: { products: { updateMany: { where: {}, data: { enabled: true } } } } } } } });
}`,
  scopedPublishers: `${HEAD}export function makeA(bus: InvalidationBus) {
  return class W { async invalidate(id: string) { await bus.publish(CHANNELS.tenants, id); } };
}
export class W {
  constructor(private readonly platform: PlatformClient, private readonly bus: InvalidationBus) {}
  async go(id: string) { await this.platform.tenant.update({ where: { id }, data: { status: 'SUSPENDED' } }); await this.invalidate(id); }
  async invalidate(id: string) { void id; void this.bus; }
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

describe(
  '[CI10] writers are bound to table and channel, fail closed (type-aware)',
  { timeout: 60_000 },
  () => {
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
      expect(check('sqlQualified').join('\n')).toMatch(
        /writes tenant \(\$executeRaw \(update public\.tenant\)\)/,
      );
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
          /S\.undo referenced from S\.other; it may only be called from S\.setEnabled/,
        ),
      ]);
    });

    it("[CI10] the owner's bypasses of 6d42a3a are all refused", () => {
      expect(check('nestedViaVariable').join('\n')).toMatch(
        /data for TenantDataKey is not an object literal/,
      );
      expect(check('nestedShorthand').join('\n')).toMatch(
        /`data` in the arguments to TenantDataKey\.update\(\) is not written out literally/,
      );
      expect(check('nestedQuoted').join('\n')).toMatch(
        /f writes tenant \(nested update via TenantDataKey\.tenant\)/,
      );
      expect(check('rawUnsafeSubstitution').join('\n')).toMatch(
        /\$executeRawUnsafe with SQL that isn't a substitution-free literal/,
      );
      expect(check('rawExtracted').join('\n')).toMatch(
        /\$executeRawUnsafe referenced other than by its immediate call/,
      );
      expect(check('fakeChannels', { [rel('fakeChannels')]: [W_BINDING] })).toEqual([
        expect.stringMatching(/W\.go makes no publish\(CHANNELS\.tenants/),
      ]);
      // A look-alike bus class with the real CHANNELS: not the real InvalidationBus.
      expect(check('fakeBus', { [rel('fakeBus')]: [W_BINDING] })).toEqual([
        expect.stringMatching(/W\.go makes no publish\(CHANNELS\.tenants/),
      ]);
      const helper = {
        writer: 'S.undo',
        table: 'tenant_product',
        channel: 'products',
        publisher: 'S.invalidate',
        calledOnlyFrom: 'S.setEnabled',
        proof: { file: '', test: '' },
      } as const;
      expect(check('helperBind', { [rel('helperBind')]: [helper] })).toEqual([
        expect.stringMatching(/S\.undo referenced other than as a direct call/),
      ]);
      const sameName = {
        writer: 'W.go',
        table: 'tenant',
        channel: 'tenants',
        publisher: 'W.invalidate',
        proof: { file: '', test: '' },
      } as const;
      expect(check('sameNamedPublisher', { [rel('sameNamedPublisher')]: [sameName] })).toEqual([
        expect.stringMatching(/W\.go writes tenant but never calls W\.invalidate/),
      ]);
    });

    it("[CI10] the owner's bypasses of 114c30e are all refused", () => {
      // An interpolated Prisma.raw / Prisma.sql fragment can carry SQL syntax: refused outright.
      expect(check('rawFragment').join('\n')).toMatch(/\$executeRaw interpolates a SQL fragment/);
      expect(check('sqlFragment').join('\n')).toMatch(/\$executeRaw interpolates a SQL fragment/);
      // Comments are read as PostgreSQL reads them: block, nested block and line comments.
      expect(check('sqlComment').join('\n')).toMatch(
        /f writes tenant \(\$executeRaw \(update tenant\)\)/,
      );
      expect(check('sqlNestedComment').join('\n')).toMatch(
        /f writes tenant_product \(\$executeRawUnsafe \(update tenant_product\)\)/,
      );
      expect(check('sqlLineComment').join('\n')).toMatch(
        /f writes tenant_domain \(\$executeRawUnsafe \(update tenant_domain\)\)/,
      );
      // Shard → Tenant → TenantProduct: the tenant_product write needs its own binding.
      const tenantOnly = {
        writer: 'f',
        table: 'tenant',
        channel: 'tenants',
        publisher: 'f',
        proof: { file: '', test: '' },
      } as const;
      expect(check('deepNested', { [rel('deepNested')]: [tenantOnly] })).toContainEqual(
        expect.stringMatching(
          /f writes tenant_product \(nested updateMany via Tenant\.products\) with no binding/,
        ),
      );
      // Two declarations labelled W.invalidate: the binding is ambiguous, not resolved to either.
      const scoped = {
        writer: 'W.go',
        table: 'tenant',
        channel: 'tenants',
        publisher: 'W.invalidate',
        proof: { file: '', test: '' },
      } as const;
      const out = check('scopedPublishers', { [rel('scopedPublishers')]: [scoped] });
      expect(out).toContainEqual(
        expect.stringMatching(/binding names W\.invalidate, which resolves to 2 declarations/),
      );
      expect(out).toContainEqual(
        expect.stringMatching(/W\.invalidate makes no publish\(CHANNELS\.tenants/),
      );
    });

    it('[CI10] earlier forms and tenant_domain are refused; reads are not writes', () => {
      expect(check('upsert').join('\n')).toMatch(/writes tenant_product \(upsert\(\)\)/);
      expect(check('destructure').join('\n')).toMatch(/destructuring a Prisma client/);
      expect(check('rawUnsafeVariable').join('\n')).toMatch(
        /\$executeRawUnsafe with SQL that isn't a substitution-free literal/,
      );
      expect(check('nested').join('\n')).toMatch(
        /writes tenant \(nested update via TenantDataKey\.tenant\)/,
      );
      expect(check('domain').join('\n')).toMatch(/writes tenant_domain \(create\(\)\)/);
      expect(check('reads')).toEqual([]);
    });
  },
);

describe('[CI9] one path to full-tenant destruction', { timeout: 60_000 }, () => {
  it('[CI9][CI11] only shared/crypto/key-forget.ts uses destroyTenantKeys', () => {
    const users = productionFiles(program)
      .filter((sf) => /\bdestroyTenantKeys\b/.test(sf.text))
      .map((sf) => relative(SRC, sf.fileName).replace(/\\/g, '/'));
    expect(users).toEqual(['shared/crypto/key-forget.ts']);
  });
});
