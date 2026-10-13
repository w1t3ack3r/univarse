// Spec 0015 CI10: a type-aware, fail-closed guard over writes to the cache-relevant tables (owner reviews of #66:
// c6dd715, e89e48b, 6d42a3a). Test tooling: excluded from the build.
//
// Guarded tables: `tenant` (status; slug = host), `tenant_domain` (hosts), `tenant_product` (entitlements, enabled).
// Every identity below is resolved through the type checker (symbols and declarations), never by name.
//
// A write to a guarded table is accepted ONLY when all of these hold:
//   1. FORM: `<client>.<guardedDelegate>.<knownWriteMethod>(…)`, the delegate identified by its Prisma type. Any other
//      use of a guarded delegate (alias, destructuring, computed access on a client, a value, an unknown method) and
//      any reference to a raw-SQL method other than its immediate call (`.bind`, extraction) is refused.
//   2. INPUTS: a write on ANY delegate whose model has a relation to a guarded model must be statically analysable
//      where it could reach one: `data` / `create` / `update` are object literals (arrays of them for createMany),
//      keys are identifiers or string literals, no spreads or computed keys; under a relation field to a guarded
//      model the value is itself literal, and any nested write there counts as a write to that table.
//   3. RAW SQL: `$executeRaw`/`$queryRaw` tagged templates are checked on their static text (interpolations are
//      bound parameters); the `…Unsafe` variants must be a literal with NO substitutions. Writes to a guarded table
//      in any quoting or schema qualification count; anything not checkable is refused.
//   4. BINDING: the write sits in a function bound (writer → table → channel → publisher). The publisher makes an
//      actual `publish(CHANNELS.<channel>, …)` call on the real InvalidationBus, with `CHANNELS` resolved to its
//      declaration in shared/infra/invalidation-bus.ts (a local look-alike never counts).
//   5. PATH: the writer calls the publisher (the call target resolved to its declaration), or every reference to the
//      writer's method symbol is the direct callee of a call inside its one bound caller, which calls the publisher.
//   6. PROOF: the binding names a runtime test proving publication after commit or compensation (with an ordering
//      assertion), which must exist.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type * as TS from 'typescript';

const require = createRequire(import.meta.url);
const ts = require('typescript') as typeof TS;

export const API_DIR = fileURLToPath(new URL('../../', import.meta.url));
const REPO = join(API_DIR, '../../');
const SRC = join(API_DIR, 'src');
const BUS_FILE = join(SRC, 'shared/infra/invalidation-bus.ts').replace(/\\/g, '/');

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
/** Argument properties that carry written values. */
const DATA_KEYS = new Set(['data', 'create', 'update']);
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
  /\b(insert\s+into|update|delete\s+from|merge\s+into|truncate(?:\s+table)?|alter\s+table)\s+(?:only\s+)?(?:[a-z_][a-z0-9_]*\.)?(tenant|tenant_domain|tenant_product)\b/g;

export interface Binding {
  /** `Class.method` (or a function name) that performs the write. */
  readonly writer: string;
  readonly table: 'tenant' | 'tenant_domain' | 'tenant_product';
  /** The channel: `CHANNELS.<channel>` from shared/infra/invalidation-bus.ts. */
  readonly channel: 'products' | 'tenants';
  /** `Class.method` that makes the actual publish call (the writer itself, or a method it calls). */
  readonly publisher: string;
  /** When the writer doesn't call the publisher itself: its ONLY permitted caller, which must call the publisher. */
  readonly calledOnlyFrom?: string;
  /** The runtime test proving publication after commit (or compensation), with an ordering assertion. */
  readonly proof: { readonly file: string; readonly test: string };
}
export type Bindings = Readonly<Record<string, readonly Binding[]>>; // file (relative to apps/api/src) → bindings

