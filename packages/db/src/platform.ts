import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/platform/client.js';

/** Control-plane client. Holds no tenant personal data (docs/02 §7.1). */
export function createPlatformClient(connectionString: string): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

export type PlatformClient = PrismaClient;
