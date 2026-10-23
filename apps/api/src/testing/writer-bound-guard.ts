// Spec 0020 D15, condition 1: the writer bound W. Every write of an encrypted column encrypts INSIDE the tenant
// transaction that writes it, so no writer can commit later than that transaction's timeout after it read the
// active key version. This walks the API's production source with full type information, and fails closed:
//   • every call to FieldCrypto.encrypt / reencrypt / activeVersion is awaited, and either
//       (A) its nearest enclosing function is the callback given to ShardRegistry.tx or withTenantTx, or
//       (B) it is an argument (at any depth, with no function in between) of a call on a tenant transaction:
//           a parameter typed `TenantTx`, or a tx callback's parameter;
//   • FieldCrypto's guarded methods are never referenced any other way (aliased, destructured, by element access);
//   • a tenant transaction that asks for a longer timeout than the default is a REVIEWED long transaction that
//     never encrypts (LONG_TRANSACTIONS), so W stays TENANT_TX_TIMEOUT_MS.
import { createRequire } from 'node:module';
import { join, relative } from 'node:path';
import type * as TS from 'typescript';
import { API_DIR } from './program.js';

const require = createRequire(import.meta.url);
const ts = require('typescript') as typeof TS;
const SRC = join(API_DIR, 'src');
const GUARDED = new Set(['encrypt', 'reencrypt', 'activeVersion']);
const relPath = (f: string) => relative(SRC, f).replace(/\\/g, '/');

/** A transaction call that passes options (a timeout), with the file's reason it never encrypts. */
export type LongTransactions = Readonly<Record<string, string>>;

export interface WriterSite {
  readonly file: string;
  readonly method: string;
  readonly rule: 'A' | 'B';
}

function isFieldCrypto(checker: TS.TypeChecker, node: TS.Node): boolean {
  const t = checker.getTypeAtLocation(node);
  return (t.getSymbol() ?? t.aliasSymbol)?.getName() === 'FieldCrypto';
}

/** `this.shards.tx(…)` on a ShardRegistry, or `withTenantTx(…)`. */
function isTxCall(checker: TS.TypeChecker, call: TS.CallExpression): boolean {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text === 'withTenantTx';
  if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'tx') {
    const t = checker.getTypeAtLocation(callee.expression);
    return t.getSymbol()?.getName() === 'ShardRegistry';
  }
  return false;
}

const isFunctionLike = (n: TS.Node): boolean =>
  ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n) || ts.isConstructorDeclaration(n) || ts.isAccessor(n);

function txCallbackOf(checker: TS.TypeChecker, fn: TS.Node): boolean {
  if (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn)) return false;
  const call = fn.parent;
  return ts.isCallExpression(call) && call.arguments.includes(fn) && isTxCall(checker, call);
}

/** The root identifier of `a.b.c(…)`. */
function rootOf(e: TS.Expression): TS.Identifier | null {
  let cur: TS.Expression = e;
  while (ts.isPropertyAccessExpression(cur) || ts.isElementAccessExpression(cur) || ts.isCallExpression(cur) || ts.isNonNullExpression(cur)) cur = cur.expression;
  return ts.isIdentifier(cur) ? cur : null;
}

/** A parameter typed `TenantTx`, or a tx callback's parameter. */
function isTenantTx(checker: TS.TypeChecker, id: TS.Identifier): boolean {
  const decl = checker.getSymbolAtLocation(id)?.valueDeclaration;
  if (!decl || !ts.isParameter(decl)) return false;
  if (decl.type && ts.isTypeReferenceNode(decl.type) && decl.type.typeName.getText() === 'TenantTx') return true;
  return txCallbackOf(checker, decl.parent);
}

function ruleOf(checker: TS.TypeChecker, call: TS.CallExpression): 'A' | 'B' | null {
  // (B) an argument of a call on a tenant transaction, with no function in between.
  for (let n: TS.Node = call.parent; !isFunctionLike(n) && !ts.isSourceFile(n); n = n.parent) {
    if (ts.isCallExpression(n) && n !== call) {
      const root = rootOf(n.expression);
      if (root && ts.isPropertyAccessExpression(n.expression) && isTenantTx(checker, root)) return 'B';
    }
  }
  // (A) the nearest enclosing function is a tx callback.
  let fn: TS.Node = call.parent;
  while (!isFunctionLike(fn) && !ts.isSourceFile(fn)) fn = fn.parent;
  return txCallbackOf(checker, fn) ? 'A' : null;
}

