import { PrismaPg } from '@prisma/adapter-pg';

/**
 * Every connection runs in UTC. The pg adapter exchanges `timestamptz` values as zone-less UTC
 * strings, so a server or role whose TimeZone isn't UTC (e.g. a local install in Africa/Lagos)
 * would store every timestamp shifted by its offset and break comparisons with SQL `now()`.
 * Found by the outbox retry test (spec 0002 B4), 2026-10-05.
 */
export const utcAdapter = (connectionString: string) => new PrismaPg({ connectionString, options: '-c TimeZone=UTC' });
