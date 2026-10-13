// Spec 0015 CI10, fail closed and type-aware (owner review of e89e48b). Test tooling: excluded from the build.
//
// The guarded tables, those whose changes must reach every instance's caches: `tenant` (status, slug = host),
// `tenant_domain` (hosts), `tenant_product` (entitlements and enabled flags). A write to one is accepted ONLY
// when all of these hold:
//   1. it is in the one recognised form: `<client>.<guardedDelegate>.<knownWriteMethod>(…)`, identified by the
//      Prisma delegate TYPE, not by name. Any other use of a guarded delegate (an alias, destructuring, computed
//      access on a Prisma client, passing it on, an unknown method) is a violation, whatever it does;
//   2. it sits in a function BOUND to that table (writer, table and channel are bound together);
//   3. the binding's publishing function makes an actual `publish(CHANNELS.<bound channel>, …)` call on an
//      InvalidationBus (resolved by type, so strings, comments and look-alikes never count);
//   4. if the writer isn't the publishing function itself, the writer is only ever called from it;
//   5. the binding names a runtime test proving publication after commit (or compensation), which must exist.
// Raw SQL (`$executeRaw*`, `$queryRaw*`, tagged or called) that writes a guarded table, schema-qualified and
// quoted forms included, counts as a write; raw SQL that isn't a literal fails closed. Nested relation writes to
// a guarded model, with relation fields read from the Prisma schemas, count as writes too.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type * as TS from 'typescript';

const require = createRequire(import.meta.url);
const ts = require('typescript') as typeof TS;

export const API_DIR = fileURLToPath(new URL('../../', import.meta.url));
const REPO = join(API_DIR, '../../');

/** Prisma delegate type → the table it writes. */
export const GUARDED_DELEGATES: Readonly<Record<string, string>> = {
  TenantDelegate: 'tenant',
  TenantDomainDelegate: 'tenant_domain',
  TenantProductDelegate: 'tenant_product',
};
const GUARDED_MODELS: Readonly<Record<string, string>> = {
  Tenant: 'tenant',
  TenantDomain: 'tenant_domain',
  TenantProduct: 'tenant_product',
};
const READS = new Set([
  'findMany',
  'findFirst',
  'findFirstOrThrow',
  'findUnique',
  'findUniqueOrThrow',
  'count',
  'aggregate',
  'groupBy',
]);
const WRITES = new Set([
  'create',
  'createMany',
  'createManyAndReturn',
  'update',
  'updateMany',
  'updateManyAndReturn',
  'upsert',
  'delete',
  'deleteMany',
]);
const NESTED_WRITES = new Set([
  'create',
  'createMany',
  'connectOrCreate',
  'update',
  'updateMany',
  'upsert',
  'delete',
  'deleteMany',
  'set',
]);
const RAW = new Set(['$executeRaw', '$executeRawUnsafe', '$queryRaw', '$queryRawUnsafe']);
const SQL_WRITE =
  /\b(insert\s+into|update|delete\s+from|merge\s+into|truncate(?:\s+table)?|alter\s+table)\s+(?:only\s+)?(?:[a-z_][a-z0-9_]*\.)?(tenant|tenant_domain|tenant_product)\b/;

export interface Binding {
  /** `Class.method` (or a function name) that performs the write. */
  readonly writer: string;
  readonly table: 'tenant' | 'tenant_domain' | 'tenant_product';
  /** The channel the publication must use: `CHANNELS.<channel>`. */
  readonly channel: 'products' | 'tenants';
  /** `Class.method` that makes the actual publish call (the writer itself, or a method it calls). */
  readonly publisher: string;
  /**
   * When the writer doesn't call the publisher itself (e.g. a compensation helper): the ONLY function allowed to
   * call the writer, which must itself call the publisher.
   */
  readonly calledOnlyFrom?: string;
  /** The runtime test proving publication after commit (or compensation). */
  readonly proof: { readonly file: string; readonly test: string };
}
export type Bindings = Readonly<Record<string, readonly Binding[]>>; // file (relative to apps/api/src) → bindings

