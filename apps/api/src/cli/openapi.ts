// Spec 0011: writes packages/api-client/openapi.json from the API's route metadata. No database,
// Valkey or Vault is needed: nothing is instantiated, only decorator metadata is read.
//
//   pnpm contracts:gen        (root: builds the API, then runs this)
import 'reflect-metadata';
import { writeFileSync } from 'node:fs';
import { SETTINGS } from '@univarse/contracts';
import { API_CONTROLLERS } from '../app.module.js';
import { buildOpenApi } from '../openapi/document.js';

export const OPENAPI_FILE = new URL('../../../../packages/api-client/openapi.json', import.meta.url);

const doc = buildOpenApi(API_CONTROLLERS, SETTINGS);
writeFileSync(OPENAPI_FILE, `${JSON.stringify(doc, null, 2)}\n`);
const ops = Object.values(doc.paths as Record<string, object>).reduce((n, m) => n + Object.keys(m).length, 0);
console.log(`openapi.json written: ${String(ops)} operations`);
