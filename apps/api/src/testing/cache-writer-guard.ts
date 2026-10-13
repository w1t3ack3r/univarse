// Spec 0015 CI10: a type-aware, fail-closed guard over writes to the cache-relevant tables (owner reviews of #66:
// c6dd715, e89e48b, 6d42a3a, 114c30e). Test tooling: excluded from the build.
//
// Guarded tables: `tenant` (status; slug = host), `tenant_domain` (hosts), `tenant_product` (entitlements, enabled).
// Identities are resolved through the type checker. Functions are keyed by DECLARATION (file + position), never by
// name: a binding must resolve to exactly one declaration.
//
// A write to a guarded table is accepted ONLY when all of these hold:
//   1. FORM: `<client>.<guardedDelegate>.<knownWriteMethod>(…)`, the delegate identified by its Prisma type. Any other
//      use of a guarded delegate, and any reference to a raw-SQL method other than its immediate call, is refused.
//   2. INPUTS: writes on ANY delegate whose model can (transitively, through relations) reach a guarded model are
//      analysed recursively through every nested operation; every level must be literal (casts looked through,
//      quoted keys normalised; no spreads, computed keys, shorthand or variable values where a write could hide).
//      Each guarded model reached at any depth is a write needing its OWN binding. `connect` / `disconnect` / `set`
//      through a relation whose foreign key is on the related side write the related row; any relation operation
//      the guard doesn't know is refused.
//   3. RAW SQL: tagged templates are checked on their static text, lexed as PostgreSQL lexes it (quote-aware:
//      standard, E'…' and dollar-quoted strings, quoted identifiers, nested block and line comments); string literals
//      are scanned as SQL too (`DO $$…$$`, `EXECUTE '…'`). Interpolations must be proven bound parameters by type
//      (primitives, Date, arrays of them; unions and type-parameter constraints inspected). A template passed as an
//      argument must be tagged with Prisma's own `sql`, by declaration. `U&"…"` identifiers, unlexable SQL, and
//      `…Unsafe` variants without a substitution-free literal are refused.
//   4. BINDING: the write sits in the bound writer; the bound publisher calls `publish` on the real InvalidationBus
//      with the real `CHANNELS.<channel>` (both resolved to their declarations in shared/infra/invalidation-bus.ts).
//   5. PATH: the writer calls the publisher (call targets resolved to declarations), or every reference to the
//      writer's declaration is a direct call from its one bound caller, which calls the publisher.
//   6. PROOF: the binding names a runtime test asserting the order (commit, or commit then compensation, before
//      publish), which must exist.
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
/** Top-level argument properties that carry written values. */
const DATA_KEYS = new Set(['data', 'create', 'update']);
/** Nested relation operations that write the related model's own row. */
const NESTED_WRITES = new Set([
  'create',
  'createMany',
  'connectOrCreate',
  'update',
  'updateMany',
  'upsert',
  'delete',
  'deleteMany',
]);
/**
 * Nested relation operations that change which row a foreign key points at. Through a relation whose foreign key is
 * on the RELATED side (a list, or a to-one back-reference), they write the related row: `Tenant.products.connect`
 * moves a product to another tenant. Through the side that holds the foreign key, they write only the current row.
 */
const NESTED_LINKS = new Set(['connect', 'disconnect', 'set']);
/** Every other nested relation operation is refused: an unrecognised one may write. */
const NESTED_OPS = new Set([...NESTED_WRITES, ...NESTED_LINKS]);
const RAW = new Set(['$executeRaw', '$executeRawUnsafe', '$queryRaw', '$queryRawUnsafe']);
const SQL_WRITE =
  /\b(insert into|update|delete from|merge into|truncate(?: table)?|alter table|copy)\s+(?:only\s+)?(?:[a-z_][a-z0-9_$]*\.)?(tenant|tenant_domain|tenant_product)\b/g;

export interface Binding {
  /** `Class.method` (or a function name): must resolve to exactly one declaration in the file. */
  readonly writer: string;
  readonly table: 'tenant' | 'tenant_domain' | 'tenant_product';
  /** The channel: `CHANNELS.<channel>` from shared/infra/invalidation-bus.ts. */
  readonly channel: 'products' | 'tenants';
  /** `Class.method` that makes the actual publish call (the writer itself, or a method it calls). */
  readonly publisher: string;
  /** When the writer doesn't call the publisher itself: its ONLY permitted caller, which must call the publisher. */
  readonly calledOnlyFrom?: string;
  /** The runtime test asserting publication after commit (or compensation), in order. */
  readonly proof: { readonly file: string; readonly test: string };
}
export type Bindings = Readonly<Record<string, readonly Binding[]>>; // file (relative to apps/api/src) → bindings

