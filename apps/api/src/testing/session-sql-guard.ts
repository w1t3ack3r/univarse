// Spec 0017 PB4: no session-scoped SQL in production code. Under transaction pooling, anything that outlives a
// transaction on a server connection reaches the next client, so production SQL may only use transaction-scoped
// state. Test tooling: excluded from the build.
//
// Built on spec 0015's SQL lexer (lexSql: comments, every literal form decoded, dollar quotes, ambiguous forms
// refused), so neither comments nor string literals can hide anything; string constants are read as SQL too, since
// `DO $$…$$` and `EXECUTE '…'` run them. It fails on:
//   • SET without LOCAL (SET SESSION, SET ROLE, SET SESSION AUTHORIZATION, SET TRANSACTION and the rest), and RESET;
//   • set_config(…) whose third argument isn't a literal `true` (a locality that can't be established is refused);
//   • the session advisory-lock functions, exclusive and shared (the _xact_ variants are transaction-scoped and fine);
//   • LISTEN and UNLISTEN; PREPARE and DEALLOCATE;
//   • CREATE [GLOBAL|LOCAL] TEMP / TEMPORARY, and SELECT … INTO TEMP / TEMPORARY;
//   • DECLARE … WITH HOLD, and DISCARD.
// Where the SQL comes from (the TypeScript side): every Prisma raw call and Prisma.sql / Prisma.raw fragment, and pg's
// own query(), in the production sources of the API, @univarse/db and @univarse/crypto. A raw method referenced other
// than by its immediate call or tag, an …Unsafe variant or Prisma.raw without a substitution-free literal, a raw call
// on something other than a literal template, and an interpolation not proven a bound parameter (by type) are refused.
//
// Its limits, stated (spec 0017 PB4): it can't see SQL inside stored functions, a value cast to a false type, or code
// outside those packages' TypeScript. PB1–PB3 are the runtime evidence for the paths the suites exercise.
import { createRequire } from 'node:module';
import { join, relative } from 'node:path';
import type * as TS from 'typescript';
import { API_DIR, boundParameterOf, lexSql, type SqlToken } from './cache-writer-guard.js';

const require = createRequire(import.meta.url);
const ts = require('typescript') as typeof TS;

export const REPO = join(API_DIR, '../../');

/** The packages whose production TypeScript is scanned, by directory (relative to the repo). */
export const SCANNED = ['apps/api', 'packages/db', 'packages/crypto'] as const;

const SESSION_ADVISORY = new Set([
  'pg_advisory_lock',
  'pg_advisory_lock_shared',
  'pg_try_advisory_lock',
  'pg_try_advisory_lock_shared',
  'pg_advisory_unlock',
  'pg_advisory_unlock_shared',
  'pg_advisory_unlock_all',
]);
const SESSION_COMMANDS = new Set(['listen', 'unlisten', 'prepare', 'deallocate', 'discard']);

const isWord = (t: SqlToken | undefined, ...values: string[]) =>
  t?.kind === 'word' && values.includes(t.value);

