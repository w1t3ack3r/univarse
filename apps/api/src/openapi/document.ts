// Spec 0011: builds the OpenAPI document from the app's controllers. It reads the same decorator
// metadata the guards enforce (access, step-up, enrolment-only, product, tenant) plus each handler's
// `@Contract`, and refuses to produce a document with any gap: a route without a contract, a path
// parameter that doesn't match the route, a schema zod can't convert, or one that converts to `{}`.
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants.js';
import { type ApiOperation, type CookieName, type SettingDef } from '@univarse/contracts';
import { z } from 'zod';
import { routeAccess } from '../modules/identity/access.guard.js';
import { requiresStepUp } from '../modules/identity/actor.js';
import { PRODUCT } from '../modules/products/product.guard.js';
import { NO_TENANT } from '../shared/tenancy/tenant.guard.js';
import { CONTRACT } from './contract.js';

type Json = Record<string, unknown>;
type Ctor = new (...args: never[]) => unknown;

export const OPENAPI_VERSION = '3.1.1';
export const JSON_SCHEMA_DIALECT = 'https://json-schema.org/draft/2020-12/schema';
const COOKIES: Record<CookieName, string> = { session: '__Host-uv_sid', mfaChallenge: '__Host-uv_mfa' };
const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const ORDER = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

export class ContractError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`OpenAPI generation refused (spec 0011):\n  - ${problems.join('\n  - ')}`);
    this.name = 'ContractError';
  }
}

export interface ApiRoute {
  readonly method: string;
  /** Nest form, e.g. `/api/v1/files/:id`. */
  readonly path: string;
  readonly controller: Ctor;
  readonly handlerName: string;
  readonly handler: object;
}

/** Every route handler of these controllers, the same way Nest registers them. */
export function apiRoutes(controllers: readonly Ctor[]): ApiRoute[] {
  const out: ApiRoute[] = [];
  for (const controller of controllers) {
    const base = String(Reflect.getMetadata(PATH_METADATA, controller) ?? '');
    const proto = controller.prototype as Record<string, unknown>;
    for (const handlerName of Object.getOwnPropertyNames(proto)) {
      const handler = proto[handlerName];
      if (handlerName === 'constructor' || typeof handler !== 'function') continue;
      const sub = Reflect.getMetadata(PATH_METADATA, handler) as string | undefined;
      if (sub === undefined) continue;
      const method = RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod];
      const path = '/' + [base, sub].map((p) => p.replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/');
      out.push({ method, path, controller, handlerName, handler });
    }
  }
  return out;
}

export const routeKey = (method: string, path: string) => `${method} ${path}`;
const template = (path: string) => path.replace(/:(\w+)/g, '{$1}');

/** zod → JSON Schema 2020-12. Anything zod can't represent throws, naming where (OA3). */
export function toJsonSchema(schema: z.ZodType, io: 'input' | 'output', where: string): Json {
  try {
    const out = z.toJSONSchema(schema, { target: 'draft-2020-12', io, unrepresentable: 'throw' }) as Json;
    delete out.$schema;
    return out;
  } catch (err) {
    throw new ContractError([`${where}: not representable in JSON Schema (${err instanceof Error ? err.message : String(err)})`]);
  }
}

/** JSON Schema assertion keywords: a schema with none of them accepts anything (`z.unknown()`, `z.any()`). */
const MEANINGFUL = [
  'type', 'const', 'enum', '$ref', 'anyOf', 'oneOf', 'allOf', 'not',
  'required', 'dependentRequired', 'minProperties', 'maxProperties', 'pattern', 'minLength', 'maxLength',
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minItems', 'maxItems',
];

