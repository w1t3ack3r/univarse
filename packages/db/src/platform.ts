import { utcAdapter } from './pool.js';
import { PrismaClient } from './generated/platform/client.js';

/** Control-plane client. Holds no tenant personal data (docs/02 §7.1). */
export function createPlatformClient(connectionString: string): PrismaClient {
  return new PrismaClient({ adapter: utcAdapter(connectionString) });
}

export type PlatformClient = PrismaClient;
