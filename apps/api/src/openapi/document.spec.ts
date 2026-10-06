// Spec 0011 step 2: the generator and the committed document. No services needed.
import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { SETTING_KEYS, SETTINGS, type ApiOperation } from '@univarse/contracts';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { API_CONTROLLERS } from '../app.module.js';
import { Public } from '../modules/identity/access.guard.js';
import { Product } from '../modules/products/product.guard.js';
import { CONTROL_ROUTES, LeakyControlsController } from '../testing/route-controls.js';
import { Contract } from './contract.js';
import { apiRoutes, buildOpenApi, ContractError, JSON_SCHEMA_DIALECT, OPENAPI_VERSION, routeKey, toJsonSchema } from './document.js';

type Json = Record<string, unknown>;
type Op = Json & { operationId: string; parameters?: Json[]; requestBody?: { content: Record<string, { schema: Json }> } };

const doc = buildOpenApi(API_CONTROLLERS, SETTINGS) as Json & { paths: Record<string, Record<string, Op>>; components: { schemas: Record<string, Json> } };
const committed = readFileSync(new URL('../../../../packages/api-client/openapi.json', import.meta.url), 'utf8');
const ops = Object.entries(doc.paths).flatMap(([path, methods]) => Object.entries(methods).map(([method, op]) => ({ path, method: method.toUpperCase(), op })));
const byId = (id: string) => ops.find((o) => o.op.operationId === id)!.op;
const ids = (pred: (o: Op, method: string) => boolean) => ops.filter((o) => pred(o.op, o.method)).map((o) => o.op.operationId).sort();
const refuses = (fn: () => unknown): string[] => {
  try {
    fn();
  } catch (err) {
    if (err instanceof ContractError) return [...err.problems];
    throw err;
  }
  return [];
};

describe('[OA1] target and freshness', () => {
  it('[OA1] OpenAPI 3.1.1 with JSON Schema 2020-12', () => {
    expect([doc.openapi, doc.jsonSchemaDialect]).toEqual([OPENAPI_VERSION, JSON_SCHEMA_DIALECT]);
    expect(OPENAPI_VERSION).toBe('3.1.1');
  });

  it('[OA1][OA9] the committed openapi.json is exactly what the generator builds (run `pnpm contracts:gen`)', () => {
    expect(committed, 'packages/api-client/openapi.json is stale: run pnpm contracts:gen').toBe(`${JSON.stringify(doc, null, 2)}\n`);
  });
});

describe('[OA2] every production route, and only those', () => {
  it('[OA2] the documented operations are exactly the production routes (sets, not a count), health included', () => {
    const routes = apiRoutes(API_CONTROLLERS).map((r) => routeKey(r.method, r.path.replace(/:(\w+)/g, '{$1}')));
    expect(new Set(ops.map((o) => routeKey(o.method, o.path)))).toEqual(new Set(routes));
    expect(routes).toContain('GET /health/live');
    expect(routes).toContain('GET /health/ready');
  });

  it('[OA2] the test-only control routes are named in one constant and are not production routes', () => {
    expect(apiRoutes([LeakyControlsController]).map((r) => routeKey(r.method, r.path)).sort()).toEqual([...CONTROL_ROUTES].sort());
    const production = new Set(apiRoutes(API_CONTROLLERS).map((r) => routeKey(r.method, r.path)));
    for (const r of CONTROL_ROUTES) expect(production.has(r), r).toBe(false);
    expect(API_CONTROLLERS as readonly unknown[]).not.toContain(LeakyControlsController);
  });

  it('[OA2] a route without @Contract refuses generation, naming the route', () => {
    @Controller('api/v1/x')
    @Product('core')
    class NoContract {
      @Get('y')
      @Public()
      y() {}
    }
    expect(refuses(() => buildOpenApi([NoContract], SETTINGS))).toEqual(['GET /api/v1/x/y (NoContract.y): no @Contract']);
  });

  it('[OA2] path parameters must be exactly the route’s', () => {
    const op: ApiOperation = { operationId: 'p', summary: 's', tag: 'files', success: 200 };
    @Controller('api/v1/x')
    @Product('core')
    class MissingParam {
      @Contract(op)
      @Get(':id')
      @Public()
      y(@Param('id') _id: string) {}
    }
    expect(refuses(() => buildOpenApi([MissingParam], SETTINGS))).toEqual(['GET /api/v1/x/:id: path parameters [id] but the contract declares []']);
  });

  it('[OA2] operationIds are unique', () => {
    expect(new Set(ops.map((o) => o.op.operationId)).size).toBe(ops.length);
  });
});