/** The session-scoped forms in one statement's tokens. */
function statementProblems(stmt: readonly SqlToken[]): string[] {
  const problems: string[] = [];
  stmt.forEach((t, k) => {
    const prev = stmt[k - 1];
    const next = stmt[k + 1];
    if (isWord(t, 'set')) {
      // Not the SET command only by its actual structure (owner review of 40c80fe: a PL/pgSQL <<update>> label
      // must not exempt it): UPDATE <target> SET, ON CONFLICT DO UPDATE SET, or ON DELETE SET NULL / DEFAULT.
      const notCommand =
        isUpdateClause(stmt, k) || (isWord(prev, 'delete') && isWord(next, 'null', 'default'));
      if (!notCommand && !isWord(next, 'local'))
        problems.push(
          `SET without LOCAL (SET ${next?.value.toUpperCase() ?? ''}) is session-scoped`,
        );
    } else if (isWord(t, 'reset')) {
      // No exemption (ALTER … RESET included): an <<alter>> label hid one. Production SQL has no ALTER.
      problems.push('RESET is session-scoped');
    } else if (
      (t.kind === 'word' || t.kind === 'ident') &&
      t.value.toLowerCase() === 'set_config'
    ) {
      const third = callArgument(stmt, k, 2);
      if (third === undefined)
        problems.push(
          'set_config(…) without a readable third argument: its locality can’t be established',
        );
      else if (!(third.length === 1 && isWord(third[0], 'true')))
        problems.push(
          `set_config(…) whose third argument is ${third.map((x) => x.value).join(' ') || 'empty'}, not a literal true: session-scoped, or a locality that can’t be established`,
        );
    } else if (
      (t.kind === 'word' || t.kind === 'ident') &&
      SESSION_ADVISORY.has(t.value.toLowerCase())
    ) {
      problems.push(
        `${t.value.toLowerCase()} is a session-level advisory lock function (use the _xact_ variant)`,
      );
    } else if (t.kind === 'word' && SESSION_COMMANDS.has(t.value)) {
      problems.push(`${t.value.toUpperCase()} is session-scoped`);
    } else if (
      isWord(t, 'temp', 'temporary') &&
      isWord(prev, 'create', 'into', 'global', 'local')
    ) {
      problems.push(
        `${isWord(prev, 'into') ? 'SELECT … INTO' : 'CREATE'} ${t.value.toUpperCase()} makes a session-scoped table`,
      );
    } else if (isWord(t, 'hold') && isWord(prev, 'with')) {
      problems.push('a cursor WITH HOLD outlives its transaction');
    } else if (
      (t.kind === 'word' || t.kind === 'ident') &&
      /^pg_temp(_\d+)?$/.test(t.value.toLowerCase()) &&
      next?.kind === 'other' &&
      next.value === '.'
    ) {
      // PostgreSQL makes a relation created in its temporary namespace temporary, TEMP keyword or not.
      problems.push(`a relation in ${t.value.toLowerCase()} is temporary (session-scoped)`);
    } else if (
      isWord(t, 'execute') &&
      // GRANT / REVOKE EXECUTE ON …: the privilege, by its structure, not by a <<grant>> label earlier on.
      !(
        isWord(next, 'on') &&
        (isWord(prev, 'grant', 'revoke') || (prev?.kind === 'other' && prev.value === ','))
      )
    ) {
      // EXECUTE runs the command its expression evaluates to. Only a string constant can be established (it is
      // read as SQL below); concatenation, format(), a variable, or a prepared statement's name can't be.
      let j = k + 1;
      while (stmt[j]?.kind === 'string') j++;
      const constant = j > k + 1 && (j === stmt.length || isWord(stmt[j], 'into', 'using'));
      if (!constant)
        problems.push(
          'EXECUTE of anything but a string constant: the command it runs can’t be established, refused',
        );
    }
  });
  return problems;
}

/** Words that end an UPDATE target walking back from its SET: they can't be part of `[ONLY] name [[AS] alias]`. */
const NOT_A_TARGET = new Set([
  'begin',
  'end',
  'then',
  'else',
  'elsif',
  'loop',
  'declare',
  'do',
  'if',
  'case',
  'when',
  'exception',
  'for',
  'while',
  'perform',
  'execute',
  'return',
  'returning',
  'select',
  'from',
  'where',
  'set',
  'with',
]);

/**
 * Whether the SET at `k` is an UPDATE's SET clause: walking back, only the target (`[ONLY] [schema .] name
 * [[AS] alias]`) may lie between it and the word UPDATE. Anything else (a `>>` closing a label, BEGIN, a statement
 * keyword) ends the walk: an <<update>> label is not an UPDATE.
 */
function isUpdateClause(stmt: readonly SqlToken[], k: number): boolean {
  for (let j = k - 1, steps = 0; j >= 0 && steps < 8; j--, steps++) {
    const t = stmt[j]!;
    if (isWord(t, 'update')) return true;
    const target =
      t.kind === 'ident' ||
      (t.kind === 'word' && !NOT_A_TARGET.has(t.value)) ||
      (t.kind === 'other' && t.value === '.');
    if (!target) return false;
  }
  return false;
}

