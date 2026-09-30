// Tenant Database Connection Manager
// Manages dynamic database connections per institution

import { PrismaClient } from '@prisma/client';

interface TenantConnection {
    institutionId: string;
    subdomain: string;
    prisma: PrismaClient;
    lastUsed: Date;
}

interface InstitutionDbConfig {
    id: string;
    subdomain: string;
    dbHost: string;
    dbPort: number;
    dbName: string;
    dbUser: string;
    dbPassword: string;
}

class TenantConnectionManager {
    private connections: Map<string, TenantConnection> = new Map();
    private maxIdleTimeMs: number = 30 * 60 * 1000; // 30 minutes
    private cleanupIntervalMs: number = 5 * 60 * 1000; // 5 minutes

    constructor() {
        // Start cleanup interval to close idle connections
        setInterval(() => this.cleanupIdleConnections(), this.cleanupIntervalMs);
    }

    /**
     * Get or create a Prisma client for a specific tenant
     */
    async getConnection(config: InstitutionDbConfig): Promise<PrismaClient> {
        const existing = this.connections.get(config.id);

        if (existing) {
            existing.lastUsed = new Date();
            return existing.prisma;
        }

        // Create new connection
        const connectionUrl = this.buildConnectionUrl(config);
        const prisma = new PrismaClient({
            datasources: {
                db: {
                    url: connectionUrl,
                },
            },
        });

        // Test connection
        await prisma.$connect();

        // Cache the connection
        this.connections.set(config.id, {
            institutionId: config.id,
            subdomain: config.subdomain,
            prisma,
            lastUsed: new Date(),
        });

        console.log(`[TenantDB] Created connection for: ${config.subdomain}`);
        return prisma;
    }

    /**
     * Build PostgreSQL connection URL from config
     */
    private buildConnectionUrl(config: InstitutionDbConfig): string {
        // URL encode password to handle any special characters
        const encodedPassword = encodeURIComponent(config.dbPassword);
        return `postgresql://${config.dbUser}:${encodedPassword}@${config.dbHost}:${config.dbPort}/${config.dbName}?schema=public`;
    }

    /**
     * Close and remove a specific connection
     */
    async closeConnection(institutionId: string): Promise<void> {
        const conn = this.connections.get(institutionId);
        if (conn) {
            await conn.prisma.$disconnect();
            this.connections.delete(institutionId);
            console.log(`[TenantDB] Closed connection for institution: ${institutionId}`);
        }
    }

    /**
     * Close all idle connections (not used recently)
     */
    private async cleanupIdleConnections(): Promise<void> {
        const now = new Date();
        const connectionsToClose: string[] = [];

        for (const [id, conn] of this.connections) {
            const idleTime = now.getTime() - conn.lastUsed.getTime();
            if (idleTime > this.maxIdleTimeMs) {
                connectionsToClose.push(id);
            }
        }

        for (const id of connectionsToClose) {
            await this.closeConnection(id);
        }

        if (connectionsToClose.length > 0) {
            console.log(`[TenantDB] Cleaned up ${connectionsToClose.length} idle connections`);
        }
    }

    /**
     * Close all connections (for graceful shutdown)
     */
    async closeAllConnections(): Promise<void> {
        for (const [id, conn] of this.connections) {
            await conn.prisma.$disconnect();
        }
        this.connections.clear();
        console.log('[TenantDB] All connections closed');
    }

    /**
     * Get connection stats (for monitoring)
     */
    getStats(): { totalConnections: number; connections: { subdomain: string; lastUsed: Date }[] } {
        return {
            totalConnections: this.connections.size,
            connections: Array.from(this.connections.values()).map(c => ({
                subdomain: c.subdomain,
                lastUsed: c.lastUsed,
            })),
        };
    }

    /**
     * Get active connection count (for socket monitoring)
     */
    getActiveConnectionCount(): number {
        return this.connections.size;
    }
}

// Singleton instance
export const tenantConnectionManager = new TenantConnectionManager();