/** OA3: lists every schema that says nothing (`{}`, `true`, or no assertion keyword), by JSON pointer. */
export function emptySchemas(schema: unknown, pointer: string): string[] {
  if (schema === true || typeof schema !== 'object' || schema === null) return [pointer];
  const s = schema as Json;
  const found: string[] = MEANINGFUL.some((k) => k in s) ? [] : [pointer];
  const each = (key: string, value: unknown) => {
    if (Array.isArray(value)) value.forEach((v, i) => found.push(...emptySchemas(v, `${pointer}/${key}/${String(i)}`)));
    else if (value && typeof value === 'object') found.push(...emptySchemas(value, `${pointer}/${key}`));
  };
  for (const key of ['items', 'not', 'anyOf', 'oneOf', 'allOf', 'prefixItems']) if (key in s) each(key, s[key]);
  if (s.additionalProperties && typeof s.additionalProperties === 'object') each('additionalProperties', s.additionalProperties);
  for (const map of ['properties', '$defs']) {
    const m = s[map] as Json | undefined;
    if (m) for (const [k, v] of Object.entries(m)) found.push(...emptySchemas(v, `${pointer}/${map}/${k.replaceAll('~', '~0').replaceAll('/', '~1')}`));
  }
  return found;
}

/**
 * The document. `controllers` is the production list (`API_CONTROLLERS`); `settings` is the
 * production registry, from which the per-key value shapes and permissions are derived.
 */
