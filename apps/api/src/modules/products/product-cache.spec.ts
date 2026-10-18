// Spec 0016 IO12: the products cache's deadlines are monotonic and count from the start of the load.
import type { PlatformClient } from '@univarse/db';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../config/config.js';
import type { AuditWriter } from '../../shared/audit/audit-writer.js';
import type { ShardRegistry } from '../../shared/db/db.module.js';
import type { InvalidationBus } from '../../shared/infra/invalidation-bus.js';
import { ProductService } from './product.service.js';

const T = '0190a000-0000-7000-8000-00000000000a';
const TTL = 1_000;
let now = 0;

function setup(readMs = 0) {
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  let reads = 0;
  const platform = {
    tenantProduct: {
      findMany: () => {
        reads++;
        now += readMs;
        return Promise.resolve([{ product: 'helpdesk' }]);
      },
    },
  } as unknown as PlatformClient;
  const bus = { on: () => undefined } as unknown as InvalidationBus;
  const service = new ProductService(
    platform,
    { TENANT_CACHE_TTL_MS: TTL } as AppConfig,
    {} as ShardRegistry,
    {} as AuditWriter,
    bus,
  );
  return { service, reads: () => reads };
}

afterEach(() => {
  vi.restoreAllMocks();
  now = 0;
});

describe('[IO12] products cache deadlines', () => {
  it('[IO12] with Date.now() stepped back 10 minutes after caching, the entry still expires on its monotonic deadline', async () => {
    const { service, reads } = setup();
    const wall = vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    await service.active(T);
    wall.mockReturnValue(1_800_000_000_000 - 600_000);
    now = TTL - 1;
    await service.active(T);
    expect(reads()).toBe(1);
    now = TTL + 1;
    await service.active(T);
    expect(reads()).toBe(2);
  });

  it('[IO12] an entry whose load straddles a change expires at its load start plus the TTL, not its end', async () => {
    const { service, reads } = setup(600);
    await service.active(T); // load from 0 to 600
    now = TTL + 1;
    await service.active(T);
    expect(reads()).toBe(2);
  });
});
