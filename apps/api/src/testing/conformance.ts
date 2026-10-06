// Spec 0011 OA10: every response an integration test receives is checked against the committed OpenAPI
// document, as it went over the wire (status, media type, raw payload, headers), not as the service
// returned it. Attach with `createApp(config, { beforeInit: attachConformance })`.
//
// UNIVARSE_OA_RECORD=<file>: record mode (no checks); appends one JSON line per response, used to write
// the response schemas from real traffic.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { problemType } from '../shared/errors/problem.js';

type Json = Record<string, unknown>;
interface ResponseSpec {
  description?: string;
  'x-set-cookie'?: { sets: string[]; clears: string[] };
  headers?: Record<string, { required?: boolean; schema?: Json }>;
  content?: Record<string, { schema?: Json }>;
}
interface Operation {
  operationId: string;
  responses: Record<string, ResponseSpec>;
  'x-empty'?: boolean;
}
interface Matcher {
  method: string;
  path: string;
  re: RegExp;
  op: Operation;
}

const DOC_URL = new URL('../../../../packages/api-client/openapi.json', import.meta.url);
let cache: { doc: Json & { paths: Record<string, Record<string, Operation>> }; matchers: Matcher[]; ajv: Ajv2020 } | undefined;
const validators = new Map<string, ValidateFunction>();

