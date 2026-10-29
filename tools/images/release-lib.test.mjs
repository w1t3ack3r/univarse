// Spec 0019: the role table, the role sets and the CS3 base check. `node --test tools/images/release-lib.test.mjs`.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { devOnlyPackages, LEGACY_ROLE_NAMES, REPO, ROLE_SETS, ROLES, rolesOf, runtimeBaseOf } from './release-lib.mjs';

const PIN = `gcr.io/distroless/base-debian13:nonroot@sha256:${'a'.repeat(64)}`;
const df = (body) => `ARG BUILD_IMAGE=x\n${body}\nFROM \${BUILD_IMAGE} AS build\nRUN true\nFROM \${RUNTIME_IMAGE} AS runtime\n`;

test('[LS2] four release roles, each with its own repository and Dockerfile; the legacy set is api and web', () => {
  assert.deepEqual(Object.keys(ROLES), ['api', 'web', 'migrate', 'pgbouncer']);
  assert.equal(new Set(Object.values(ROLES).map((r) => r.repo)).size, 4);
  assert.deepEqual([...LEGACY_ROLE_NAMES], ['api', 'web']);
  assert.deepEqual(ROLE_SETS.map((s) => s.join()), ['api,web,migrate,pgbouncer', 'api,web']);
  assert.deepEqual(Object.keys(rolesOf(LEGACY_ROLE_NAMES)), ['api', 'web']);
});

test('[LS2] every role\'s Dockerfile passes the CS3 base check', () => {
  for (const [role, r] of Object.entries(ROLES)) {
    const base = runtimeBaseOf(readFileSync(join(REPO, r.dockerfile), 'utf8'), r.dockerfile);
    assert.match(base, /@sha256:[0-9a-f]{64}$/, role);
  }
});

test('[LS2] the CS3 base check fails closed: two bases, a tag, or a final stage not FROM the base', () => {
  assert.equal(runtimeBaseOf(df(`ARG RUNTIME_IMAGE=${PIN}`), 'x'), PIN);
  assert.throws(() => runtimeBaseOf(df(`ARG RUNTIME_IMAGE=${PIN}\nARG RUNTIME_IMAGE=${PIN}`), 'x'), /exactly once/);
  assert.throws(() => runtimeBaseOf(df('ARG RUNTIME_IMAGE=gcr.io/distroless/base:latest'), 'x'), /not digest-pinned/);
  assert.throws(() => runtimeBaseOf(`ARG RUNTIME_IMAGE=${PIN}\nFROM \${RUNTIME_IMAGE} AS runtime\nFROM debian AS sneaky\n`, 'x'), /final stage/);
});

test('[T30] an SBOM holding a Storybook package is found, by name or by purl; ordinary packages are not', () => {
  const pkg = (name, purl) => ({ name, ...(purl ? { externalRefs: [{ referenceType: 'purl', referenceLocator: purl }] } : {}) });
  assert.deepEqual(devOnlyPackages({ packages: [pkg('react', 'pkg:npm/react@19.3.0'), pkg('next', 'pkg:npm/next@16.4.2')] }), []);
  assert.deepEqual(devOnlyPackages({ packages: [pkg('storybook', 'pkg:npm/storybook@10.6.3')] }), ['storybook']);
  assert.deepEqual(devOnlyPackages({ packages: [pkg('react-vite', 'pkg:npm/%40storybook/react-vite@10.6.3')] }), ['@storybook/react-vite']);
  assert.deepEqual(devOnlyPackages({ packages: [pkg('@storybook/addon-a11y')] }), ['@storybook/addon-a11y']);
  // Look-alikes are not Storybook: a name containing the word, or another scope.
  assert.deepEqual(devOnlyPackages({ packages: [pkg('storybook-utils', 'pkg:npm/storybook-utils@1.0.0'), pkg('x', 'pkg:npm/%40acme/storybook@1.0.0')] }), []);
  assert.deepEqual(devOnlyPackages({}), []);
});