/** The model blocks of both Prisma schemas: [name, body]. */
function schemaModels(): [string, string][] {
  const texts: string[] = [];
  for (const schema of [
    'packages/db/prisma/platform/schema.prisma',
    'packages/db/prisma/tenant/schema.prisma',
  ]) {
    try {
      texts.push(readFileSync(join(REPO, schema), 'utf8'));
    } catch {
      // a missing schema contributes no relations
    }
  }
  return texts.flatMap((t) =>
    [...t.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)].map((b): [string, string] => [
      b[1]!,
      b[2]!,
    ]),
  );
}
const RELATION_FIELD = /^\s+(\w+)\s+(\w+)(\[\])?\??(?=\s|$)(.*)$/gm;

/** The relation graph from both Prisma schemas: model → field → related MODEL (enums and scalars excluded). */
export function relationGraph(): Map<string, Map<string, string>> {
  const blocks = schemaModels();
  const models = new Set(blocks.map(([name]) => name));
  const out = new Map<string, Map<string, string>>();
  for (const [name, body] of blocks) {
    const fields = new Map<string, string>();
    for (const m of body.matchAll(RELATION_FIELD)) if (models.has(m[2]!)) fields.set(m[1]!, m[2]!);
    out.set(name, fields);
  }
  return out;
}

/** `Model.field` for every relation field that holds the foreign key (`@relation(fields: …)`). */
export function foreignKeyHolders(): Set<string> {
  const out = new Set<string>();
  for (const [name, body] of schemaModels())
    for (const m of body.matchAll(RELATION_FIELD))
      if (!m[3] && /@relation\([^)]*\bfields\s*:/.test(m[4]!)) out.add(`${name}.${m[1]!}`);
  return out;
}

