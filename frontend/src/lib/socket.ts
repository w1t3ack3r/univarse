// Socket.io Client for Real-Time Monitoring
// Connects to auth-service WebSocket for live updates

import { io, Socket } from 'socket.io-client';

interface PlatformStats {
    totalInstitutions: number;
    activeInstitutions: number;
    suspendedInstitutions: number;
    pendingDeletion: number;
    totalConnections: number;
    timestamp: Date;
}

interface SystemHealth {
    status: 'healthy' | 'degraded' | 'unhealthy';
    uptime: number;
    memoryUsage: {
        heapUsed: number;
        heapTotal: number;
        rss: number;
    };
    activeConnections: number;
    timestamp: Date;
}

interface LoginEvent {
    institutionId: string;
    institutionName: string;
    userEmail: string;
    role: string;
    timestamp: Date;
}

interface InstitutionStatusEvent {
    institutionId: string;
    status: string;
    name: string;
    timestamp: Date;
}

interface ErrorAlert {
    message: string;
    severity: 'low' | 'medium' | 'high' | 'critical';
    timestamp: Date;
}

type SocketEventHandlers = {
    onStatsUpdate?: (stats: PlatformStats) => void;
    onHealthUpdate?: (health: SystemHealth) => void;
    onLoginEvent?: (event: LoginEvent) => void;
    onInstitutionStatus?: (event: InstitutionStatusEvent) => void;
    onError?: (error: ErrorAlert) => void;
    onConnect?: () => void;
    onDisconnect?: () => void;
};

class MonitoringSocketClient {
    private socket: Socket | null = null;
    private handlers: SocketEventHandlers = {};

    /**
     * Connect to the monitoring WebSocket server
     */
    connect(accessToken?: string): void {
        if (this.socket?.connected) {
            return;
        }

        const socketUrl = process.env.NEXT_PUBLIC_API_URL?.replace('/api/v1', '') || 'http://localhost:4000';

        this.socket = io(socketUrl, {
            path: '/socket.io',
            transports: ['websocket', 'polling'],
            auth: accessToken ? { token: accessToken } : undefined,
        });

        this.socket.on('connect', () => {
            console.log('[Socket.io] Connected to monitoring server');
            this.handlers.onConnect?.();

            // Authenticate as super admin
            if (accessToken) {
                this.socket?.emit('authenticate', accessToken);
            }
        });

        this.socket.on('disconnect', () => {
            console.log('[Socket.io] Disconnected from monitoring server');
            this.handlers.onDisconnect?.();
        });

        // Platform stats updates
        this.socket.on('stats:initial', (stats: PlatformStats) => {
            this.handlers.onStatsUpdate?.(stats);
        });

        this.socket.on('stats:update', (stats: PlatformStats) => {
            this.handlers.onStatsUpdate?.(stats);
        });

        // System health updates
        this.socket.on('health:update', (health: SystemHealth) => {
            this.handlers.onHealthUpdate?.(health);
        });

        // Login events
        this.socket.on('user:login', (event: LoginEvent) => {
            this.handlers.onLoginEvent?.(event);
        });

        // Institution status changes
        this.socket.on('institution:status', (event: InstitutionStatusEvent) => {
            this.handlers.onInstitutionStatus?.(event);
        });

        // Error alerts
        this.socket.on('error:alert', (error: ErrorAlert) => {
            this.handlers.onError?.(error);
        });
    }

    /**
     * Set event handlers
     */
    setHandlers(handlers: SocketEventHandlers): void {
        this.handlers = { ...this.handlers, ...handlers };
    }

    /**
     * Check if connected
     */
    isConnected(): boolean {
        return this.socket?.connected ?? false;
    }

    /**
     * Disconnect from server
     */
    disconnect(): void {
        this.socket?.disconnect();
        this.socket = null;
    }
}

// Singleton instance
export const monitoringSocket = new MonitoringSocketClient();

// Export types
export type { PlatformStats, SystemHealth, LoginEvent, InstitutionStatusEvent, ErrorAlert };
