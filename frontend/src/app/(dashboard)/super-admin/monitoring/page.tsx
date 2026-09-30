'use client';

import { useState, useEffect, useCallback } from 'react';
import { CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
    Activity,
    Database,
    Server,
    Cpu,
    Wifi,
    RefreshCw,
    CheckCircle2,
    TrendingUp,
    Users,
    Building2,
    AlertTriangle,
    XCircle,
    LogIn,
    Zap,
    HardDrive,
    Clock
} from 'lucide-react';
import { toast } from 'sonner';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000/api';
const WS_URL = process.env.NEXT_PUBLIC_WS_URL || 'http://localhost:4000';

interface PlatformStats {
    totalInstitutions: number;
    activeInstitutions: number;
    provisionedDatabases: number;
    totalUsers: number;
    todayLogins: number;
}

interface SystemHealth {
    masterDb: {
        status: 'healthy' | 'degraded' | 'down';
        latency: number;
        connections: number;
    };
    tenantConnections: number;
    uptime: number;
    memory: {
        used: number;
        total: number;
        percentage: number;
    };
    cpu: number;
}

interface LoginEvent {
    id: string;
    email: string;
    institutionName: string;
    role: string;
    timestamp: Date;
    success: boolean;
}

interface ErrorAlert {
    id: string;
    type: string;
    message: string;
    institutionId?: string;
    timestamp: Date;
    severity: 'warning' | 'error' | 'critical';
}

