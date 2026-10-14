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
    const earlier = stmt.slice(0, k);
    if (isWord(t, 'set')) {
      // UPDATE … SET, ON CONFLICT DO UPDATE SET, ALTER … SET and ON DELETE/UPDATE SET NULL aren't the SET command.
      const notCommand =
        earlier.some((e) => isWord(e, 'update', 'alter')) || isWord(prev, 'delete', 'update');
      if (!notCommand && !isWord(next, 'local'))
        problems.push(
          `SET without LOCAL (SET ${next?.value.toUpperCase() ?? ''}) is session-scoped`,
        );
    } else if (isWord(t, 'reset') && !earlier.some((e) => isWord(e, 'alter'))) {
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
    }
  });
  return problems;
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
  const allowed = new Set<TS.Node>(); // raw-method names used as an immediate callee or tag

  const visit = (n: TS.Node): void => {
    if (ts.isTaggedTemplateExpression(n)) {
      const name = nameOf(n.tag);
      if (name && RAW_TAGGED.has(name)) {
        if (ts.isPropertyAccessExpression(n.tag)) allowed.add(n.tag.name);
        const text = templateText(n.template, name);
        if (text !== null) check(n, text, name);
      } else if (isPrisma(n.tag, 'sql')) {
        const text = templateText(n.template, 'Prisma.sql');
        if (text !== null) check(n, text, 'Prisma.sql');
      }
    } else if (ts.isCallExpression(n)) {
      const name = nameOf(n.expression);
      const [first] = n.arguments;
      if (name && RAW.has(name) && ts.isPropertyAccessExpression(n.expression)) {
        allowed.add(n.expression.name);
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
        name === 'query' &&
        ts.isPropertyAccessExpression(n.expression) &&
        declFiles(n.expression.name).some((f) => PG_DECL.test(f))
      ) {
        const text = literalText(first);
        if (text === undefined)
          refuse(n, "pg query() with SQL that isn't a substitution-free literal");
        else check(n, text, 'pg query()');
      }
    }
    // Any other reference to a raw method (extracted, bound, destructured, by string key) can't be followed.
    if (ts.isIdentifier(n) && RAW.has(n.text) && !allowed.has(n)) {
      const p = n.parent;
      const isKey = ts.isPropertyAccessExpression(p) && p.name === n;
      if (isKey || ts.isBindingElement(p) || ts.isShorthandPropertyAssignment(p))
        refuse(n, `${n.text} referenced other than by its immediate call`);
    }
    if (ts.isStringLiteral(n) && RAW.has(n.text) && ts.isElementAccessExpression(n.parent))
      refuse(n, `${n.text} referenced by a computed key`);
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
