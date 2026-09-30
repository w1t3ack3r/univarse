// Socket.io Server for Real-Time Monitoring
// Provides live updates to Super Admin dashboard

import { Server as SocketServer } from 'socket.io';
import { Server as HttpServer } from 'http';
import { masterDb } from '../config/master-db';
import { tenantConnectionManager } from '../config/tenant-db';

interface PlatformStats {
    totalInstitutions: number;
    activeInstitutions: number;
    suspendedInstitutions: number;
    pendingDeletion: number;
    totalConnections: number;
    timestamp: Date;
}

interface LoginEvent {
    institutionId: string;
    institutionName: string;
    userEmail: string;
    role: string;
    timestamp: Date;
}

interface SystemHealth {
    status: 'healthy' | 'degraded' | 'unhealthy';
    uptime: number;
    memoryUsage: NodeJS.MemoryUsage;
    activeConnections: number;
    timestamp: Date;
}

class MonitoringSocketServer {
    private io: SocketServer | null = null;
    private statsInterval: NodeJS.Timeout | null = null;

    /**
     * Initialize Socket.io server
     */
    initialize(httpServer: HttpServer): void {
        this.io = new SocketServer(httpServer, {
            cors: {
                origin: process.env.CORS_ORIGIN || 'http://localhost:3000',
                methods: ['GET', 'POST'],
                credentials: true,
            },
            path: '/socket.io',
        });

        console.log('[Socket.io] Monitoring server initialized');

        // Handle connections
        this.io.on('connection', (socket) => {
            console.log(`[Socket.io] Client connected: ${socket.id}`);

            // Authenticate super admin (optional - can add JWT validation)
            socket.on('authenticate', async (token: string) => {
                // TODO: Validate super admin token
                socket.join('super-admin');
                console.log(`[Socket.io] Super Admin authenticated: ${socket.id}`);

                // Send initial stats
                const stats = await this.getPlatformStats();
                socket.emit('stats:initial', stats);
            });

            socket.on('disconnect', () => {
                console.log(`[Socket.io] Client disconnected: ${socket.id}`);
            });
        });

        // Start periodic stats broadcast
        this.startStatsBroadcast();
    }

    /**
     * Broadcast stats every 5 seconds
     */
    private startStatsBroadcast(): void {
        this.statsInterval = setInterval(async () => {
            try {
                const stats = await this.getPlatformStats();
                const health = this.getSystemHealth();

                this.io?.to('super-admin').emit('stats:update', stats);
                this.io?.to('super-admin').emit('health:update', health);
            } catch (error) {
                console.error('[Socket.io] Error broadcasting stats:', error);
            }
        }, 5000);
    }

    /**
     * Get current platform statistics
     */
    private async getPlatformStats(): Promise<PlatformStats> {
        const [total, active, suspended, pendingDeletion] = await Promise.all([
            masterDb.institution.count(),
            masterDb.institution.count({ where: { status: 'ACTIVE' } }),
            masterDb.institution.count({ where: { status: 'SUSPENDED' } }),
            masterDb.institution.count({ where: { status: 'PENDING_DELETION' } }),
        ]);

        return {
            totalInstitutions: total,
            activeInstitutions: active,
            suspendedInstitutions: suspended,
            pendingDeletion: pendingDeletion,
            totalConnections: tenantConnectionManager.getActiveConnectionCount(),
            timestamp: new Date(),
        };
    }

    /**
     * Get system health metrics
     */
    private getSystemHealth(): SystemHealth {
        const memUsage = process.memoryUsage();
        const uptimeSeconds = process.uptime();

        return {
            status: 'healthy',
            uptime: uptimeSeconds,
            memoryUsage: memUsage,
            activeConnections: this.io?.sockets.sockets.size || 0,
            timestamp: new Date(),
        };
    }

    /**
     * Emit login event to monitoring dashboard
     */
    emitLoginEvent(event: LoginEvent): void {
        this.io?.to('super-admin').emit('user:login', event);
    }

    /**
     * Emit institution status change
     */
    emitInstitutionStatusChange(institutionId: string, status: string, name: string): void {
        this.io?.to('super-admin').emit('institution:status', {
            institutionId,
            status,
            name,
            timestamp: new Date(),
        });
    }

    /**
     * Emit error alert
     */
    emitError(error: { message: string; severity: 'low' | 'medium' | 'high' | 'critical' }): void {
        this.io?.to('super-admin').emit('error:alert', {
            ...error,
            timestamp: new Date(),
        });
    }

    /**
     * Cleanup on shutdown
     */
    shutdown(): void {
        if (this.statsInterval) {
            clearInterval(this.statsInterval);
        }
        this.io?.close();
        console.log('[Socket.io] Server shutdown');
    }
}

export const monitoringSocket = new MonitoringSocketServer();