export default function MonitoringPage() {
    const [isLoading, setIsLoading] = useState(true);
    const [isConnected, setIsConnected] = useState(false);
    const [stats, setStats] = useState<PlatformStats>({
        totalInstitutions: 0,
        activeInstitutions: 0,
        provisionedDatabases: 0,
        totalUsers: 0,
        todayLogins: 0,
    });
    const [health, setHealth] = useState<SystemHealth>({
        masterDb: { status: 'healthy', latency: 0, connections: 0 },
        tenantConnections: 0,
        uptime: 0,
        memory: { used: 0, total: 0, percentage: 0 },
        cpu: 0,
    });
    const [loginEvents, setLoginEvents] = useState<LoginEvent[]>([]);
    const [errors, setErrors] = useState<ErrorAlert[]>([]);

    const getAuthToken = () => {
        if (typeof window !== 'undefined') {
            return localStorage.getItem('superAdminToken');
        }
        return null;
    };

    // Mock Fetch
    const fetchStats = useCallback(async () => {
        try {
            await new Promise(resolve => setTimeout(resolve, 800));
            // Mock Data
            setStats({
                totalInstitutions: 12,
                activeInstitutions: 8,
                provisionedDatabases: 8,
                totalUsers: 1450,
                todayLogins: 128,
            });
            setHealth({
                masterDb: { status: 'healthy', latency: 45, connections: 24 },
                tenantConnections: 8,
                uptime: 124500,
                memory: { used: 4096 * 1024 * 1024, total: 8192 * 1024 * 1024, percentage: 50 },
                cpu: 32,
            });
            setIsConnected(true); // Simulate "Live" connection
        } catch (error) {
            console.error('Failed to fetch stats:', error);
        } finally {
            setIsLoading(false);
        }
    }, []);

    // Simulate Real-time Updates
    useEffect(() => {
        fetchStats();

        // Simulate live updates
        const interval = setInterval(() => {
            // Randomize metrics slightly
            setHealth(prev => ({
                ...prev,
                cpu: Math.min(100, Math.max(0, prev.cpu + (Math.random() * 10 - 5))),
                memory: { ...prev.memory, percentage: Math.min(100, Math.max(0, prev.memory.percentage + (Math.random() * 4 - 2))) },
                masterDb: { ...prev.masterDb, latency: Math.max(10, prev.masterDb.latency + (Math.random() * 10 - 5)) }
            }));

            // Random login event
            if (Math.random() > 0.7) {
                const newEvent: LoginEvent = {
                    id: Math.random().toString(),
                    email: `user${Math.floor(Math.random() * 100)}@univ.edu`,
                    institutionName: 'Universal Tech',
                    role: 'INSTITUTION_ADMIN',
                    timestamp: new Date(),
                    success: Math.random() > 0.1
                };
                setLoginEvents(prev => [newEvent, ...prev].slice(0, 10));
            }

        }, 3000);

        return () => {
            clearInterval(interval);
        };
    }, [fetchStats]);

    const formatUptime = (seconds: number) => {
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        return `${hours}h ${minutes}m`;
    };

    const formatTime = (date: Date | string) => {
        const d = new Date(date);
        return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    };

    if (isLoading) {
        return (
            <div className="flex items-center justify-center h-[calc(100vh-200px)]">
                <div className="flex flex-col items-center gap-4">
                    <RefreshCw className="w-10 h-10 text-[#C0EB6A] animate-spin" />
                    <p className="text-[#6B7C6F] animate-pulse">Establishing connection...</p>
                </div>
            </div>
        );
    }

    return (
        <div className="space-y-6">
            {/* Header */}
            <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
                <div>
                    <h2 className="text-2xl font-bold text-[#485550] flex items-center gap-3">
                        <Activity className="w-6 h-6 text-[#C0EB6A]" />
                        System Monitoring
                    </h2>
                    <p className="text-[#6B7C6F]">Real-time health and performance metrics</p>
                </div>
                <div className="flex items-center gap-3 w-full md:w-auto">
                    <div className={`px-4 py-2 rounded-xl border flex items-center gap-2 text-sm font-semibold transition-colors
                        ${isConnected
                            ? 'bg-green-50 text-green-700 border-green-200'
                            : 'bg-amber-50 text-amber-700 border-amber-200'
                        }`}>
                        <Wifi className={`w-4 h-4 ${isConnected ? 'animate-pulse' : ''}`} />
                        {isConnected ? 'Real-time Live' : 'Polling Mode'}
                    </div>
                    <Button
                        variant="outline"
                        onClick={fetchStats}
                        className="btn-morph bg-white hover:bg-[#F4F6F0]"
                    >
                        <RefreshCw className="w-4 h-4 mr-2" />
                        Refresh
                    </Button>
                </div>
            </div>

            {/* Platform Stats */}
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
                <div className="morph-card p-4 flex flex-col items-center justify-center text-center gap-2 group hover:bg-[#F4F6F0] transition-colors">
                    <div className="w-10 h-10 rounded-xl bg-gray-100 flex items-center justify-center group-hover:scale-110 transition-transform">
                        <Building2 className="w-5 h-5 text-[#485550]" />
                    </div>
                    <div>
                        <p className="text-2xl font-bold text-[#485550]">{stats.totalInstitutions}</p>
                        <p className="text-xs text-[#6B7C6F] font-medium uppercase tracking-wide">Total</p>
                    </div>
                </div>

                <div className="morph-card p-4 flex flex-col items-center justify-center text-center gap-2 group hover:bg-[#F4F6F0] transition-colors">
                    <div className="w-10 h-10 rounded-xl bg-green-100 flex items-center justify-center group-hover:scale-110 transition-transform">
                        <CheckCircle2 className="w-5 h-5 text-green-600" />
                    </div>
                    <div>
                        <p className="text-2xl font-bold text-[#485550]">{stats.activeInstitutions}</p>
                        <p className="text-xs text-[#6B7C6F] font-medium uppercase tracking-wide">Active</p>
                    </div>
                </div>

                <div className="morph-card p-4 flex flex-col items-center justify-center text-center gap-2 group hover:bg-[#F4F6F0] transition-colors">
                    <div className="w-10 h-10 rounded-xl bg-blue-100 flex items-center justify-center group-hover:scale-110 transition-transform">
                        <Database className="w-5 h-5 text-blue-600" />
                    </div>
                    <div>
                        <p className="text-2xl font-bold text-[#485550]">{stats.provisionedDatabases}</p>
                        <p className="text-xs text-[#6B7C6F] font-medium uppercase tracking-wide">Databases</p>
                    </div>
                </div>

                <div className="morph-card p-4 flex flex-col items-center justify-center text-center gap-2 group hover:bg-[#F4F6F0] transition-colors">
                    <div className="w-10 h-10 rounded-xl bg-purple-100 flex items-center justify-center group-hover:scale-110 transition-transform">
                        <Users className="w-5 h-5 text-purple-600" />
                    </div>
                    <div>
                        <p className="text-2xl font-bold text-[#485550]">{stats.totalUsers}</p>
                        <p className="text-xs text-[#6B7C6F] font-medium uppercase tracking-wide">Users</p>
                    </div>
                </div>

                <div className="morph-card p-4 flex flex-col items-center justify-center text-center gap-2 group hover:bg-[#F4F6F0] transition-colors">
                    <div className="w-10 h-10 rounded-xl bg-[#C0EB6A]/20 flex items-center justify-center group-hover:scale-110 transition-transform">
                        <LogIn className="w-5 h-5 text-[#485550]" />
                    </div>
                    <div>
                        <p className="text-2xl font-bold text-[#485550]">{stats.todayLogins}</p>
                        <p className="text-xs text-[#6B7C6F] font-medium uppercase tracking-wide">Logins Today</p>
                    </div>
                </div>
            </div>

            {/* System Health Area */}
            <div className="grid lg:grid-cols-2 gap-8">
                <div className="morph-card flex flex-col h-full">
                    <CardHeader>
                        <CardTitle className="text-[#485550] flex items-center gap-2">
                            <Server className="w-5 h-5 text-[#C0EB6A]" />
                            Infrastructure Health
                        </CardTitle>
                        <CardDescription>Server status and resource consumption</CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-6 pt-2">
                        {/* Resource Meters */}
                        <div className="space-y-6">
                            {/* CPU */}
                            <div className="group">
                                <div className="flex items-center justify-between mb-2">
                                    <div className="flex items-center gap-2 text-[#485550] font-medium">
                                        <Cpu className="w-4 h-4 text-blue-500" />
                                        <span>CPU Usage</span>
                                    </div>
                                    <span className="font-bold text-[#485550]">{health.cpu}%</span>
                                </div>
                                <div className="w-full h-4 bg-[#F4F6F0] rounded-full overflow-hidden shadow-inner border border-transparent group-hover:border-[#D1DBC1] transition-all">
                                    <div
                                        className="h-full rounded-full transition-all duration-1000 ease-out shadow-sm"
                                        style={{
                                            width: `${health.cpu}%`,
                                            backgroundColor: health.cpu > 80 ? '#ef4444' : health.cpu > 60 ? '#f59e0b' : '#C0EB6A'
                                        }}
                                    />
                                </div>
                            </div>

                            {/* Memory */}
                            <div className="group">
                                <div className="flex items-center justify-between mb-2">
                                    <div className="flex items-center gap-2 text-[#485550] font-medium">
                                        <HardDrive className="w-4 h-4 text-purple-500" />
                                        <span>Memory Usage</span>
                                    </div>
                                    <div className="text-right">
                                        <span className="font-bold text-[#485550] block">{health.memory.percentage}%</span>
                                    </div>
                                </div>
                                <div className="w-full h-4 bg-[#F4F6F0] rounded-full overflow-hidden shadow-inner border border-transparent group-hover:border-[#D1DBC1] transition-all">
                                    <div
                                        className="h-full rounded-full transition-all duration-1000 ease-out shadow-sm"
                                        style={{
                                            width: `${health.memory.percentage}%`,
                                            backgroundColor: health.memory.percentage > 80 ? '#ef4444' : health.memory.percentage > 60 ? '#f59e0b' : '#C0EB6A'
                                        }}
                                    />
                                </div>
                                <p className="text-xs text-[#6B7C6F] mt-1 text-right">
                                    {Math.round(health.memory.used / 1024 / 1024)}MB used of {Math.round(health.memory.total / 1024 / 1024)}MB
                                </p>
                            </div>
                        </div>

                        {/* Services Grid */}
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-4 border-t border-gray-100">
                            {/* Master DB Status */}
                            <div className="p-4 rounded-2xl bg-[#F4F6F0] border border-transparent hover:border-[#D1DBC1] transition-all">
                                <div className="flex justify-between items-start mb-2">
                                    <div className="flex items-center gap-2 font-medium text-[#485550]">
                                        <Database className="w-4 h-4 text-[#485550]" />
                                        <span>Master DB</span>
                                    </div>
                                    <div className={`w-2.5 h-2.5 rounded-full ${health.masterDb.status === 'healthy' ? 'bg-green-500 animate-pulse' : 'bg-red-500'}`} />
                                </div>
                                <div className="text-xs text-[#6B7C6F] space-y-1">
                                    <p>{health.masterDb.connections} Connections</p>
                                    <p>{health.masterDb.latency}ms Latency</p>
                                </div>
                            </div>

                            {/* Tenant Status */}
                            <div className="p-4 rounded-2xl bg-[#F4F6F0] border border-transparent hover:border-[#D1DBC1] transition-all">
                                <div className="flex justify-between items-start mb-2">
                                    <div className="flex items-center gap-2 font-medium text-[#485550]">
                                        <Building2 className="w-4 h-4 text-[#485550]" />
                                        <span>Tenant Pools</span>
                                    </div>
                                    <span className="text-lg font-bold text-[#485550] leading-none">{health.tenantConnections}</span>
                                </div>
                                <div className="text-xs text-[#6B7C6F]">
                                    Active Database Pools
                                </div>
                            </div>
                        </div>
                    </CardContent>
                </div>

                {/* Activity Feed */}
                <div className="space-y-6">
                    {/* Recent Logins */}
                    <div className="morph-card flex flex-col max-h-[400px]">
                        <CardHeader className="border-b border-gray-100 py-4">
                            <CardTitle className="text-base font-bold text-[#485550] flex items-center gap-2">
                                <LogIn className="w-4 h-4 text-[#C0EB6A]" />
                                Live Login Activity
                            </CardTitle>
                        </CardHeader>
                        <CardContent className="overflow-y-auto pt-0 px-2">
                            {loginEvents.length > 0 ? (
                                <div className="divide-y divide-gray-100">
                                    {loginEvents.map((event, index) => (
                                        <div key={event.id || index} className="p-3 hover:bg-[#F4F6F0] rounded-xl transition-colors flex items-center justify-between group">
                                            <div className="flex items-center gap-3">
                                                <div className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${event.success ? 'bg-green-100 text-green-600' : 'bg-red-100 text-red-600'}`}>
                                                    {event.success ? <CheckCircle2 className="w-4 h-4" /> : <XCircle className="w-4 h-4" />}
                                                </div>
                                                <div>
                                                    <p className="text-sm font-semibold text-[#485550]">{event.email}</p>
                                                    <p className="text-xs text-[#6B7C6F]">{event.institutionName}</p>
                                                </div>
                                            </div>
                                            <div className="text-right">
                                                <Badge variant="secondary" className="text-[10px] bg-[#E8EDE0] text-[#485550]">{event.role}</Badge>
                                                <p className="text-[10px] text-gray-400 mt-1">{formatTime(event.timestamp)}</p>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            ) : (
                                <div className="text-center py-12 text-[#6B7C6F] opacity-70">
                                    <p>Waiting for login events...</p>
                                </div>
                            )}
                        </CardContent>
                    </div>

                    {/* Error Alerts */}
                    <div className="morph-card flex flex-col max-h-[300px]">
                        <CardHeader className="border-b border-gray-100 py-4">
                            <CardTitle className="text-base font-bold text-[#485550] flex items-center gap-2">
                                <AlertTriangle className="w-4 h-4 text-amber-500" />
                                System Alerts
                            </CardTitle>
                        </CardHeader>
                        <CardContent className="overflow-y-auto pt-0 px-2">
                            {errors.length > 0 ? (
                                <div className="space-y-2 py-2">
                                    {errors.map((error, index) => (
                                        <div
                                            key={error.id || index}
                                            className={`p-3 rounded-xl border flex items-start justify-between gap-3 ${error.severity === 'critical' ? 'bg-red-50 border-red-100' :
                                                error.severity === 'error' ? 'bg-orange-50 border-orange-100' :
                                                    'bg-amber-50 border-amber-100'
                                                }`}
                                        >
                                            <div>
                                                <div className="flex items-center gap-2 mb-1">
                                                    <Badge className={`h-5 px-1.5 text-[10px] ${error.severity === 'critical' ? 'bg-red-500 hover:bg-red-600' :
                                                        error.severity === 'error' ? 'bg-orange-500 hover:bg-orange-600' :
                                                            'bg-amber-500 hover:bg-amber-600'
                                                        }`}>
                                                        {error.severity.toUpperCase()}
                                                    </Badge>
                                                    <span className="text-xs font-bold text-[#485550]">{error.type}</span>
                                                </div>
                                                <p className="text-xs text-[#485550] leading-snug">{error.message}</p>
                                            </div>
                                            <span className="text-[10px] text-[#6B7C6F] whitespace-nowrap">{formatTime(error.timestamp)}</span>
                                        </div>
                                    ))}
                                </div>
                            ) : (
                                <div className="text-center py-10 text-green-600/70 flex flex-col items-center">
                                    <CheckCircle2 className="w-8 h-8 mb-2" />
                                    <p className="text-sm font-medium">All systems normal</p>
                                </div>
                            )}
                        </CardContent>
                    </div>
                </div>
            </div>
        </div>
    );
}
