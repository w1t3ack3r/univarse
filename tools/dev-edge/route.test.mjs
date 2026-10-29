// Spec 0027 P3, P9: the dev edge's routing. `node --test tools/dev-edge/route.test.mjs`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { route } from './route.mjs';

test('the console host: the platform API for /api/platform/*, the console app for the rest', () => {
  assert.equal(route('console.univarse.localhost:4180', '/api/platform/v1/staff'), 'platform-api');
  assert.equal(route('CONSOLE.univarse.localhost', '/API/Platform/v1/x?y=1'), 'platform-api');
  assert.equal(route('console.univarse.localhost:4180', '/'), 'console');
  assert.equal(route('console.univarse.localhost:4180', '/api/v1/auth/me'), 'console');
  assert.equal(route('console.univarse.localhost:4180', '/health/live'), 'console');
});

test('a tenant host never reaches the platform API, and keeps its own routes', () => {
  assert.equal(route('demo-uni.univarse.localhost:4180', '/api/platform/v1/staff'), 'refuse');
  assert.equal(route('demo-uni.univarse.localhost:4180', '/api/platform'), 'refuse');
  assert.equal(route('demo-uni.univarse.localhost:4180', '/api/v1/auth/me'), 'api');
  assert.equal(route('demo-uni.univarse.localhost:4180', '/health/live'), 'api');
  assert.equal(route('demo-uni.univarse.localhost:4180', '/login'), 'web');
  // A look-alike path or host is not the platform's.
  assert.equal(route('demo-uni.univarse.localhost', '/api/platformer'), 'api');
  assert.equal(route('consoles.univarse.localhost', '/api/platform/v1/x'), 'refuse');
});
