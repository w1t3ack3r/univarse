// Spec 0020 (where the database step runs): in production, keys are destroyed only by the destruction job, for its op.
import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../config/config.js';
import { DestructionRefusedError, destructionJobProblem, KeyDestruction } from './key-forget.js';

const OP = '0192c7a4-1b2c-7d3e-8f40-123456789abc';
const OTHER = '0192c7a4-1b2c-7d3e-8f40-cba987654321';

describe('[D14] destructionJobProblem', () => {
  it('[D14] outside production any UUID op is accepted', () => {
    expect(destructionJobProblem(OP, { NODE_ENV: 'development', UNIVARSE_DESTRUCTION_OP: undefined })).toBeNull();
    expect(destructionJobProblem(OP, { NODE_ENV: 'test', UNIVARSE_DESTRUCTION_OP: undefined })).toBeNull();
  });

  it('[D14] in production only the job started for that op may destroy', () => {
    expect(destructionJobProblem(OP, { NODE_ENV: 'production', UNIVARSE_DESTRUCTION_OP: OP })).toBeNull();
    expect(destructionJobProblem(OP, { NODE_ENV: 'production', UNIVARSE_DESTRUCTION_OP: OP.toUpperCase() })).toBeNull();
    expect(destructionJobProblem(OP, { NODE_ENV: 'production', UNIVARSE_DESTRUCTION_OP: undefined })).toMatch(/only by the destruction job/);
    expect(destructionJobProblem(OP, { NODE_ENV: 'production', UNIVARSE_DESTRUCTION_OP: OTHER })).toMatch(/not this destruction job's op/);
  });

  it('[D14] the op is always a UUID', () => {
    expect(destructionJobProblem('x', { NODE_ENV: 'development', UNIVARSE_DESTRUCTION_OP: undefined })).toMatch(/UUID/);
  });
});

describe('[D14] KeyDestruction refuses outside the job before touching the database', () => {
  const production = { NODE_ENV: 'production', UNIVARSE_DESTRUCTION_OP: undefined, RETIRED_KEY_GRACE_MS: 60 * 60_000 } as AppConfig;

  it.each([
    ['shredTenantKeys', (d: KeyDestruction) => d.shredTenantKeys(OP, null, 'test', { op: OP })],
    ['destroyRetired', (d: KeyDestruction) => d.destroyRetired(OP, 1, () => Promise.resolve(0), { op: OP, actorId: null, reason: 'test' })],
    ['reapply (spec 0020 A2)', (d: KeyDestruction) => d.reapply({ op: OP, tenantId: OP, kind: 'TENANT', versions: [1], actorId: null, reason: 'test' })],
    ['adopt (spec 0020 A2)', (d: KeyDestruction) => d.adopt({ op: OP, tenantId: OP, kind: 'TENANT', versions: [1], actorId: null, reason: 'test' })],
  ])('[D14] %s', async (_name, call) => {
    const transaction = vi.fn();
    const platform = { $transaction: transaction, keyDestruction: { findUnique: transaction }, tenantDataKey: { findUnique: transaction } };
    const d = new KeyDestruction(production, platform as never, {} as never, {} as never);
    await expect(call(d)).rejects.toBeInstanceOf(DestructionRefusedError);
    expect(transaction).not.toHaveBeenCalled();
  });
});