/** The tokens of the `index`th argument of the call whose name is at `at`, or undefined if it can't be read. */
function callArgument(
  stmt: readonly SqlToken[],
  at: number,
  index: number,
): SqlToken[] | undefined {
  if (!(stmt[at + 1]?.kind === 'other' && stmt[at + 1]?.value === '(')) return undefined;
  const args: SqlToken[][] = [[]];
  let depth = 0;
  for (let j = at + 2; j < stmt.length; j++) {
    const t = stmt[j]!;
    if (t.kind === 'other' && (t.value === '(' || t.value === '[')) depth++;
    if (t.kind === 'other' && (t.value === ')' || t.value === ']')) {
      if (depth === 0) return args[index];
      depth--;
    }
    if (depth === 0 && t.kind === 'other' && t.value === ',') args.push([]);
    else args.at(-1)!.push(t);
  }
  return undefined; // unclosed
}

/**
 * The session-scoped forms in a SQL text, or the reason it can't be read. String constants are read as SQL too
 * (`DO $$…$$`, `EXECUTE '…'`); one that doesn't lex as SQL has its words checked instead.
 */
export function sessionSqlProblems(
  text: string,
  depth = 0,
): { problems: string[] } | { error: string } {
  if (depth > 4) return { error: 'string literals nested more than four deep' };
  const lexed = lexSql(text);
  if ('error' in lexed) return lexed;
  const problems: string[] = [];
  let stmt: SqlToken[] = [];
  for (const t of lexed.tokens) {
    if (t.kind === 'other' && t.value === ';') {
      problems.push(...statementProblems(stmt));
      stmt = [];
    } else stmt.push(t);
  }
  problems.push(...statementProblems(stmt));
  for (const t of lexed.tokens) {
    if (t.kind !== 'string') continue;
    const inner = sessionSqlProblems(t.value, depth + 1);
    if (!('error' in inner)) problems.push(...inner.problems);
    else if (/^an unterminated/.test(inner.error)) {
      const words = (t.value.match(/[A-Za-z_][A-Za-z0-9_$]*/g) ?? []).map((w): SqlToken => ({
        kind: 'word',
        value: w.toLowerCase(),
      }));
      problems.push(...statementProblems(words));
    } else return inner; // a refused form inside a literal is refused outright
  }
  return { problems };
}

// ---------- where the SQL comes from ----------

const RAW_TAGGED = new Set(['$queryRaw', '$executeRaw']);
const RAW_UNSAFE = new Set(['$queryRawUnsafe', '$executeRawUnsafe']);
const RAW = new Set([...RAW_TAGGED, ...RAW_UNSAFE]);
/** Where Prisma's own `sql` and `raw` are declared (the generated namespace, or the runtime it re-exports). */
const PRISMA_DECL =
  /\/(packages\/db\/(src|dist)\/generated\/(platform|tenant)\/internal\/prismaNamespace\.(d\.)?ts|node_modules\/@prisma\/client\/)/;
/** Where Prisma's raw methods are declared: the generated clients, or Prisma's own packages. */
const RAW_DECL =
  /\/(packages\/db\/(src|dist)\/generated\/(platform|tenant)\/|node_modules\/@prisma\/)/;
/** Where pg's query() is declared. */
const PG_DECL = /\/node_modules\/(@types\/pg|pg)\//;

/** A program over a package's sources (by its tsconfig), plus optional virtual files, with types. */
export function packageProgram(
  dir: string,
  virtual: Readonly<Record<string, string>> = {},
): TS.Program {
  const root = join(REPO, dir);
  const cfg = ts.getParsedCommandLineOfConfigFile(
    join(root, 'tsconfig.json'),
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (d) => {
        throw new Error(ts.flattenDiagnosticMessageText(d.messageText, '\n'));
      },
    },
  );
  if (!cfg) throw new Error(`could not read ${dir}/tsconfig.json`);
  const host = ts.createCompilerHost(cfg.options);
  const norm = (f: string) => ts.sys.resolvePath(f).replace(/\\/g, '/');
  const virt = new Map(Object.entries(virtual).map(([p, t]) => [norm(join(root, p)), t]));
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