/** Every model's relation fields that point at a guarded model: model → field → guarded table. */
export function guardedRelations(): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
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
    for (const block of text.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
      const fields = new Map<string, string>();
      for (const m of block[2]!.matchAll(/^\s+(\w+)\s+(\w+)(\[\])?\??(?=\s|$)/gm)) {
        if (Object.hasOwn(GUARDED_MODELS, m[2]!)) fields.set(m[1]!, GUARDED_MODELS[m[2]!]!);
      }
      if (fields.size) out.set(block[1]!, fields);
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
  const norm = (f: string) => ts.sys.resolvePath(f).replace(/\\/g, '/');
  const virt = new Map(Object.entries(virtual).map(([p, t]) => [norm(p), t]));
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

/** Production sources under apps/api/src (not tests, not test tooling, not the guard's fixtures). */
export function productionFiles(program: TS.Program): TS.SourceFile[] {
  const src = SRC.replace(/\\/g, '/');
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

const relPath = (f: string) => relative(SRC, f).replace(/\\/g, '/');

/** The qualified name of a function-like declaration: `Class.method`, or a function's name. */
function qualifiedName(decl: TS.Node): string | null {
  if (
    (ts.isMethodDeclaration(decl) || ts.isGetAccessor(decl) || ts.isSetAccessor(decl)) &&
    ts.isIdentifier(decl.name)
  ) {
    const cls = ts.isClassLike(decl.parent) && decl.parent.name ? decl.parent.name.text : '<anon>';
    return `${cls}.${decl.name.text}`;
  }
  if (ts.isFunctionDeclaration(decl) && decl.name) return decl.name.text;
  if (ts.isConstructorDeclaration(decl)) return `${decl.parent.name?.text ?? '<anon>'}.constructor`;
  return null;
}

/** The enclosing function's qualified name, or '<module>'. `parent` is undefined above the SourceFile. */
function enclosingName(node: TS.Node): string {
  let n: TS.Node = node;
  while (!ts.isSourceFile(n)) {
    const q = qualifiedName(n);
    if (q) return q;
    n = n.parent;
  }
  return '<module>';
}

interface Analysis {
  readonly writes: { fn: string; table: string; how: string }[];
  readonly violations: string[];
  /** Qualified function → channels it publishes on (verified CHANNELS, verified bus). */
  readonly publishes: Map<string, Set<string>>;
  /** Qualified caller → qualified callees (resolved declarations in this program). */
  readonly calls: Map<string, Set<string>>;
  /** Qualified method → every reference: whether it is a direct call's callee, and the enclosing function. */
  readonly references: Map<string, { direct: boolean; from: string; at: string }[]>;
}

/** Analyse one file. */
export function analyzeFile(
  program: TS.Program,
  sf: TS.SourceFile,
  relations = guardedRelations(),
): Analysis {
  const checker = program.getTypeChecker();
  const a: Analysis = {
    writes: [],
    violations: [],
    publishes: new Map(),
    calls: new Map(),
    references: new Map(),
  };
  const where = (n: TS.Node) =>
    `${relPath(sf.fileName)}:${String(sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1)}`;
  const refuse = (n: TS.Node, why: string) =>
    a.violations.push(`${where(n)}: ${why}: refused (fail closed)`);

  const typeSymbolName = (n: TS.Node) => {
    const t = checker.getTypeAtLocation(n);
    return (t.aliasSymbol ?? t.getSymbol())?.getName();
  };
  /** The model of a Prisma delegate expression (`TenantDelegate` → `Tenant`), or undefined. */
  const delegateModel = (n: TS.Node) => {
    const name = typeSymbolName(n);
    return name?.endsWith('Delegate') ? name.slice(0, -'Delegate'.length) : undefined;
  };
  const guardedTable = (n: TS.Node) => {
    const model = delegateModel(n);
    return model && Object.hasOwn(GUARDED_MODELS, model) ? GUARDED_MODELS[model] : undefined;
  };
  const isPrismaClient = (n: TS.Node) => {
    const t = checker.getTypeAtLocation(n);
    return (
      ['tenant', 'tenantProduct', 'tenantDomain'].every((p) => t.getProperty(p) !== undefined) &&
      guardedTable(n) === undefined
    );
  };
  /** The declaration a symbol finally refers to (following import aliases). */
  const declOf = (n: TS.Node): TS.Declaration | undefined => {
    let sym = checker.getSymbolAtLocation(n);
    if (sym && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
    return sym?.valueDeclaration ?? sym?.declarations?.[0];
  };
  const declaredIn = (d: TS.Node | undefined, file: string) =>
    !!d && d.getSourceFile().fileName.replace(/\\/g, '/') === file;
  /** True when the expression's type is the real InvalidationBus class (declared in shared/infra/invalidation-bus.ts). */
  const isRealBus = (n: TS.Node) => {
    const sym = checker.getTypeAtLocation(n).getSymbol();
    return (
      sym?.getName() === 'InvalidationBus' &&
      declaredIn(sym.valueDeclaration ?? sym.declarations?.[0], BUS_FILE)
    );
  };
  const propName = (p: TS.ObjectLiteralElementLike): string | null => {
    if (!p.name) return null;
    if (
      ts.isIdentifier(p.name) ||
      ts.isStringLiteral(p.name) ||
      ts.isNoSubstitutionTemplateLiteral(p.name)
    )
      return p.name.text;
    return null; // computed
  };

  /** Type-only wrappers (`as`, `satisfies`, `!`, parentheses, `<T>`) change no runtime value: look through them. */
  const strip = (e: TS.Expression): TS.Expression =>
    ts.isAsExpression(e) ||
    ts.isSatisfiesExpression(e) ||
    ts.isNonNullExpression(e) ||
    ts.isParenthesizedExpression(e) ||
    ts.isTypeAssertionExpression(e)
      ? strip(e.expression)
      : e;

  /** INPUTS: a written-value object under a model with relations to guarded models. */
  const checkDataObject = (raw: TS.Expression, model: string, fn: string, path: string): void => {
    const n = strip(raw);
    const rels = relations.get(model);
    if (!rels) return; // this model can't reach a guarded table
    if (ts.isArrayLiteralExpression(n)) {
      for (const e of n.elements) checkDataObject(e, model, fn, path);
      return;
    }
    if (!ts.isObjectLiteralExpression(n)) {
      refuse(
        n,
        `${path} for ${model} is not an object literal, and ${model} has relations to guarded tables`,
      );
      return;
    }
    for (const p of n.properties) {
      if (ts.isSpreadAssignment(p)) {
        refuse(p, `a spread in ${path} for ${model}`);
        continue;
      }
      const key = propName(p);
      if (key === null) {
        refuse(p, `a computed key in ${path} for ${model}`);
        continue;
      }
      const table = rels.get(key);
      if (!table) continue; // a scalar field: any value is fine
      const value = ts.isPropertyAssignment(p) ? strip(p.initializer) : undefined;
      if (!value || !ts.isObjectLiteralExpression(value)) {
        refuse(
          p,
          `relation field ${key} (to ${table}) in ${path} for ${model} is not an object literal`,
        );
        continue;
      }
      for (const op of value.properties) {
        const opName = ts.isSpreadAssignment(op) ? null : propName(op);
        if (opName === null)
          refuse(op, `relation field ${key} (to ${table}) has a spread or computed operation`);
        else if (NESTED_WRITES.has(opName))
          a.writes.push({ fn, table, how: `nested ${opName} via ${key}` });
      }
    }
  };

  /** RAW SQL. */
  const staticText = (n: TS.Node): string | null => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
    if (ts.isTemplateExpression(n))
      return [n.head.text, ...n.templateSpans.map((s) => ` $x ${s.literal.text}`)].join('');
    return null;
  };
  const checkSql = (n: TS.Node, text: string, how: string) => {
    const sql = text.toLowerCase().replace(/["`]/g, '').replace(/\s+/g, ' ');
    for (const m of sql.matchAll(SQL_WRITE))
      a.writes.push({ fn: enclosingName(n), table: m[2]!, how: `${how} (${m[0]})` });
  };

  const visit = (n: TS.Node): void => {
    // FORM: guarded delegates, only as `<client>.<delegate>.<method>(…)`.
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
          refuse(
            n,
            `the ${table} delegate is used other than as \`<client>.<delegate>.<method>(…)\``,
          );
        } else if (WRITES.has(access.name.text)) {
          a.writes.push({ fn: enclosingName(n), table, how: `${access.name.text}()` });
        } else if (!READS.has(access.name.text)) {
          refuse(n, `unknown ${table} delegate method ${access.name.text}()`);
        }
      }
    }
    if (ts.isElementAccessExpression(n) && isPrismaClient(n.expression))
      refuse(n, 'computed access on a Prisma client');
    if (
      ts.isVariableDeclaration(n) &&
      ts.isObjectBindingPattern(n.name) &&
      n.initializer &&
      isPrismaClient(n.initializer)
    )
      refuse(n, 'destructuring a Prisma client');

    // INPUTS: writes on any delegate whose model can reach a guarded model.
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      WRITES.has(n.expression.name.text)
    ) {
      const model = delegateModel(n.expression.expression);
      if (model && relations.has(model)) {
        const arg0 = n.arguments[0];
        const arg = arg0 ? strip(arg0) : undefined;
        if (!arg || !ts.isObjectLiteralExpression(arg))
          refuse(
            n,
            `the arguments to ${model}.${n.expression.name.text}() are not an object literal`,
          );
        else {
          for (const p of arg.properties) {
            if (ts.isSpreadAssignment(p)) {
              refuse(p, `a spread in the arguments to ${model}.${n.expression.name.text}()`);
              continue;
            }
            const key = propName(p);
            if (key === null)
              refuse(p, `a computed key in the arguments to ${model}.${n.expression.name.text}()`);
            else if (DATA_KEYS.has(key)) {
              if (ts.isPropertyAssignment(p))
                checkDataObject(p.initializer, model, enclosingName(n), key);
              else
                refuse(
                  p,
                  `\`${key}\` in the arguments to ${model}.${n.expression.name.text}() is not written out literally`,
                );
            }
          }
        }
      }
    }

    // RAW SQL: only the immediate call of a raw method; Unsafe variants take a literal with no substitutions.
    if (ts.isPropertyAccessExpression(n) && RAW.has(n.name.text)) {
      const p = n.parent;
      const tagged = ts.isTaggedTemplateExpression(p) && p.tag === n;
      const called = ts.isCallExpression(p) && p.expression === n;
      if (!tagged && !called)
        refuse(
          n,
          `${n.name.text} referenced other than by its immediate call (\`.bind\`, extraction)`,
        );
      else if (tagged) {
        const text = staticText(p.template);
        if (text !== null) checkSql(p, text, n.name.text);
      } else if (called) {
        const arg = p.arguments[0];
        const unsafe = n.name.text.endsWith('Unsafe');
        const text =
          arg &&
          (ts.isStringLiteral(arg) ||
            ts.isNoSubstitutionTemplateLiteral(arg) ||
            (!unsafe && ts.isTemplateExpression(arg)))
            ? staticText(arg)
            : null;
        if (text === null)
          refuse(
            p,
            `${n.name.text} with SQL that isn't a ${unsafe ? 'substitution-free ' : ''}literal`,
          );
        else checkSql(p, text, n.name.text);
      }
    }

    // PUBLISH: <real InvalidationBus>.publish(CHANNELS.<x>, …), CHANNELS resolved to its real declaration.
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === 'publish' &&
      isRealBus(n.expression.expression)
    ) {
      const arg0 = n.arguments[0];
      const arg = arg0 ? strip(arg0) : undefined; // a cast changes no runtime value
      if (
        arg &&
        ts.isPropertyAccessExpression(arg) &&
        declaredIn(declOf(arg.expression), BUS_FILE) &&
        ts.isIdentifier(arg.expression) &&
        arg.expression.text === 'CHANNELS'
      ) {
        const fn = enclosingName(n);
        a.publishes.set(fn, (a.publishes.get(fn) ?? new Set()).add(arg.name.text));
      }
    }

    // CALL GRAPH and REFERENCES, by resolved declaration.
    if (ts.isPropertyAccessExpression(n) || ts.isIdentifier(n)) {
      const d = declOf(ts.isPropertyAccessExpression(n) ? n.name : n);
      const q =
        d && (ts.isMethodDeclaration(d) || ts.isFunctionDeclaration(d)) ? qualifiedName(d) : null;
      if (
        q &&
        !(ts.isIdentifier(n) && ts.isPropertyAccessExpression(n.parent) && n.parent.name === n) &&
        !(d === n.parent)
      ) {
        const p = n.parent;
        const direct = ts.isCallExpression(p) && p.expression === n;
        const from = enclosingName(n);
        const list = a.references.get(q) ?? [];
        list.push({ direct, from, at: where(n) });
        a.references.set(q, list);
        if (direct) a.calls.set(from, (a.calls.get(from) ?? new Set()).add(q));
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return a;
}

/** Every CI10 violation over `files`, given the bindings (file paths relative to apps/api/src). */
export function writerViolations(
  program: TS.Program,
  files: readonly TS.SourceFile[],
  bindings: Bindings,
): string[] {
  const relations = guardedRelations();
  const out: string[] = [];
  const used = new Set<Binding>();
  const scanned = new Set(files.map((sf) => relPath(sf.fileName)));
  for (const sf of files) {
    const rel = relPath(sf.fileName);
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
      if (!a.publishes.get(b.publisher)?.has(b.channel)) {
        out.push(
          `${rel}: ${b.writer} writes ${b.table}, but ${b.publisher} makes no publish(CHANNELS.${b.channel}, …) call on the real InvalidationBus`,
        );
      }
      const calls = (caller: string, callee: string) =>
        caller === callee || (a.calls.get(caller)?.has(callee) ?? false);
      if (b.calledOnlyFrom) {
        const refs = a.references.get(b.writer) ?? [];
        const bad = refs.filter((r) => !r.direct || r.from !== b.calledOnlyFrom);
        if (refs.length === 0)
          out.push(`${rel}: ${b.writer} is never called from ${b.calledOnlyFrom}`);
        for (const r of bad)
          out.push(
            `${r.at}: ${b.writer} referenced ${r.direct ? `from ${r.from}` : 'other than as a direct call'}; it may only be called from ${b.calledOnlyFrom}`,
          );
        if (!calls(b.calledOnlyFrom, b.publisher))
          out.push(`${rel}: ${b.calledOnlyFrom} never calls ${b.publisher}`);
      } else if (!calls(b.writer, b.publisher)) {
        out.push(`${rel}: ${b.writer} writes ${b.table} but never calls ${b.publisher}`);
      }
    }
  }
  for (const [file, list] of Object.entries(bindings)) {
    if (!scanned.has(file)) continue;
    for (const b of list)
      if (!used.has(b))
        out.push(`${file}: binding ${b.writer} → ${b.table} matches no write (stale)`);
  }
  return out;
}