describe('[OA3] request schemas are the validators, and nothing converts to {}', () => {
  const fake = (body: z.ZodType) => {
    @Controller('api/v1/x')
    @Product('core')
    class Fake {
      @Contract({ operationId: 'fake', summary: 's', tag: 'files', body, success: 200 })
      @Post('y')
      @Public()
      y(@Body() _b: unknown) {}
    }
    return Fake;
  };

  it('[OA3] each documented body is its operation’s schema converted for input', () => {
    for (const r of apiRoutes(API_CONTROLLERS)) {
      const op = Reflect.getMetadata('univarse:contract', r.handler) as ApiOperation;
      if (!op.body || op.valueBySettingKey) continue;
      expect(byId(op.operationId).requestBody?.content['application/json']?.schema, op.operationId).toEqual(toJsonSchema(op.body, 'input', op.operationId));
    }
  });

  it('[OA3] every controller parses its body with its own @Contract operation (one object, not a copy)', () => {
    for (const file of ['files/files', 'identity/auth', 'identity/mfa', 'products/products', 'settings/settings']) {
      const src = readFileSync(new URL(`../modules/${file}.controller.ts`, import.meta.url), 'utf8');
      const blocks = src.split(/(?=@Contract\()/).slice(1);
      for (const block of blocks) {
        const contract = /^@Contract\((\w+Ops\.\w+)\)/.exec(block)![1];
        for (const m of block.matchAll(/parse\(([^,]+),/g)) expect(m[1], `${file}: ${contract!}`).toBe(`${contract!}.body`);
      }
    }
  });

  it('[OA3] request bodies are strict (additionalProperties: false)', () => {
    for (const { op } of ops) {
      const s = op.requestBody?.content['application/json']?.schema;
      if (!s) continue;
      const objects = 'anyOf' in s ? (s.anyOf as Json[]) : [s];
      for (const o of objects) expect(o.additionalProperties, op.operationId).toBe(false);
    }
  });

  it('[OA3] a schema zod cannot represent refuses generation, naming the operation', () => {
    const problems = refuses(() => buildOpenApi([fake(z.object({ at: z.date() }).strict())], SETTINGS));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^POST \/api\/v1\/x\/y request body: not representable in JSON Schema/);
  });

  it('[OA3] a schema that converts to {} refuses generation, naming the JSON pointer', () => {
    expect(refuses(() => buildOpenApi([fake(z.object({ anything: z.unknown() }).strict())], SETTINGS))).toEqual([
      'empty schema at #/paths/~1api~1v1~1x~1y/post/requestBody/content/application~1json/schema/properties/anything',
    ]);
  });
});

describe('[OA3] settings: one operation, value shapes derived from the registry, tied to the key', () => {
  const put = byId('putSetting');
  const body = put.requestBody!.content['application/json']!.schema as Json & { properties: { value: { anyOf: { $ref: string }[] } }; 'x-value-by-key': { parameter: string; values: Record<string, string> } };

  it('[OA3] the key parameter is the registry’s keys; unknown keys are documented as 404 settings.unknown_key', () => {
    const key = put.parameters!.find((p) => p.name === 'key')!;
    expect((key.schema as { enum: string[] }).enum.sort()).toEqual([...SETTING_KEYS].sort());
    expect(key['x-invalid']).toEqual({ status: 404, code: 'settings.unknown_key' });
  });

  it('[OA3] each key’s value shape is that key’s registry schema, and x-value-by-key ties key to shape', () => {
    expect(body['x-value-by-key'].parameter).toBe('key');
    expect(Object.keys(body['x-value-by-key'].values).sort()).toEqual([...SETTING_KEYS].sort());
    for (const k of SETTING_KEYS) {
      const ref = body['x-value-by-key'].values[k]!;
      const name = ref.replace('#/components/schemas/', '');
      expect(doc.components.schemas[name], k).toEqual({ title: k, ...toJsonSchema(SETTINGS[k].schema, 'input', k) });
      expect(body.properties.value.anyOf).toContainEqual({ $ref: ref });
    }
    expect(body.additionalProperties).toBe(false);
  });

  it('[OA5] writes document each key’s own manage permission and its step-up', () => {
    for (const id of ['putSetting', 'resetSetting']) {
      const byKey = byId(id)['x-permission-by-key'] as Record<string, { permission: string; stepUp: boolean }>;
      expect(Object.keys(byKey).sort(), id).toEqual([...SETTING_KEYS].sort());
      for (const k of SETTING_KEYS) expect(byKey[k]!.permission).toBe(SETTINGS[k].manage);
    }
  });
});

describe('[OA5][OA6] authentication, step-up, CSRF and path parameters as enforced', () => {
  it('[OA5] public operations have no security; MFA verify uses the challenge cookie; the rest the session', () => {
    expect(ids((o) => (o.security as unknown[]).length === 0)).toEqual(
      ['confirmActivation', 'confirmPasswordReset', 'live', 'login', 'publicProfile', 'ready', 'requestActivation', 'requestPasswordReset'].sort(),
    );
    expect(byId('verifyMfa').security).toEqual([{ mfaChallenge: [] }]);
    expect(ids((o) => JSON.stringify(o.security) === '[{"session":[]}]')).toHaveLength(ops.length - 9);
  });

  it('[OA5] x-step-up is derived from @RequireStepUp and the permission catalog, as the guard does', () => {
    // Explicit: disable, regenerate. Catalog: settings.product.manage is stepUp-flagged, so even the
    // products overview GET needs a fresh step-up (the web app wraps it in withStepUp).
    expect(ids((o) => o['x-step-up'] === true)).toEqual(['disableTotp', 'productsOverview', 'regenerateRecoveryCodes', 'setProductEnabled']);
  });

  it('[OA5] enrolment-only sessions are allowed exactly where @AllowRestricted is (spec 0001 M15′)', () => {
    expect(ids((o) => o['x-allow-restricted'] === true)).toEqual(['beginTotpEnrolment', 'confirmTotpEnrolment', 'logout', 'me']);
  });

  it('[OA5] health routes are tenantless; every other route declares its product', () => {
    expect(ids((o) => o['x-no-tenant'] === true)).toEqual(['live', 'ready']);
    expect(ids((o) => o['x-product'] === undefined)).toEqual(['live', 'ready']);
  });

  it('[OA6] every unsafe operation documents the CSRF requirement, and no safe one does', () => {
    for (const { op, method } of ops) expect(op['x-csrf'], op.operationId).toBe(method === 'GET' ? undefined : 'same-origin');
  });

  it('[OA2] path parameters document today’s check: invalid or unknown values are 404, never 400', () => {
    const withParams = ops.filter((o) => o.op.parameters?.length);
    expect(withParams.length).toBeGreaterThan(0);
    for (const { op } of withParams) for (const p of op.parameters!) expect((p['x-invalid'] as { status: number }).status, op.operationId).toBe(404);
  });
});
