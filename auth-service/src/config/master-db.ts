// Master Database Connection
// Connects to the central UniVerse master database

import { PrismaClient } from '../../../master-db/prisma/generated/client';

// Create master DB Prisma client
const masterDb = new PrismaClient({
    datasources: {
        db: {
            url: process.env.MASTER_DATABASE_URL,
        },
    },
});

// Connect on startup
masterDb.$connect()
    .then(() => console.log('[MasterDB] Connected successfully'))
    .catch((err: Error) => console.error('[MasterDB] Connection failed:', err));

export { masterDb };

// Types for Institution
export interface InstitutionConfig {
    id: string;
    code: string;
    name: string;
    subdomain: string;
    dbHost: string;
    dbPort: number;
    dbName: string;
    dbUser: string;
    dbPassword: string;
    isActive: boolean;
    isProvisioned: boolean;
}
