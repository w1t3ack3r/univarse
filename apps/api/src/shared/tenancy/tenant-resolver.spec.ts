// Spec 0016 IO12 (monotonic deadlines from the load's start) and IO13 (the subscriber, negative entries and the
// global generation), against a fake platform client and bus: the clock and the reads are controlled exactly.
import type { PlatformClient } from '@univarse/db';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../config/config.js';
import { CHANNELS, type InvalidationBus } from '../infra/invalidation-bus.js';
import { TenantResolver } from './tenant-resolver.service.js';

const A = '0190a000-0000-7000-8000-00000000000a';
const B = '0190a000-0000-7000-8000-00000000000b';
const TTL = 1_000;
const row = (tenantId: string) => ({
  verifiedAt: new Date(),
  tenant: {
    id: tenantId,
    shardId: 's',
    slug: tenantId.slice(-1),
    shortName: 'X',
    legalName: 'X',
    type: 'UNIVERSITY',
    status: 'ACTIVE',
  },
});

let now = 0;
function setup(lookup: (host: string) => Promise<ReturnType<typeof row> | null>) {
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const reads: string[] = [];
  const handlers = new Map<string, (tenantId: string) => void>();
  const platform = {
    tenantDomain: {
      findUnique: ({ where }: { where: { hostname: string } }) => (
        reads.push(where.hostname),
        lookup(where.hostname)
      ),
    },
  } as unknown as PlatformClient;
  const bus = {
    on: (c: string, h: (t: string) => void) => handlers.set(c, h),
  } as unknown as InvalidationBus;
  const resolver = new TenantResolver(platform, { TENANT_CACHE_TTL_MS: TTL } as AppConfig, bus);
  resolver.onModuleInit();
  const message = (tenantId: string) => handlers.get(CHANNELS.tenants)?.(tenantId);
  return { resolver, reads, message };
}
const hosts: Record<string, string | null> = { 'a.test': A, 'b.test': B, 'unknown.test': null };
const byHost = (host: string) => Promise.resolve(hosts[host] ? row(hosts[host]) : null);

afterEach(() => {
  vi.restoreAllMocks();
  now = 0;
});

describe('[IO12] resolver deadlines are monotonic, from the start of the load', () => {
  it('[IO12] with Date.now() stepped back 10 minutes after caching, the entry still expires on its monotonic deadline', async () => {
    const { resolver, reads } = setup(byHost);
    const wall = vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    await resolver.resolveHost('a.test');
    wall.mockReturnValue(1_800_000_000_000 - 600_000);
    now = TTL - 1;
    await resolver.resolveHost('a.test');
    expect(reads).toHaveLength(1);
    now = TTL + 1;
    await resolver.resolveHost('a.test');
    expect(reads).toHaveLength(2);
  });

  it('[IO12] an entry whose load straddles a change expires at its load start plus the TTL, not its end', async () => {
    const { resolver, reads } = setup(async (host) => {
      now += 600; // the read takes 600 ms
      return byHost(host);
    });
    await resolver.resolveHost('a.test'); // load from 0 to 600
    now = TTL + 1;
    await resolver.resolveHost('a.test');
    expect(reads).toHaveLength(2);
  });
});

describe('[IO13] the subscriber and the global generation', () => {
  it('[IO13] a message for A evicts A and every negative entry; B survives', async () => {
    const { resolver, reads, message } = setup(byHost);
    for (const h of Object.keys(hosts)) await resolver.resolveHost(h);
    message(A);
    for (const h of Object.keys(hosts)) await resolver.resolveHost(h);
    expect(reads).toEqual(['a.test', 'b.test', 'unknown.test', 'a.test', 'unknown.test']);
  });

  it('[IO13] a lookup that a tenants message overtakes, for any tenant, caches nothing: not even a negative result', async () => {
    let fire: (() => void) | undefined;
    const { resolver, reads, message } = setup(async (host) => {
      fire?.();
      return byHost(host);
    });
    // An unknown host: no tenant id is known yet, so only a global generation can guard it.
    fire = () => message(B);
    expect(await resolver.resolveHost('unknown.test')).toBeNull();
    fire = undefined;
    await resolver.resolveHost('unknown.test');
    expect(reads).toEqual(['unknown.test', 'unknown.test']);
  });

  it('[IO13] invalidate() also bumps the generation: an in-flight lookup is not cached', async () => {
    const ref: { resolver?: TenantResolver } = {};
    let during = true;
    const { resolver, reads } = setup(async (host) => {
      if (during) ref.resolver?.invalidate();
      return byHost(host);
    });
    ref.resolver = resolver;
    await resolver.resolveHost('a.test');
    during = false;
    await resolver.resolveHost('a.test');
    await resolver.resolveHost('a.test');
    expect(reads).toEqual(['a.test', 'a.test']);
  });
});