/** Relation fields (in either Prisma schema) whose type is a guarded model: nested writes through them count. */
export function guardedRelationFields(): Map<string, string> {
  const out = new Map<string, string>();
  for (const schema of [
    'packages/db/prisma/platform/schema.prisma',
    'packages/db/prisma/tenant/schema.prisma',
  ]) {
    let text: string;
    try {
      text = readFileSync(join(REPO, schema), 'utf8');
    } catch {
      continue;
    }
    for (const m of text.matchAll(/^\s+(\w+)\s+(\w+)(\[\])?\??(?=\s|$)/gm)) {
      if (Object.hasOwn(GUARDED_MODELS, m[2]!)) out.set(m[1]!, GUARDED_MODELS[m[2]!]!);
    }
  }
  return out;
}

/** A program over the API's sources (plus optional virtual files), with types. */
export function apiProgram(virtual: Readonly<Record<string, string>> = {}): TS.Program {
  const cfg = ts.getParsedCommandLineOfConfigFile(
    join(API_DIR, 'tsconfig.json'),
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (d) => {
        throw new Error(ts.flattenDiagnosticMessageText(d.messageText, '\n'));
      },
    },
  );
  if (!cfg) throw new Error('could not read apps/api/tsconfig.json');
  const host = ts.createCompilerHost(cfg.options);
  const virt = new Map(
    Object.entries(virtual).map(([p, t]) => [ts.sys.resolvePath(p).replace(/\\/g, '/'), t]),
  );
  const norm = (f: string) => ts.sys.resolvePath(f).replace(/\\/g, '/');
  const getSourceFile = host.getSourceFile.bind(host);
  host.fileExists = (f) => virt.has(norm(f)) || ts.sys.fileExists(f);
  host.readFile = (f) => virt.get(norm(f)) ?? ts.sys.readFile(f);
  host.getSourceFile = (f, lang, onError, create) => {
    const v = virt.get(norm(f));
    return v !== undefined
      ? ts.createSourceFile(f, v, lang, true)
      : getSourceFile(f, lang, onError, create);
  };
  return ts.createProgram([...cfg.fileNames, ...virt.keys()], cfg.options, host);
}

/** The files the guard scans: production sources under apps/api/src (not tests, not test tooling). */
export function productionFiles(program: TS.Program): TS.SourceFile[] {
  const src = join(API_DIR, 'src').replace(/\\/g, '/');
  return program.getSourceFiles().filter((sf) => {
    const f = sf.fileName.replace(/\\/g, '/');
    return (
      f.startsWith(`${src}/`) &&
      !/\.(int\.)?spec\.ts$/.test(f) &&
      !f.includes('/testing/') &&
      !f.includes('/__cache_guard_fixtures__/') &&
      !f.endsWith('.d.ts')
    );
  });
}

interface Write {
  readonly fn: string;
  readonly table: string;
  readonly line: number;
  readonly how: string;
}

/** The enclosing `Class.method` or function name, or '<module>'. */
function enclosingName(node: TS.Node): string {
  // `parent` is typed as always set, but is undefined above the SourceFile: walk up to the SourceFile, no further.
  let n: TS.Node = node;
  while (!ts.isSourceFile(n)) {
    if (
      (ts.isMethodDeclaration(n) || ts.isGetAccessor(n) || ts.isSetAccessor(n)) &&
      ts.isIdentifier(n.name)
    ) {
      const cls = ts.isClassLike(n.parent) && n.parent.name ? n.parent.name.text : '<anon>';
      return `${cls}.${n.name.text}`;
    }
    if (ts.isFunctionDeclaration(n) && n.name) return n.name.text;
    if (ts.isConstructorDeclaration(n)) return `${n.parent.name?.text ?? '<anon>'}.constructor`;
    n = n.parent;
  }
  return '<module>';
}