function enclosingName(n: TS.Node): string {
  for (let cur: TS.Node = n; !ts.isSourceFile(cur); cur = cur.parent) {
    if ((ts.isMethodDeclaration(cur) || ts.isFunctionDeclaration(cur)) && cur.name) {
      const cls = ts.isClassDeclaration(cur.parent) && cur.parent.name ? `${cur.parent.name.text}.` : '';
      return `${cls}${cur.name.getText()}`;
    }
  }
  return '<top level>';
}

export function writerBoundReport(
  program: TS.Program,
  files: readonly TS.SourceFile[],
  longTransactions: LongTransactions,
): { sites: WriterSite[]; violations: string[] } {
  const checker = program.getTypeChecker();
  const sites: WriterSite[] = [];
  const violations: string[] = [];
  const longSeen = new Set<string>();
  const encryptingFiles = new Set<string>();
  const texts = new Map<string, string>();

  for (const sf of files) {
    const file = relPath(sf.fileName);
    texts.set(file, sf.text);
    const at = (n: TS.Node) => `${file}:${String(sf.getLineAndCharacterOfPosition(n.getStart()).line + 1)}`;
    const visit = (n: TS.Node): void => {
      if (ts.isPropertyAccessExpression(n) && GUARDED.has(n.name.text) && isFieldCrypto(checker, n.expression)) {
        const call = n.parent;
        if (!ts.isCallExpression(call) || call.expression !== n) {
          violations.push(`${at(n)}: FieldCrypto.${n.name.text} referenced without being called`);
        } else {
          encryptingFiles.add(file);
          const rule = ruleOf(checker, call);
          if (!ts.isAwaitExpression(call.parent)) violations.push(`${at(n)}: FieldCrypto.${n.name.text} is not awaited`);
          else if (!rule) violations.push(`${at(n)}: FieldCrypto.${n.name.text} outside its writing tenant transaction`);
          else sites.push({ file, method: `${enclosingName(n)} → ${n.name.text}`, rule });
        }
      }
      if (ts.isElementAccessExpression(n) && isFieldCrypto(checker, n.expression)) {
        violations.push(`${at(n)}: FieldCrypto accessed by element`);
      }
      if (ts.isVariableDeclaration(n) && ts.isObjectBindingPattern(n.name) && n.initializer && isFieldCrypto(checker, n.initializer)) {
        violations.push(`${at(n)}: FieldCrypto destructured`);
      }
      // ShardRegistry.tx itself only forwards its caller's options; its callers are the ones checked.
      if (ts.isCallExpression(n) && isTxCall(checker, n) && n.arguments.length > 3 && enclosingName(n) !== 'ShardRegistry.tx') {
        const key = `${file} ${enclosingName(n)}`;
        if (longTransactions[key] === undefined) violations.push(`${at(n)}: a tenant transaction with its own timeout (${key}) is not a reviewed long transaction`);
        else longSeen.add(key);
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  for (const key of Object.keys(longTransactions)) {
    if (!longSeen.has(key)) violations.push(`reviewed long transaction not found (stale entry): ${key}`);
    const longFile = key.split(' ')[0]!;
    if (encryptingFiles.has(longFile)) violations.push(`a reviewed long transaction's file encrypts: ${key}`);
    // Nor does it call a function that encrypts on the transaction it is given (rule B), e.g. Outbox.enqueueEmail.
    for (const s of sites.filter((x) => x.rule === 'B')) {
      const fn = s.method.split(' ')[0]!.split('.').at(-1)!;
      if (new RegExp(`\\b${fn}\\s*\\(`).test(texts.get(longFile) ?? '')) violations.push(`a reviewed long transaction's file calls ${s.method.split(' ')[0]!}: ${key}`);
    }
  }
  return { sites, violations };
}