/** Models from which a guarded model is reachable through relations (guarded models included). */
export function reachingModels(graph: Map<string, Map<string, string>>): Set<string> {
  const reach = new Set(Object.keys(GUARDED_MODELS));
  for (let changed = true; changed;) {
    changed = false;
    for (const [model, fields] of graph) {
      if (reach.has(model)) continue;
      if ([...fields.values()].some((m) => reach.has(m))) {
        reach.add(model);
        changed = true;
      }
    }
  }
  return reach;
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

const IDENT_CHAR = /[A-Za-z0-9_$\u0080-￿]/;

/**
 * Lexes SQL as PostgreSQL does, so a comment marker inside a literal is text and a quote inside a comment is comment.
 * Returns the code outside string literals (comments → space, quoted identifiers unquoted, each string → `''`) and
 * each string literal's contents; null when the text is unterminated, or uses a backslash in a standard string
 * (ambiguous: its meaning depends on standard_conforming_strings).
 */
export function lexSql(text: string): { code: string; strings: string[] } | null {
  let code = '';
  const strings: string[] = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i]!;
    const next = text[i + 1];
    if (c === '-' && next === '-') {
      const end = text.indexOf('\n', i);
      i = end < 0 ? n : end;
      code += ' ';
    } else if (c === '/' && next === '*') {
      let depth = 0; // block comments nest
      do {
        if (i >= n) return null;
        if (text.startsWith('/*', i)) {
          depth++;
          i += 2;
        } else if (text.startsWith('*/', i)) {
          depth--;
          i += 2;
        } else i++;
      } while (depth > 0);
      code += ' ';
    } else if (c === '"') {
      let j = i + 1;
      let ident = '';
      for (;;) {
        if (j >= n) return null;
        if (text[j] === '"') {
          if (text[j + 1] !== '"') break;
          ident += '"';
          j += 2;
        } else ident += text[j++]!;
      }
      code += ident;
      i = j + 1;
    } else if (c === "'") {
      // E'…' takes backslash escapes; a standard string doesn't (with standard_conforming_strings on).
      const escapes = /[eE]/.test(text[i - 1] ?? '') && !IDENT_CHAR.test(text[i - 2] ?? '');
      let j = i + 1;
      let s = '';
      for (;;) {
        if (j >= n) return null;
        const ch = text[j]!;
        if (ch === '\\') {
          if (!escapes) return null;
          s += text.slice(j, j + 2);
          j += 2;
        } else if (ch === "'") {
          if (text[j + 1] !== "'") break;
          s += "'";
          j += 2;
        } else {
          s += ch;
          j++;
        }
      }
      strings.push(s);
      code += " '' ";
      i = j + 1;
    } else if (c === '$' && !IDENT_CHAR.test(text[i - 1] ?? '')) {
      const tag = /^\$(?:[A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/.exec(text.slice(i))?.[0];
      if (tag) {
        const end = text.indexOf(tag, i + tag.length);
        if (end < 0) return null;
        strings.push(text.slice(i + tag.length, end));
        code += " '' ";
        i = end + tag.length;
      } else {
        code += c;
        i++;
      }
    } else {
      code += c;
      i++;
    }
  }
  return { code, strings };
}

const fold = (s: string) => s.toLowerCase().replace(/\s+/g, ' ');

/**
 * Normalises SQL as PostgreSQL reads it, for matching writes: the code outside literals (lexed), then each string
 * literal's contents as SQL too, since `DO $$ … $$` and `EXECUTE '…'` run them. A literal that doesn't lex as SQL
 * can't run as SQL either, so it is scanned as plain text. Null when the outer text doesn't lex (refused).
 */
export function normaliseSql(text: string, depth = 0): string | null {
  const lexed = lexSql(text);
  if (!lexed) return null;
  if (depth > 4) return null; // literals nested this deep: refused rather than guessed
  const parts = [fold(lexed.code)];
  for (const s of lexed.strings) {
    if (lexSql(s) === null) parts.push(fold(s));
    else {
      const inner = normaliseSql(s, depth + 1);
      if (inner === null) return null;
      parts.push(inner);
    }
  }
  return parts.join(' ; ');
}

/** The qualified label of a function-like declaration: `Class.method`, or a function's name. */
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

/** A declaration's identity: its file and position. */
const declId = (decl: TS.Node) =>
  `${relPath(decl.getSourceFile().fileName)}#${String(decl.getStart())}`;

/** The enclosing function's declaration, or the SourceFile. `parent` is undefined above the SourceFile. */
function enclosingDecl(node: TS.Node): TS.Node {
  let n: TS.Node = node;
  while (!ts.isSourceFile(n)) {
    if (qualifiedName(n)) return n;
    n = n.parent;
  }
  return n;
}

interface Analysis {
  readonly writes: { fn: string; table: string; how: string }[]; // fn = declaration id
  readonly violations: string[];
  /** Declaration id → its label. */
  readonly labels: Map<string, string>;
  /** Declaration id → channels it publishes on (real CHANNELS, real bus). */
  readonly publishes: Map<string, Set<string>>;
  /** Caller declaration id → callee declaration ids (resolved). */
  readonly calls: Map<string, Set<string>>;
  /** Declaration id → every reference: whether a direct call's callee, the enclosing declaration id, where. */
  readonly references: Map<string, { direct: boolean; from: string; at: string }[]>;
}

/** Analyse one file. */
export function analyzeFile(
  program: TS.Program,
  sf: TS.SourceFile,
  graph = relationGraph(),
): Analysis {
  const checker = program.getTypeChecker();
  const reaching = reachingModels(graph);
  const fkHolders = foreignKeyHolders();
  const a: Analysis = {
    writes: [],
    violations: [],
    labels: new Map(),
    publishes: new Map(),
    calls: new Map(),
    references: new Map(),
  };
  const where = (n: TS.Node) =>
    `${relPath(sf.fileName)}:${String(sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1)}`;
  const refuse = (n: TS.Node, why: string) =>
    a.violations.push(`${where(n)}: ${why}: refused (fail closed)`);
  const fnOf = (n: TS.Node) => {
    const d = enclosingDecl(n);
    if (ts.isSourceFile(d)) {
      const id = `${relPath(sf.fileName)}#<module>`;
      a.labels.set(id, '<module>');
      return id;
    }
    const id = declId(d);
    a.labels.set(id, qualifiedName(d) ?? '<anon>');
    return id;
  };

  const typeSymbolName = (n: TS.Node) => {
    const t = checker.getTypeAtLocation(n);
    return (t.aliasSymbol ?? t.getSymbol())?.getName();
  };
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
  const declOf = (n: TS.Node): TS.Declaration | undefined => {
    let sym = checker.getSymbolAtLocation(n);
    if (sym && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
    return sym?.valueDeclaration ?? sym?.declarations?.[0];
  };
  const declaredIn = (d: TS.Node | undefined, file: string) =>
    !!d && d.getSourceFile().fileName.replace(/\\/g, '/') === file;
  const isRealBus = (n: TS.Node) => {
    const sym = checker.getTypeAtLocation(n).getSymbol();
    return (
      sym?.getName() === 'InvalidationBus' &&
      declaredIn(sym.valueDeclaration ?? sym.declarations?.[0], BUS_FILE)
    );
  };
  const strip = (e: TS.Expression): TS.Expression =>
    ts.isAsExpression(e) ||
    ts.isSatisfiesExpression(e) ||
    ts.isNonNullExpression(e) ||
    ts.isParenthesizedExpression(e) ||
    ts.isTypeAssertionExpression(e)
      ? strip(e.expression)
      : e;
  const propName = (p: TS.ObjectLiteralElementLike): string | null => {
    if (!p.name) return null;
    if (
      ts.isIdentifier(p.name) ||
      ts.isStringLiteral(p.name) ||
      ts.isNoSubstitutionTemplateLiteral(p.name)
    )
      return p.name.text;
    return null;
  };
  /** The literal properties of an object literal; a spread or computed key is refused (returns null). */
  const literalProps = (
    o: TS.ObjectLiteralExpression,
    what: string,
  ): Map<string, TS.ObjectLiteralElementLike> | null => {
    const out = new Map<string, TS.ObjectLiteralElementLike>();
    for (const p of o.properties) {
      if (ts.isSpreadAssignment(p)) {
        refuse(p, `a spread in ${what}`);
        return null;
      }
      const k = propName(p);
      if (k === null) {
        refuse(p, `a computed key in ${what}`);
        return null;
      }
      out.set(k, p);
    }
    return out;
  };
  const valueOf = (p: TS.ObjectLiteralElementLike | undefined): TS.Expression | null =>
    p && ts.isPropertyAssignment(p) ? strip(p.initializer) : null;

  /** INPUTS: a written-value object for `model`, analysed recursively through every relation. */
  const checkData = (raw: TS.Expression, model: string, fn: string, path: string): void => {
    if (!reaching.has(model)) return; // nothing guarded is reachable from here
    const n = strip(raw);
    if (ts.isArrayLiteralExpression(n)) {
      for (const e of n.elements) checkData(e, model, fn, path);
      return;
    }
    if (!ts.isObjectLiteralExpression(n)) {
      refuse(
        n,
        `${path} for ${model} is not an object literal, and ${model} can reach guarded tables`,
      );
      return;
    }
    const props = literalProps(n, `${path} for ${model}`);
    if (!props) return;
    for (const [key, p] of props) {
      const related = graph.get(model)?.get(key);
      if (!related || !reaching.has(related)) continue; // a scalar field, or a relation that reaches nothing guarded
      const value = valueOf(p);
      if (!value || !ts.isObjectLiteralExpression(value)) {
        refuse(p, `relation ${model}.${key} in ${path} is not written out as an object literal`);
        continue;
      }
      const ops = literalProps(value, `relation ${model}.${key}`);
      if (!ops) continue;
      for (const [op, opNode] of ops) {
        const sub = `${path}.${key}.${op}`;
        if (!NESTED_OPS.has(op)) {
          refuse(opNode, `unsupported relation operation ${op} on ${model}.${key} in ${path}`);
          continue;
        }
        const writesRelated = NESTED_WRITES.has(op) || !fkHolders.has(`${model}.${key}`); // a link moves the related row's foreign key
        if (writesRelated && Object.hasOwn(GUARDED_MODELS, related)) {
          a.writes.push({
            fn,
            table: GUARDED_MODELS[related]!,
            how: `nested ${op} via ${model}.${key}`,
          });
        }
        if (
          !['create', 'createMany', 'update', 'updateMany', 'upsert', 'connectOrCreate'].includes(
            op,
          )
        )
          continue;
        const opValue = valueOf(opNode);
        if (!opValue) {
          refuse(opNode, `${sub} is not written out literally`);
          continue;
        }
        if (op === 'create') {
          checkData(opValue, related, fn, sub);
          continue;
        }
        const items = ts.isArrayLiteralExpression(opValue)
          ? opValue.elements.map(strip)
          : [opValue];
        for (const item of items) {
          if (!ts.isObjectLiteralExpression(item)) {
            refuse(item, `${sub} is not an object literal`);
            continue;
          }
          const inner = literalProps(item, sub);
          if (!inner) continue;
          // createMany / updateMany / update-with-where: { data }; upsert: { create, update }; connectOrCreate: { create };
          // a to-one update may also be the data object itself.
          const dataKeys =
            op === 'upsert'
              ? ['create', 'update']
              : op === 'connectOrCreate'
                ? ['create']
                : inner.has('data')
                  ? ['data']
                  : [];
          if (dataKeys.length === 0) {
            checkData(item, related, fn, sub);
            continue;
          }
          for (const k of dataKeys) {
            const node = inner.get(k);
            if (!node) continue;
            const v = valueOf(node);
            if (!v) refuse(node, `${sub}.${k} is not written out literally`);
            else checkData(v, related, fn, `${sub}.${k}`);
          }
        }
      }
    }
  };

  /** RAW SQL: the static text of a template, or null (with a refusal) when a fragment could add SQL syntax. */
  const templateText = (t: TS.TemplateLiteral, how: string): string | null => {
    if (ts.isNoSubstitutionTemplateLiteral(t)) return t.text;
    let text = t.head.text;
    for (const span of t.templateSpans) {
      const ty = checker.getTypeAtLocation(span.expression);
      if (!boundParameter(ty)) {
        refuse(
          span.expression,
          `${how} interpolates ${checker.typeToString(ty)}, which isn't proven to be a bound parameter (only primitives, Date and arrays of them are; a Prisma.sql / Prisma.raw fragment can add SQL syntax)`,
        );
        return null;
      }
      text += ` $x ${span.literal.text}`;
    }
    return text;
  };
  /**
   * Whether every value of `t` is sent as a bound parameter, never spliced in as SQL: every member of a union, the
   * constraint of a type parameter, and the elements of an array must be a primitive (literal types and enums
   * included) or Date. Intersections pass only as a branded primitive, `string & { … }`.
   */
  const PRIMITIVE =
    ts.TypeFlags.StringLike |
    ts.TypeFlags.NumberLike |
    ts.TypeFlags.BigIntLike |
    ts.TypeFlags.BooleanLike |
    ts.TypeFlags.EnumLike |
    ts.TypeFlags.Null |
    ts.TypeFlags.Undefined;
  const boundParameter = (t: TS.Type, depth = 0): boolean => {
    if (depth > 8) return false;
    if (t.flags & PRIMITIVE) return true;
    if (t.flags & ts.TypeFlags.TypeParameter) {
      const c = checker.getBaseConstraintOfType(t);
      return !!c && c !== t && boundParameter(c, depth + 1);
    }
    if (t.isUnion()) return t.types.every((m) => boundParameter(m, depth + 1));
    if (t.isIntersection()) {
      return (
        t.types.some((m) => (m.flags & PRIMITIVE) !== 0) &&
        t.types.every((m) => (m.flags & PRIMITIVE) !== 0 || brand(m))
      );
    }
    if (checker.isArrayType(t) || checker.isTupleType(t))
      return checker
        .getTypeArguments(t as TS.TypeReference)
        .every((e) => boundParameter(e, depth + 1));
    const sym = t.getSymbol();
    return (
      sym?.getName() === 'Date' &&
      (sym.declarations ?? []).some((d) => program.isSourceFileDefaultLibrary(d.getSourceFile()))
    );
  };
  /** A brand: an anonymous object type whose properties are all primitives (no methods, nothing SQL-shaped). */
  const brand = (t: TS.Type) =>
    !!(t.flags & ts.TypeFlags.Object) &&
    !!t.getSymbol() &&
    t.getSymbol()!.getName() === '__type' &&
    t.getCallSignatures().length === 0 &&
    t.getProperties().every((p) => {
      const pt = checker.getTypeOfSymbol(p);
      return (pt.flags & (PRIMITIVE | ts.TypeFlags.UniqueESSymbol)) !== 0;
    });
  /** The tag is Prisma's own `sql` (the generated `Prisma.sql`), resolved by declaration. */
  const PRISMA_SQL_DECL =
    /\/packages\/db\/(src|dist)\/generated\/(platform|tenant)\/internal\/prismaNamespace\.(d\.)?ts$/;
  const isPrismaSqlTag = (tag: TS.Expression) => {
    const d = declOf(ts.isPropertyAccessExpression(tag) ? tag.name : tag);
    return (
      !!d &&
      ts.isVariableDeclaration(d) &&
      ts.isIdentifier(d.name) &&
      d.name.text === 'sql' &&
      PRISMA_SQL_DECL.test(d.getSourceFile().fileName.replace(/\\/g, '/'))
    );
  };
  const checkSql = (n: TS.Node, text: string, how: string) => {
    if (/u&\s*"/i.test(text)) {
      refuse(n, `${how} uses a U&"…" escaped identifier`);
      return;
    }
    const sql = normaliseSql(text);
    if (sql === null) {
      refuse(
        n,
        `${how} with SQL that doesn't lex unambiguously (an unterminated quote or comment, or a backslash in a standard string)`,
      );
      return;
    }
    for (const m of sql.matchAll(SQL_WRITE))
      a.writes.push({ fn: fnOf(n), table: m[2]!, how: `${how} (${m[0]})` });
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
          a.writes.push({ fn: fnOf(n), table, how: `${access.name.text}()` });
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
    ) {
      refuse(n, 'destructuring a Prisma client');
    }

    // INPUTS: writes on any delegate whose model can reach a guarded model.
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      WRITES.has(n.expression.name.text)
    ) {
      const model = delegateModel(n.expression.expression);
      if (model && reaching.has(model)) {
        const what = `the arguments to ${model}.${n.expression.name.text}()`;
        const arg0 = n.arguments[0];
        const arg = arg0 ? strip(arg0) : undefined;
        if (!arg || !ts.isObjectLiteralExpression(arg)) {
          refuse(n, `${what} are not an object literal`);
        } else {
          for (const [key, p] of literalProps(arg, what) ?? []) {
            if (!DATA_KEYS.has(key)) continue;
            const v = valueOf(p);
            if (!v) refuse(p, `\`${key}\` in ${what} is not written out literally`);
            else checkData(v, model, fnOf(n), key);
          }
        }
      }
    }

    // RAW SQL.
    if (ts.isPropertyAccessExpression(n) && RAW.has(n.name.text)) {
      const p = n.parent;
      const tagged = ts.isTaggedTemplateExpression(p) && p.tag === n;
      const called = ts.isCallExpression(p) && p.expression === n;
      if (!tagged && !called) {
        refuse(
          n,
          `${n.name.text} referenced other than by its immediate call (\`.bind\`, extraction)`,
        );
      } else if (ts.isTaggedTemplateExpression(p)) {
        const text = templateText(p.template, n.name.text);
        if (text !== null) checkSql(p, text, n.name.text);
      } else if (ts.isCallExpression(p)) {
        const arg0 = p.arguments[0];
        const arg = arg0 ? strip(arg0) : undefined;
        const unsafe = n.name.text.endsWith('Unsafe');
        if (arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))) {
          checkSql(p, arg.text, n.name.text);
        } else if (
          arg &&
          !unsafe &&
          ts.isTaggedTemplateExpression(arg) &&
          isPrismaSqlTag(arg.tag)
        ) {
          const text = templateText(arg.template, n.name.text); // Prisma.sql`…` (refuses its own fragments)
          if (text !== null) checkSql(p, text, n.name.text);
        } else {
          refuse(
            p,
            `${n.name.text} with SQL that isn't a ${unsafe ? 'substitution-free' : 'checkable'} literal${!unsafe && arg && ts.isTaggedTemplateExpression(arg) ? " (a template's tag must be Prisma's own sql, by declaration)" : ''}`,
          );
        }
      }
    }

    // PUBLISH: <real InvalidationBus>.publish(<real CHANNELS>.<x>, …).
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === 'publish' &&
      isRealBus(n.expression.expression)
    ) {
      const arg0 = n.arguments[0];
      const arg = arg0 ? strip(arg0) : undefined;
      if (
        arg &&
        ts.isPropertyAccessExpression(arg) &&
        ts.isIdentifier(arg.expression) &&
        arg.expression.text === 'CHANNELS' &&
        declaredIn(declOf(arg.expression), BUS_FILE)
      ) {
        const fn = fnOf(n);
        a.publishes.set(fn, (a.publishes.get(fn) ?? new Set()).add(arg.name.text));
      }
    }

    // CALL GRAPH and REFERENCES, by declaration identity.
    if (
      (ts.isPropertyAccessExpression(n) || ts.isIdentifier(n)) &&
      !(ts.isIdentifier(n) && ts.isPropertyAccessExpression(n.parent) && n.parent.name === n)
    ) {
      const d = declOf(ts.isPropertyAccessExpression(n) ? n.name : n);
      if (
        d &&
        (ts.isMethodDeclaration(d) || ts.isFunctionDeclaration(d)) &&
        d !== n.parent &&
        qualifiedName(d)
      ) {
        const id = declId(d);
        a.labels.set(id, qualifiedName(d)!);
        const direct = ts.isCallExpression(n.parent) && n.parent.expression === n;
        const from = fnOf(n);
        const list = a.references.get(id) ?? [];
        list.push({ direct, from, at: where(n) });
        a.references.set(id, list);
        if (direct) a.calls.set(from, (a.calls.get(from) ?? new Set()).add(id));
      }
    }
    // Every declaration gets a label, so bindings can resolve to it.
    const q = qualifiedName(n);
    if (q) a.labels.set(declId(n), q);
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
  const graph = relationGraph();
  const out: string[] = [];
  const used = new Set<Binding>();
  const scanned = new Set(files.map((sf) => relPath(sf.fileName)));
  for (const sf of files) {
    const rel = relPath(sf.fileName);
    const a = analyzeFile(program, sf, graph);
    out.push(...a.violations);
    /** A binding label → the ONE declaration in this file with that label (ambiguity and absence are refused). */
    const resolve = (label: string): string | null => {
      const ids = [...a.labels]
        .filter(([id, l]) => l === label && id.startsWith(`${rel}#`))
        .map(([id]) => id);
      if (ids.length !== 1) {
        out.push(
          `${rel}: binding names ${label}, which resolves to ${String(ids.length)} declarations (must be exactly 1)`,
        );
        return null;
      }
      return ids[0]!;
    };
    const bound = (bindings[rel] ?? []).map((b) => ({
      b,
      writer: resolve(b.writer),
      publisher: resolve(b.publisher),
      only: b.calledOnlyFrom ? resolve(b.calledOnlyFrom) : null,
    }));
    const calls = (caller: string | null, callee: string | null) =>
      !!caller && !!callee && (caller === callee || (a.calls.get(caller)?.has(callee) ?? false));
    for (const w of a.writes) {
      const r = bound.find((x) => x.writer === w.fn && x.b.table === w.table);
      if (!r) {
        out.push(
          `${rel}: ${a.labels.get(w.fn) ?? w.fn} writes ${w.table} (${w.how}) with no binding for that writer and table: refused`,
        );
        continue;
      }
      const { b } = r;
      used.add(b);
      if (!r.publisher || !a.publishes.get(r.publisher)?.has(b.channel)) {
        out.push(
          `${rel}: ${b.writer} writes ${b.table}, but ${b.publisher} makes no publish(CHANNELS.${b.channel}, …) call on the real InvalidationBus`,
        );
      }
      if (b.calledOnlyFrom) {
        const refs = r.writer ? (a.references.get(r.writer) ?? []) : [];
        if (refs.length === 0)
          out.push(`${rel}: ${b.writer} is never called from ${b.calledOnlyFrom}`);
        for (const ref of refs.filter((x) => !x.direct || x.from !== r.only)) {
          const how = ref.direct
            ? `from ${a.labels.get(ref.from) ?? ref.from}`
            : 'other than as a direct call';
          out.push(
            `${ref.at}: ${b.writer} referenced ${how}; it may only be called from ${b.calledOnlyFrom}`,
          );
        }
        if (!calls(r.only, r.publisher))
          out.push(`${rel}: ${b.calledOnlyFrom} never calls ${b.publisher}`);
      } else if (!calls(r.writer, r.publisher)) {
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