/** Analyse one file: guarded writes found, violations of the recognised form, publish calls by function. */
export function analyzeFile(
  program: TS.Program,
  sf: TS.SourceFile,
  relations = guardedRelationFields(),
) {
  const checker = program.getTypeChecker();
  const writes: Write[] = [];
  const violations: string[] = [];
  const publishes = new Map<string, Set<string>>(); // fn → channels it publishes on
  const callers = new Map<string, Set<string>>(); // method name called via `this.<m>(` → enclosing fns
  const where = (n: TS.Node) =>
    `${relative(join(API_DIR, 'src'), sf.fileName).replace(/\\/g, '/')}:${String(sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1)}`;
  const typeName = (n: TS.Node) => {
    const t = checker.getTypeAtLocation(n);
    // getSymbol() is typed honestly: some types (e.g. primitives) have none.
    return (t.aliasSymbol ?? t.getSymbol())?.getName();
  };
  const guardedTable = (n: TS.Node) => {
    const name = typeName(n);
    return name && Object.hasOwn(GUARDED_DELEGATES, name) ? GUARDED_DELEGATES[name] : undefined;
  };
  const isPrismaClient = (n: TS.Node) => {
    const t = checker.getTypeAtLocation(n);
    return (
      ['tenant', 'tenantProduct', 'tenantDomain'].every((p) => t.getProperty(p) !== undefined) &&
      guardedTable(n) === undefined
    );
  };
  const staticSql = (n: TS.Node): string | null => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
    if (ts.isTemplateExpression(n))
      return [n.head.text, ...n.templateSpans.map((s) => ` $x ${s.literal.text}`)].join('');
    if (ts.isTaggedTemplateExpression(n)) return staticSql(n.template);
    return null;
  };
  const checkSql = (n: TS.Node, sqlNode: TS.Node | undefined, how: string) => {
    const text = sqlNode ? staticSql(sqlNode) : null;
    if (text === null) {
      violations.push(
        `${where(n)}: ${how} with SQL that isn't a literal: not checkable, refused (fail closed)`,
      );
      return;
    }
    const sql = text.toLowerCase().replace(/["`]/g, '').replace(/\s+/g, ' ');
    for (const m of sql.matchAll(new RegExp(SQL_WRITE.source, 'g')))
      writes.push({ fn: enclosingName(n), table: m[2]!, line: 0, how: `raw SQL (${m[0]})` });
  };

  const visit = (n: TS.Node): void => {
    // Guarded delegates: only `<client>.<delegate>.<method>(…)`, directly.
    if (
      ts.isExpression(n) &&
      !(ts.isIdentifier(n) && ts.isPropertyAccessExpression(n.parent) && n.parent.name === n)
    ) {
      const table = guardedTable(n);
      if (table) {
        const access = n.parent;
        const direct =
          ts.isPropertyAccessExpression(n) &&
          isPrismaClient(n.expression) &&
          ts.isPropertyAccessExpression(access) &&
          access.expression === n &&
          ts.isCallExpression(access.parent) &&
          access.parent.expression === access;
        if (!direct || !ts.isPropertyAccessExpression(access)) {
          violations.push(
            `${where(n)}: the ${table} delegate is used other than as \`<client>.<delegate>.<method>(…)\` (an alias, computed access or a value): refused (fail closed)`,
          );
        } else {
          const method = access.name.text;
          if (WRITES.has(method))
            writes.push({ fn: enclosingName(n), table, line: 0, how: `${method}()` });
          else if (!READS.has(method))
            violations.push(
              `${where(n)}: unknown ${table} delegate method ${method}(): refused (fail closed)`,
            );
        }
      }
    }
    // Computed access on a Prisma client: never checkable.
    if (ts.isElementAccessExpression(n) && isPrismaClient(n.expression)) {
      violations.push(`${where(n)}: computed access on a Prisma client: refused (fail closed)`);
    }
    // Destructuring a Prisma client.
    if (
      ts.isVariableDeclaration(n) &&
      ts.isObjectBindingPattern(n.name) &&
      n.initializer &&
      isPrismaClient(n.initializer)
    ) {
      violations.push(`${where(n)}: destructuring a Prisma client: refused (fail closed)`);
    }
    // Raw SQL.
    if (
      ts.isTaggedTemplateExpression(n) &&
      ts.isPropertyAccessExpression(n.tag) &&
      RAW.has(n.tag.name.text)
    )
      checkSql(n, n.template, n.tag.name.text);
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      RAW.has(n.expression.name.text)
    )
      checkSql(n, n.arguments[0], n.expression.name.text);
    // Nested relation writes to a guarded model, inside any Prisma call's arguments.
    if (
      ts.isPropertyAssignment(n) &&
      ts.isIdentifier(n.name) &&
      relations.has(n.name.text) &&
      ts.isObjectLiteralExpression(n.initializer)
    ) {
      const nested = n.initializer.properties.filter(
        (p) => p.name && ts.isIdentifier(p.name) && NESTED_WRITES.has(p.name.text),
      );
      const inPrismaCall = (() => {
        let p: TS.Node = n.parent;
        while (!ts.isSourceFile(p)) {
          if (ts.isCallExpression(p) && ts.isPropertyAccessExpression(p.expression)) {
            const t = typeName(p.expression.expression);
            if (t?.endsWith('Delegate')) return true;
          }
          p = p.parent;
        }
        return false;
      })();
      if (nested.length && inPrismaCall)
        writes.push({
          fn: enclosingName(n),
          table: relations.get(n.name.text)!,
          line: 0,
          how: `nested ${(nested[0]!.name as TS.Identifier).text} via ${n.name.text}`,
        });
    }
    // Publish calls, resolved by type: <InvalidationBus>.publish(CHANNELS.<x>, …).
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === 'publish' &&
      typeName(n.expression.expression) === 'InvalidationBus'
    ) {
      const arg = n.arguments[0];
      if (
        arg &&
        ts.isPropertyAccessExpression(arg) &&
        ts.isIdentifier(arg.expression) &&
        arg.expression.text === 'CHANNELS'
      ) {
        const fn = enclosingName(n);
        publishes.set(fn, (publishes.get(fn) ?? new Set()).add(arg.name.text));
      }
    }
    // `this.<method>(…)` calls, to check a writer is called only from its publishing function.
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.expression.kind === ts.SyntaxKind.ThisKeyword
    ) {
      const m = n.expression.name.text;
      callers.set(m, (callers.get(m) ?? new Set()).add(enclosingName(n)));
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return {
    writes: writes.map((w) => ({ ...w, where: where(sf) })),
    violations,
    publishes,
    callers,
  };
}