function load() {
  if (cache) return cache;
  const doc = JSON.parse(readFileSync(DOC_URL, 'utf8')) as Json & { paths: Record<string, Record<string, Operation>>; components: Json };
  const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
  ajv.addKeyword('x-value-by-key');
  ajv.addFormat('uuid', /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  ajv.addFormat('date-time', true);
  ajv.addFormat('uri', true);
  ajv.addSchema({ $id: 'openapi', $defs: (doc.components as { schemas: Json }).schemas });
  const matchers: Matcher[] = [];
  for (const [path, methods] of Object.entries(doc.paths)) {
    const re = new RegExp(`^${path.replace(/\{\w+\}/g, '[^/]+')}$`);
    for (const [method, op] of Object.entries(methods)) matchers.push({ method: method.toUpperCase(), path, re, op });
  }
  // Literal paths before templated ones (e.g. /files/uploads before /files/{id}).
  matchers.sort((a, b) => Number(a.path.includes('{')) - Number(b.path.includes('{')));
  cache = { doc, matchers, ajv };
  return cache;
}

/** Schema refs point into the document's components; compile once per (operation, status, media). */
function validatorFor(key: string, schema: Json): ValidateFunction {
  let v = validators.get(key);
  if (!v) {
    const { ajv } = load();
    const rewritten = JSON.parse(JSON.stringify(schema).replaceAll('"#/components/schemas/', '"openapi#/$defs/')) as Json;
    v = ajv.compile(rewritten);
    validators.set(key, v);
  }
  return v;
}

export interface Seen {
  readonly operationId: string;
  readonly status: number;
}
export const seen: Seen[] = [];

export interface WireResponse {
  readonly statusCode: number;
  readonly headers: Record<string, string | string[] | number | undefined>;
  readonly rawPayload: Buffer;
}

const header = (res: WireResponse, name: string) => {
  const v = res.headers[name];
  return v === undefined ? undefined : Array.isArray(v) ? v.join(', ') : String(v);
};

/** The problems with one response, or [] if it matches its documented operation. */
export function checkResponse(method: string, url: string, res: WireResponse): string[] {
  const { matchers } = load();
  const path = url.split('?')[0]!;
  const m = matchers.find((x) => x.method === method && x.re.test(path));
  if (!m) return []; // not an API operation (unknown route, test-only control): nothing to check
  const where = `${method} ${path} → ${String(res.statusCode)} (${m.op.operationId})`;
  const spec = m.op.responses[String(res.statusCode)];
  if (!spec) return [`${where}: status not documented`];
  seen.push({ operationId: m.op.operationId, status: res.statusCode });
  const seenFile = process.env.UNIVARSE_OA_SEEN;
  if (seenFile) appendFileSync(seenFile, `${m.op.operationId} ${String(res.statusCode)}\n`);
  const problems: string[] = [];

  // Documented headers.
  for (const [name, h] of Object.entries(spec.headers ?? {})) {
    const value = header(res, name.toLowerCase());
    if (value === undefined) {
      if (h.required) problems.push(`${where}: header ${name} missing`);
      continue;
    }
    if (h.schema && !validatorFor(`${m.op.operationId}:${String(res.statusCode)}:h:${name}`, h.schema)(value)) {
      problems.push(`${where}: header ${name} = ${JSON.stringify(value)} does not match its schema`);
    }
  }

  // Cookies: only the documented ones, each with the documented attributes (OA5).
  const rule = spec['x-set-cookie'];
  if (rule) {
    const raw = res.headers['set-cookie'];
    const lines = Array.isArray(raw) ? raw.map(String) : raw === undefined ? [] : [String(raw)];
    for (const line of lines) {
      const name = line.split('=')[0]!;
      const attrs = line.split(';').map((a) => a.trim());
      if (!rule.sets.includes(name) && !rule.clears.includes(name)) problems.push(`${where}: sets undocumented cookie ${name}`);
      for (const a of ['Path=/', 'HttpOnly', 'Secure', 'SameSite=Lax']) if (!attrs.includes(a)) problems.push(`${where}: cookie ${name} lacks ${a}`);
      if (!attrs.some((a) => a.startsWith('Max-Age='))) problems.push(`${where}: cookie ${name} lacks Max-Age`);
      if (rule.clears.includes(name) && !rule.sets.includes(name) && !attrs.includes('Max-Age=0')) problems.push(`${where}: cookie ${name} should be cleared (Max-Age=0)`);
    }
  }

  const content = spec.content ?? {};
  if (Object.keys(content).length === 0) {
    if (res.rawPayload.length > 0) problems.push(`${where}: documented as empty, but the body has ${String(res.rawPayload.length)} bytes`);
    return problems;
  }
  const media = (header(res, 'content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  const entry = content[media];
  if (!entry) return [...problems, `${where}: content-type ${media || '(none)'} not documented (${Object.keys(content).join(', ')})`];

  if (!media.endsWith('json')) {
    // Binary: the type is one of the documented ones (checked above); the length is the payload's.
    const length = Number(header(res, 'content-length'));
    if (length !== res.rawPayload.length) problems.push(`${where}: Content-Length ${String(length)} but the payload is ${String(res.rawPayload.length)} bytes`);
    return problems;
  }

  let body: unknown;
  try {
    body = JSON.parse(res.rawPayload.toString('utf8'));
  } catch {
    return [...problems, `${where}: body is not JSON`];
  }
  const validate = validatorFor(`${m.op.operationId}:${String(res.statusCode)}:${media}`, entry.schema ?? {});
  if (!validate(body)) {
    problems.push(`${where}: body does not match: ${(validate.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? ''}`).join('; ')}`);
  }
  if (media === 'application/problem+json') {
    const p = body as { type?: unknown; code?: unknown };
    if (typeof p.code === 'string' && p.type !== problemType(p.code)) problems.push(`${where}: type ${String(p.type)} is not problemType(${p.code})`);
  }
  return problems;
}

/** Wraps `fastify.inject` so every test request's response is checked (or recorded). */
export function attachConformance(fastify: FastifyInstance): void {
  const record = process.env.UNIVARSE_OA_RECORD;
  const original = fastify.inject.bind(fastify) as (o: InjectOptions) => Promise<WireResponse & { body: string }>;
  const wrapped = async (opts: InjectOptions) => {
    const res = await original(opts);
    const method = (opts.method ?? 'GET').toUpperCase();
    const url = typeof opts.url === 'string' ? opts.url : ''; // every test injects with a string url
    if (record) {
      const media = String(res.headers['content-type'] ?? '').split(';')[0] ?? '';
      const text = media.includes('json') ? res.rawPayload.toString('utf8') : `<${String(res.rawPayload.length)} bytes>`;
      appendFileSync(record, `${JSON.stringify({ method, url, status: res.statusCode, headers: res.headers, body: text.slice(0, 4000) })}\n`);
      return res;
    }
    const problems = checkResponse(method, url, res);
    if (problems.length > 0) throw new Error(`OpenAPI conformance (spec 0011 OA10):\n  - ${problems.join('\n  - ')}`);
    return res;
  };
  (fastify as unknown as { inject: typeof wrapped }).inject = wrapped;
}

/**
 * OA10 coverage: documented operations and (operation, status) pairs the suite exercised, plus the
 * documented pairs it never saw, so gaps are visible rather than silent.
 */
export function coverageReport(seenFile: string): string {
  const { matchers } = load();
  const lines = existsSync(seenFile) ? readFileSync(seenFile, 'utf8').split('\n').filter(Boolean) : [];
  const seenPairs = new Set(lines);
  const allPairs = matchers.flatMap((m) => Object.keys(m.op.responses).map((st) => `${m.op.operationId} ${st}`));
  const ops = new Set(lines.map((l) => l.split(' ')[0]));
  const missing = allPairs.filter((p) => !seenPairs.has(p));
  return (
    `[openapi-conformance] operations ${String(ops.size)} of ${String(matchers.length)}; ` +
    `(operation, status) pairs seen ${String(allPairs.length - missing.length)} of ${String(allPairs.length)}; ` +
    `responses checked ${String(lines.length)}\n[openapi-conformance] never exercised: ${missing.join(', ') || 'none'}`
  );
}
