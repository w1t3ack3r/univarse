// Spec 0027 P7: a record's own role set, for verifying an older release as it was signed (the restore's), never a
// different one. The deploy never uses it: it verifies every role.
import { describe, expect, it } from 'vitest';
import { RELEASE_ROLES, roleSetOf, type ReleaseRecord } from './release.js';

const rec = (roles: string[]): ReleaseRecord => ({ commit: 'a'.repeat(40), images: Object.fromEntries(roles.map((r) => [r, { repo: `univarse-${r}`, digest: 'sha256:x' }])) });

describe('[P7] a record\'s role set', () => {
  it('a five-role record is every role', () => {
    expect(roleSetOf(rec([...RELEASE_ROLES]))).toEqual(RELEASE_ROLES);
  });

  it('a four-role record (before spec 0027) is the four-role set, in any order', () => {
    expect([...roleSetOf(rec(['pgbouncer', 'web', 'api', 'migrate']))]).toEqual(['api', 'web', 'migrate', 'pgbouncer']);
  });

  it('a record naming no known set is held to every role, and so fails verification on its own terms', () => {
    expect(roleSetOf(rec(['api', 'web', 'console']))).toEqual(RELEASE_ROLES);
    expect(roleSetOf(rec(['api']))).toEqual(RELEASE_ROLES);
  });
});