/** Every CI10 violation over `files`, given the bindings (file paths relative to apps/api/src). */
export function writerViolations(
  program: TS.Program,
  files: readonly TS.SourceFile[],
  bindings: Bindings,
): string[] {
  const relations = guardedRelationFields();
  const out: string[] = [];
  const used = new Set<Binding>();
  for (const sf of files) {
    const rel = relative(join(API_DIR, 'src'), sf.fileName).replace(/\\/g, '/');
    const a = analyzeFile(program, sf, relations);
    out.push(...a.violations);
    const bound = bindings[rel] ?? [];
    for (const w of a.writes) {
      const b = bound.find((x) => x.writer === w.fn && x.table === w.table);
      if (!b) {
        out.push(
          `${rel}: ${w.fn} writes ${w.table} (${w.how}) with no binding for that writer and table: refused`,
        );
        continue;
      }
      used.add(b);
      const method = (fn: string) => fn.split('.').pop()!;
      const calls = (caller: string, callee: string) =>
        caller === callee || (a.callers.get(method(callee))?.has(caller) ?? false);
      if (!a.publishes.get(b.publisher)?.has(b.channel)) {
        out.push(
          `${rel}: ${b.writer} writes ${b.table}, but ${b.publisher} makes no publish(CHANNELS.${b.channel}, …) call on an InvalidationBus`,
        );
      }
      if (b.calledOnlyFrom) {
        const from = [...(a.callers.get(method(b.writer)) ?? [])];
        if (from.length === 0 || from.some((c) => c !== b.calledOnlyFrom)) {
          out.push(
            `${rel}: ${b.writer} must be called only from ${b.calledOnlyFrom} (called from: ${from.join(', ') || 'nowhere'})`,
          );
        }
        if (!calls(b.calledOnlyFrom, b.publisher))
          out.push(`${rel}: ${b.calledOnlyFrom} never calls ${b.publisher}`);
      } else if (!calls(b.writer, b.publisher)) {
        out.push(`${rel}: ${b.writer} writes ${b.table} but never calls ${b.publisher}`);
      }
    }
  }
  for (const [file, list] of Object.entries(bindings)) {
    for (const b of list) {
      if (
        !used.has(b) &&
        files.some((sf) => relative(join(API_DIR, 'src'), sf.fileName).replace(/\\/g, '/') === file)
      ) {
        out.push(`${file}: binding ${b.writer} → ${b.table} matches no write (stale)`);
      }
    }
  }
  return out;
}
