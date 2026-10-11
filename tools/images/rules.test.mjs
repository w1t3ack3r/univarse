// Spec 0013 CS1/CS2: the inspection rules. Run with `node --test tools/images/`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { forbiddenReason, isOurs, ownershipReason } from './rules.mjs';

test('[CS1] our own paths: workspace packages yes, third-party dependencies no', () => {
  assert.equal(isOurs('app/dist/main.js'), true);
  assert.equal(isOurs('app/node_modules/.pnpm/@univarse+db@file+packages+db/node_modules/@univarse/db/dist/index.js'), true);
  assert.equal(isOurs('app/node_modules/.pnpm/zod@4.6.5/node_modules/zod/index.ts'), false);
});

test('[CS1] UniVarse source, tests, env files and test helpers are refused', () => {
  for (const [p, why] of [
    ['app/src/main.ts', 'UniVarse src/ directory'],
    ['app/node_modules/@univarse/db/src/index.ts', 'UniVarse src/ directory'],
    ['app/dist/testing/int-harness.js', 'UniVarse testing/ directory'],
    ['app/dist/shared/outbox/outbox.int.spec.js', 'test file'],
    ['app/dist/foo.spec.js', 'test file'],
    ['app/.env', 'environment file'],
    ['app/.env.production', 'environment file'],
    ['app/docs/README.md', 'UniVarse docs/ directory'],
    ['app/apps/web/e2e/auth.e2e.ts', 'UniVarse e2e/ directory'],
    ['app/dist/otel.ts', 'UniVarse TypeScript source'],
    ['app/server.key', 'key material'],
  ]) assert.equal(forbiddenReason(p), why, p);
});

test('[CS1] allowed: build output, our declaration files, and every third-party file including .ts', () => {
  for (const p of [
    'app/dist/main.js',
    'app/node_modules/@univarse/db/dist/index.d.ts',
    'app/node_modules/.pnpm/zod@4.6.5/node_modules/zod/src/index.ts', // third-party source: not ours
    'app/node_modules/.pnpm/@types+node@24/node_modules/@types/node/index.d.ts',
    'app/apps/web/.next/server/app/(auth)/login/page.js',
    'nodejs/bin/node', // the base image's files aren't judged
    'etc/passwd',
  ]) assert.equal(forbiddenReason(p), null, p);
});

test('[CS1] ownership: root-owned and not writable by group/other; links ignored', () => {
  assert.equal(ownershipReason({ type: 'file', uid: 0, gid: 0, mode: 0o644 }), null);
  assert.equal(ownershipReason({ type: 'dir', uid: 0, gid: 0, mode: 0o755 }), null);
  assert.match(ownershipReason({ type: 'file', uid: 65532, gid: 65532, mode: 0o644 }) ?? '', /not root/);
  assert.match(ownershipReason({ type: 'file', uid: 0, gid: 0, mode: 0o666 }) ?? '', /writable/);
  assert.equal(ownershipReason({ type: 'symlink', uid: 0, gid: 0, mode: 0o777 }), null);
});
