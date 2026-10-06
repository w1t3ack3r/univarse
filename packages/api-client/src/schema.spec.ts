// Spec 0011 OA9: the committed types are exactly what openapi-typescript makes from the committed
// document. A contract change without `pnpm contracts:gen` fails here.
import { readFileSync } from 'node:fs';
import openapiTS, { astToString, COMMENT_HEADER } from 'openapi-typescript';
import { describe, expect, it } from 'vitest';

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');

describe('[OA9] generated types are fresh', () => {
  it('[OA9] src/schema.ts equals openapi-typescript of openapi.json (run `pnpm contracts:gen`)', async () => {
    const ast = await openapiTS(JSON.parse(read('../openapi.json')) as Parameters<typeof openapiTS>[0]);
    const fresh = COMMENT_HEADER + astToString(ast);
    expect(read('./schema.ts').replace(/\r\n/g, '\n'), 'packages/api-client/src/schema.ts is stale: run pnpm contracts:gen').toBe(fresh);
  });
});