export function buildOpenApi(controllers: readonly Ctor[], settings: Readonly<Record<string, SettingDef>>): Json {
  const problems: string[] = [];
  const paths: Record<string, Record<string, Json>> = {};
  const schemas: Record<string, Json> = {};
  const seenIds = new Map<string, string>();
  const tags = new Set<string>();

  const routes = apiRoutes(controllers).sort(
    (a, b) => a.path.localeCompare(b.path) || ORDER.indexOf(a.method) - ORDER.indexOf(b.method),
  );
  for (const r of routes) {
    const where = routeKey(r.method, r.path);
    const op = Reflect.getMetadata(CONTRACT, r.handler) as ApiOperation | undefined;
    if (!op) {
      problems.push(`${where} (${r.controller.name}.${r.handlerName}): no @Contract`);
      continue;
    }
    const dup = seenIds.get(op.operationId);
    if (dup) problems.push(`${where}: operationId ${op.operationId} already used by ${dup}`);
    seenIds.set(op.operationId, where);

    const declared = (key: string): unknown => Reflect.getMetadata(key, r.handler) ?? Reflect.getMetadata(key, r.controller);
    const noTenant = declared(NO_TENANT) === true;
    const product = declared(PRODUCT) as string | undefined;
    const { access, explicitStepUp, allowRestricted } = routeAccess(r.handler, r.controller);
    if (!noTenant && !access) problems.push(`${where}: no access declaration (the guard refuses every request)`);

    // Path parameters: exactly the route's, described as checked today (no validation is added).
    const names = [...r.path.matchAll(/:(\w+)/g)].map((m) => String(m[1]));
    const params = op.params ?? {};
    if (names.join(',') !== Object.keys(params).join(',')) {
      problems.push(`${where}: path parameters [${names.join(', ')}] but the contract declares [${Object.keys(params).join(', ')}]`);
    }

    const permission = access?.kind === 'permission' ? access.permission : undefined;
    const stepUp = explicitStepUp || (permission !== undefined && requiresStepUp(permission));
    const isPublic = noTenant || access?.kind === 'public';
    const security = op.cookies?.reads ? [{ [op.cookies.reads]: [] }] : isPublic ? [] : [{ session: [] }];

    const operation: Json = { operationId: op.operationId, summary: op.summary, tags: [op.tag] };
    tags.add(op.tag);
    try {
      const documented = names.filter((name) => name in params); // a mismatch is already a problem above
      if (documented.length > 0) {
        operation.parameters = documented.flatMap((name) => {
          const p = params[name];
          if (!p) return [];
          return {
            name,
            in: 'path',
            required: true,
            description: p.description,
            schema: toJsonSchema(p.schema, 'input', `${where} path parameter ${name}`),
            'x-invalid': p.invalid,
          };
        });
      }
      if (op.body) {
        let body = toJsonSchema(op.body, 'input', `${where} request body`);
        if (op.valueBySettingKey) body = settingValueBody(body, settings, schemas, where);
        operation.requestBody = { required: true, content: { 'application/json': { schema: body } } };
      }
    } catch (err) {
      if (err instanceof ContractError) problems.push(...err.problems);
      else throw err;
    }
    // Step 3 adds response schemas, headers and every error (OA4).
    operation.responses = { [String(op.success)]: { description: op.success === 204 ? 'No content' : 'Success' } };
    operation.security = security;

    if (noTenant) operation['x-no-tenant'] = true;
    if (product) operation['x-product'] = product;
    if (permission) operation['x-permission'] = permission;
    if (op.permissionBySettingKey) {
      operation['x-permission-by-key'] = Object.fromEntries(
        Object.entries(settings).map(([k, d]) => [k, { permission: d.manage, stepUp: requiresStepUp(d.manage) }]),
      );
    }
    if (!isPublic) operation['x-step-up'] = stepUp;
    if (allowRestricted) operation['x-allow-restricted'] = true;
    if (op.rateLimit) operation['x-rate-limit'] = op.rateLimit;
    if (UNSAFE.has(r.method)) operation['x-csrf'] = 'same-origin';
    if (op.cookies) {
      operation['x-cookies'] = Object.fromEntries(
        Object.entries(op.cookies).map(([k, v]) => [k, Array.isArray(v) ? v.map((c: CookieName) => COOKIES[c]) : COOKIES[v as CookieName]]),
      );
    }

    (paths[template(r.path)] ??= {})[r.method.toLowerCase()] = operation;
  }

  // OA3: nothing in the document may be an empty schema.
  for (const [name, s] of Object.entries(schemas)) for (const p of emptySchemas(s, `#/components/schemas/${name}`)) problems.push(`empty schema at ${p}`);
  for (const [path, methods] of Object.entries(paths)) {
    for (const [method, o] of Object.entries(methods)) {
      const base = `#/paths/${path.replaceAll('~', '~0').replaceAll('/', '~1')}/${method}`;
      ((o.parameters ?? []) as Json[]).forEach((p, i) => problems.push(...emptySchemas(p.schema, `${base}/parameters/${String(i)}/schema`).map((x) => `empty schema at ${x}`)));
      const body = (o.requestBody as { content: Record<string, { schema: unknown }> } | undefined)?.content['application/json']?.schema;
      if (body !== undefined) problems.push(...emptySchemas(body, `${base}/requestBody/content/application~1json/schema`).map((x) => `empty schema at ${x}`));
    }
  }
  if (problems.length > 0) throw new ContractError(problems);

  return {
    openapi: OPENAPI_VERSION,
    jsonSchemaDialect: JSON_SCHEMA_DIALECT,
    info: {
      title: 'UniVarse API',
      version: 'v1',
      description: 'Generated by `pnpm contracts:gen` from the API route metadata (spec 0011). Do not edit by hand.',
    },
    tags: [...tags].sort().map((name) => ({ name })),
    paths,
    components: {
      securitySchemes: {
        session: { type: 'apiKey', in: 'cookie', name: COOKIES.session, description: 'Set by login, MFA verify and step-up; HttpOnly.' },
        mfaChallenge: { type: 'apiKey', in: 'cookie', name: COOKIES.mfaChallenge, description: 'Set by login when a second factor is needed; read only by MFA verify.' },
      },
      schemas: Object.fromEntries(Object.entries(schemas).sort(([a], [b]) => a.localeCompare(b))),
    },
  };
}

/**
 * Settings: one operation for every key. The envelope is the strict request schema; its `value` is
 * documented as one shape per registry key, and `x-value-by-key` ties each key to its shape (a body
 * union alone can't say which value goes with which path key). The use case still validates the value
 * (422 settings.invalid_value); nothing here moves that check.
 */
function settingValueBody(envelope: Json, settings: Readonly<Record<string, SettingDef>>, schemas: Record<string, Json>, where: string): Json {
  const refs: Record<string, string> = {};
  for (const [key, def] of Object.entries(settings)) {
    const name = `SettingValue.${key}`;
    schemas[name] = { title: key, ...toJsonSchema(def.schema, 'input', `${where} value for ${key}`) };
    refs[key] = `#/components/schemas/${name}`;
  }
  const properties = { ...(envelope.properties as Json), value: { anyOf: Object.values(refs).map(($ref) => ({ $ref })) } };
  return { ...envelope, properties, 'x-value-by-key': { parameter: 'key', values: refs } };
}