/** A package's production sources: under its src/, not tests, test tooling, generated code or declarations. */
export function productionSources(program: TS.Program, dir: string): TS.SourceFile[] {
  const src = `${join(REPO, dir, 'src').replace(/\\/g, '/')}/`;
  return program.getSourceFiles().filter((sf) => {
    const f = sf.fileName.replace(/\\/g, '/');
    return (
      f.startsWith(src) &&
      !/\.(int\.|ob12\.)?spec\.ts$/.test(f) &&
      !f.includes('/testing/') &&
      !f.includes('/__session_sql_fixtures__/') &&
      !f.includes('/generated/') &&
      !f.endsWith('.d.ts')
    );
  });
}

/** The violations in one file: session-scoped SQL, and SQL it can't establish. */
export function analyzeSessionSql(program: TS.Program, sf: TS.SourceFile): string[] {
  const checker = program.getTypeChecker();
  const boundParameter = boundParameterOf(program);
  const out: string[] = [];
  const where = (n: TS.Node) =>
    `${relative(REPO, sf.fileName).replace(/\\/g, '/')}:${String(sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1)}`;
  const refuse = (n: TS.Node, why: string) =>
    out.push(`${where(n)}: ${why}: refused (fail closed)`);
  const check = (n: TS.Node, text: string, how: string) => {
    const r = sessionSqlProblems(text);
    if ('error' in r) refuse(n, `${how} with SQL that doesn't lex unambiguously: ${r.error}`);
    else for (const p of r.problems) out.push(`${where(n)}: ${how}: ${p}`);
  };
  const declFiles = (n: TS.Node) => {
    let sym = checker.getSymbolAtLocation(n);
    if (sym && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
    return (sym?.declarations ?? []).map((d) => d.getSourceFile().fileName.replace(/\\/g, '/'));
  };
  const symbolOf = (n: TS.Node) => {
    const sym = checker.getSymbolAtLocation(n);
    return sym && sym.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(sym) : sym;
  };
  const declaredIn = (sym: TS.Symbol | undefined, where: RegExp) =>
    (sym?.declarations ?? []).some((d) =>
      where.test(d.getSourceFile().fileName.replace(/\\/g, '/')),
    );
  /** A method that runs SQL: one of Prisma's raw methods, or pg's query(), by declaration. */
  /**
   * Where a callable type's SQL comes from, by its SIGNATURES' declarations (owner review of 40c80fe): pg's query()
   * ('pg') or one of Prisma's raw methods (its name), whatever the property or variable holding it is declared as
   * (`interface Db { query: Client['query'] }`, a parameter, a const). Union members are inspected one by one.
   */
  const sqlOrigin = (t: TS.Type): string | undefined => {
    if (t.isUnion()) return t.types.map(sqlOrigin).find((o) => o !== undefined);
    for (const sig of t.getCallSignatures()) {
      const decl = sig.getDeclaration() as TS.SignatureDeclaration | undefined;
      const name = decl?.name && ts.isIdentifier(decl.name) ? decl.name.text : undefined;
      const file = decl?.getSourceFile().fileName.replace(/\\/g, '/') ?? '';
      if (name === 'query' && PG_DECL.test(file)) return 'pg';
      if (name && RAW.has(name) && RAW_DECL.test(file)) return name;
    }
    return undefined;
  };
  /** A member that runs SQL: by its own declaration, or by its callable type's origin. */
  const isSqlMember = (sym: TS.Symbol | undefined) =>
    !!sym &&
    ((RAW.has(sym.getName()) && declaredIn(sym, RAW_DECL)) ||
      (sym.getName() === 'query' && declaredIn(sym, PG_DECL)) ||
      sqlOrigin(checker.getTypeOfSymbol(sym)) !== undefined);
  /** Whether a value of this type has a SQL-running method (a Prisma client or transaction, a pg client or pool, or
   * any object with a member whose callable type comes from one). */
  const hasSqlMembers = (t: TS.Type): boolean =>
    t.isUnion()
      ? t.types.some(hasSqlMembers)
      : checker.getPropertiesOfType(checker.getApparentType(t)).some(isSqlMember);
  const nameOf = (e: TS.Expression) =>
    ts.isPropertyAccessExpression(e) ? e.name.text : ts.isIdentifier(e) ? e.text : undefined;
  /** Prisma's own `sql` / `raw`, resolved by declaration. */
  const isPrisma = (e: TS.Expression, name: string) =>
    nameOf(e) === name &&
    declFiles(ts.isPropertyAccessExpression(e) ? e.name : e).some((f) => PRISMA_DECL.test(f));
  /** A template's static text, interpolations as bound parameters ($1, $2, …), or null when one isn't proven. */
  const templateText = (t: TS.TemplateLiteral, how: string): string | null => {
    if (ts.isNoSubstitutionTemplateLiteral(t)) return t.text;
    let text = t.head.text;
    for (const [i, span] of t.templateSpans.entries()) {
      const ty = checker.getTypeAtLocation(span.expression);
      if (!boundParameter(ty)) {
        refuse(
          span.expression,
          `${how} interpolates ${checker.typeToString(ty)}, which isn't proven to be a bound parameter`,
        );
        return null;
      }
      text += ` $${String(i + 1)} ${span.literal.text}`;
    }
    return text;
  };
  const literalText = (e: TS.Expression | undefined) =>
    e && (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) ? e.text : undefined;

  const visit = (n: TS.Node): void => {
    if (ts.isTaggedTemplateExpression(n)) {
      const tagOrigin = sqlOrigin(checker.getTypeAtLocation(n.tag));
      const name = tagOrigin && RAW_TAGGED.has(tagOrigin) ? tagOrigin : nameOf(n.tag);
      if (name && RAW_TAGGED.has(name)) {
        const text = templateText(n.template, name);
        if (text !== null) check(n, text, name);
      } else if (isPrisma(n.tag, 'sql')) {
        const text = templateText(n.template, 'Prisma.sql');
        if (text !== null) check(n, text, 'Prisma.sql');
      }
    } else if (ts.isCallExpression(n)) {
      // The callee's type origin decides, whatever its syntax: a wrapper's member, a parameter, a variable.
      const origin = sqlOrigin(checker.getTypeAtLocation(n.expression));
      const byName = nameOf(n.expression);
      const name =
        origin === 'pg'
          ? 'query'
          : (origin ??
            (byName && RAW.has(byName) && ts.isPropertyAccessExpression(n.expression)
              ? byName
              : undefined));
      const [first] = n.arguments;
      if (name && RAW.has(name)) {
        if (RAW_UNSAFE.has(name)) {
          const text = literalText(first);
          if (text === undefined)
            refuse(n, `${name} with SQL that isn't a substitution-free literal`);
          else check(n, text, name);
        } else if (!(first && ts.isTaggedTemplateExpression(first) && isPrisma(first.tag, 'sql'))) {
          refuse(n, `${name}(…) with something other than a Prisma.sql template`);
        }
      } else if (isPrisma(n.expression, 'raw')) {
        const text = literalText(first);
        if (text === undefined)
          refuse(n, "Prisma.raw with SQL that isn't a substitution-free literal");
        else check(n, text, 'Prisma.raw');
      } else if (
        origin === 'pg' ||
        (byName === 'query' &&
          ts.isPropertyAccessExpression(n.expression) &&
          declFiles(n.expression.name).some((f) => PG_DECL.test(f)))
      ) {
        const text = literalText(first);
        if (text === undefined)
          refuse(n, "pg query() with SQL that isn't a substitution-free literal");
        else check(n, text, 'pg query()');
      }
    }
    // Any other reference to a SQL-running method (extracted, bound, called through .call/.apply, destructured, by a
    // computed key) can't be followed, so it is refused. Identified by DECLARATION (Prisma's raw methods, pg's
    // query), and by name as a backstop for raw methods whose types don't resolve.
    if (
      ts.isPropertyAccessExpression(n) &&
      (RAW.has(n.name.text) || isSqlMember(symbolOf(n.name)))
    ) {
      const p = n.parent;
      const immediate =
        (ts.isCallExpression(p) && p.expression === n) ||
        (ts.isTaggedTemplateExpression(p) && p.tag === n);
      if (!immediate) refuse(n, `${n.name.text} referenced other than by its immediate call`);
    }
    if (ts.isElementAccessExpression(n) && hasSqlMembers(checker.getTypeAtLocation(n.expression)))
      refuse(n, 'computed access on a database client: the member it reaches can’t be established');
    if (ts.isObjectBindingPattern(n) && hasSqlMembers(checker.getTypeAtLocation(n))) {
      for (const el of n.elements) {
        const key = el.propertyName ?? el.name;
        const named = ts.isIdentifier(key) || ts.isStringLiteral(key) ? key.text : undefined;
        if (named === undefined || RAW.has(named) || named === 'query')
          refuse(el, `${named ?? 'a computed member'} destructured from a database client`);
      }
    }
    // FLOW: a value with SQL-running methods may not flow into a type through which they could still be called but
    // no longer be followed: (a) a type with a SAME-NAMED member that isn't of SQL origin (structural assignment
    // carries the method across: `interface Db { query(sql: string): … }` given a pg Client), or (b) an erased type
    // (unknown, any, object, {}), from which a later cast could restore anything. A narrowed view without those
    // members (`Pick<PlatformClient, 'keyReencryption'>`) can't run SQL and is fine.
    const lost = (value: TS.Expression, target: TS.Type | undefined, how: string) => {
      if (!target) return;
      const source = checker.getApparentType(checker.getTypeAtLocation(value));
      const sqlNames = checker
        .getPropertiesOfType(source)
        .filter(isSqlMember)
        .map((p) => p.getName());
      if (sqlNames.length === 0) return;
      const erased =
        (target.flags & (ts.TypeFlags.Unknown | ts.TypeFlags.Any | ts.TypeFlags.NonPrimitive)) !==
          0 ||
        (!!(target.flags & ts.TypeFlags.Object) &&
          checker.getPropertiesOfType(checker.getApparentType(target)).length === 0 &&
          target.getCallSignatures().length === 0 &&
          checker.getIndexInfosOfType(checker.getApparentType(target)).length === 0);
      const wrapped = sqlNames.filter((name) => {
        const there = checker.getPropertyOfType(checker.getApparentType(target), name);
        return there !== undefined && !isSqlMember(there);
      });
      // A string index signature lets any name through (a symbol index, as Prisma's client declares, can't).
      const indexed = checker
        .getIndexInfosOfType(checker.getApparentType(target))
        .some((i) => (i.keyType.flags & ts.TypeFlags.String) !== 0);
      if (erased || wrapped.length > 0 || indexed)
        refuse(
          value,
          `a database client ${how} ${checker.typeToString(target)}, which ${
            wrapped.length
              ? `carries ${wrapped.join(', ')} without its SQL origin`
              : 'erases its SQL methods'
          }`,
        );
    };
    if (ts.isCallExpression(n) || ts.isNewExpression(n))
      for (const arg of n.arguments ?? []) lost(arg, checker.getContextualType(arg), 'passed as');
    if (ts.isVariableDeclaration(n) && n.type && n.initializer)
      lost(n.initializer, checker.getTypeFromTypeNode(n.type), 'assigned to');
    if (ts.isReturnStatement(n) && n.expression)
      lost(n.expression, checker.getContextualType(n.expression), 'returned as');
    if (ts.isPropertyAssignment(n))
      lost(n.initializer, checker.getContextualType(n.initializer), 'stored as');
    if (ts.isShorthandPropertyAssignment(n))
      lost(n.name, checker.getContextualType(n.name), 'stored as');
    if (ts.isAsExpression(n) || ts.isTypeAssertionExpression(n) || ts.isSatisfiesExpression(n))
      lost(n.expression, checker.getTypeFromTypeNode(n.type), 'asserted as');
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken)
      lost(n.right, checker.getTypeAtLocation(n.left), 'assigned to');
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** Every violation across the scanned packages' production sources, and the files scanned (repo-relative). */
export function sessionSqlScan(): { violations: string[]; files: string[] } {
  const violations: string[] = [];
  const files: string[] = [];
  for (const dir of SCANNED) {
    const program = packageProgram(dir);
    for (const sf of productionSources(program, dir)) {
      files.push(relative(REPO, sf.fileName).replace(/\\/g, '/'));
      violations.push(...analyzeSessionSql(program, sf));
    }
  }
  return { violations, files };
}
