'use client';

import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
    Activity,
    Server,
    RefreshCw,
    Database,
    Zap,
    Clock,
    AlertTriangle,
    HardDrive,
    Trash2,
    RotateCcw,
    Loader2
} from 'lucide-react';
import { toast } from 'sonner';
import { MorphCard } from '@/components/morph/MorphCard';
import { MorphButton } from '@/components/morph/MorphButton';

// Types
type ServiceStatus = 'OPERATIONAL' | 'DEGRADED' | 'DOWN' | 'MAINTENANCE';

interface SystemService {
    id: string;
    name: string;
    status: ServiceStatus;
    uptime: string;
    lastRestart: string;
    icon: any;
}

const statusColors: Record<ServiceStatus, string> = {
    OPERATIONAL: 'bg-green-100 text-green-700 border-green-200',
    DEGRADED: 'bg-amber-100 text-amber-700 border-amber-200',
    DOWN: 'bg-red-100 text-red-700 border-red-200',
    MAINTENANCE: 'bg-blue-100 text-blue-700 border-blue-200',
};

export default function MaintenancePage() {
    const [isLoading, setIsLoading] = useState(true);
    const [clearingCache, setClearingCache] = useState<string | null>(null);
    const [restartingService, setRestartingService] = useState<string | null>(null);

    // Mock Data
    const [services, setServices] = useState<SystemService[]>([
        { id: 'srv-1', name: 'Email Worker', status: 'OPERATIONAL', uptime: '14d 2h', lastRestart: '2 weeks ago', icon: Activity },
        { id: 'srv-2', name: 'Analytics Engine', status: 'OPERATIONAL', uptime: '45d 12h', lastRestart: '1 month ago', icon: Zap },
        { id: 'srv-3', name: 'Database Pool', status: 'OPERATIONAL', uptime: '120d 4h', lastRestart: '4 months ago', icon: Database },
        { id: 'srv-4', name: 'Search Indexer', status: 'DEGRADED', uptime: '2d 4h', lastRestart: '2 days ago', icon: RefreshCw },
        { id: 'srv-5', name: 'Backup Job', status: 'OPERATIONAL', uptime: '23h 10m', lastRestart: 'Yesterday', icon: HardDrive },
    ]);

    useEffect(() => {
        // Simulate initial fetch
        const timer = setTimeout(() => {
            setIsLoading(false);
        }, 1000);
        return () => clearTimeout(timer);
    }, []);

    const handleClearCache = async (type: string) => {
        setClearingCache(type);
        // Mock delay
        await new Promise(resolve => setTimeout(resolve, 2000));

        toast.success(`${type} cleared successfully`, {
            description: 'Performance may be temporarily impacted while cache rebuilds.'
        });
        setClearingCache(null);
    };

    const handleRestartService = async (serviceId: string) => {
        setRestartingService(serviceId);
        // Mock delay
        await new Promise(resolve => setTimeout(resolve, 3000));

        setServices(prev => prev.map(srv =>
            srv.id === serviceId
                ? { ...srv, status: 'OPERATIONAL', uptime: '0s', lastRestart: 'Just now' }
                : srv
        ));

        toast.success('Service Restarted', {
            description: 'The service has been successfully rebooted and is now operational.'
        });
        setRestartingService(null);
    };

    if (isLoading) {
        return (
            <div className="flex items-center justify-center h-[calc(100vh-200px)]">
                <div className="flex flex-col items-center gap-4">
                    <Loader2 className="w-10 h-10 text-[#C0EB6A] animate-spin" />
                    <p className="text-[#6B7C6F] animate-pulse">Scanning system services...</p>
                </div>
            </div>
        );
    }

    return (
        <div className="space-y-8 max-w-7xl mx-auto pb-10">
            {/* Header */}
            <div>
                <h2 className="text-2xl font-bold text-[#485550]">System Maintenance</h2>
                <p className="text-[#6B7C6F]">Manage system performance, caches, and background services.</p>
            </div>

            {/* Cache Control Section */}
            <section className="space-y-4">
                <div className="flex items-center gap-2 mb-4">
                    <div className="p-2 bg-[#F4F6F0] rounded-lg">
                        <Database className="w-5 h-5 text-[#485550]" />
                    </div>
                    <h3 className="text-lg font-bold text-[#485550]">Cache Control</h3>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                    <MorphCard className="flex flex-col justify-between h-full bg-white group hover:border-[#C0EB6A] transition-colors">
                        <div className="space-y-3">
                            <div className="w-10 h-10 rounded-full bg-orange-50 flex items-center justify-center group-hover:scale-110 transition-transform">
                                <Zap className="w-5 h-5 text-orange-500" />
                            </div>
                            <div>
                                <h4 className="font-bold text-[#485550]">Application Cache</h4>
                                <p className="text-sm text-[#6B7C6F] mt-1">Clears compiled assets and verification tokens.</p>
                            </div>
                        </div>
                        <MorphButton
                            className="w-full mt-6 bg-orange-50 text-orange-700 hover:bg-orange-100 border border-orange-200"
                            onClick={() => handleClearCache('Application Cache')}
                            disabled={!!clearingCache}
                        >
                            {clearingCache === 'Application Cache' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4 mr-2" />}
                            Clear App Cache
                        </MorphButton>
                    </MorphCard>

                    <MorphCard className="flex flex-col justify-between h-full bg-white group hover:border-[#C0EB6A] transition-colors">
                        <div className="space-y-3">
                            <div className="w-10 h-10 rounded-full bg-blue-50 flex items-center justify-center group-hover:scale-110 transition-transform">
                                <Database className="w-5 h-5 text-blue-500" />
                            </div>
                            <div>
                                <h4 className="font-bold text-[#485550]">Redis Cache</h4>
                                <p className="text-sm text-[#6B7C6F] mt-1">Flushes the entire Redis instance. Users may need to re-login.</p>
                            </div>
                        </div>
                        <MorphButton
                            className="w-full mt-6 bg-blue-50 text-blue-700 hover:bg-blue-100 border border-blue-200"
                            onClick={() => handleClearCache('Redis Cache')}
                            disabled={!!clearingCache}
                        >
                            {clearingCache === 'Redis Cache' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4 mr-2" />}
                            Flush Redis
                        </MorphButton>
                    </MorphCard>

                    <MorphCard className="flex flex-col justify-between h-full bg-white group hover:border-[#C0EB6A] transition-colors">
                        <div className="space-y-3">
                            <div className="w-10 h-10 rounded-full bg-purple-50 flex items-center justify-center group-hover:scale-110 transition-transform">
                                <Activity className="w-5 h-5 text-purple-500" />
                            </div>
                            <div>
                                <h4 className="font-bold text-[#485550]">CDN Cache</h4>
                                <p className="text-sm text-[#6B7C6F] mt-1">Purges static assets distributed via the CDN edge locations.</p>
                            </div>
                        </div>
                        <MorphButton
                            className="w-full mt-6 bg-purple-50 text-purple-700 hover:bg-purple-100 border border-purple-200"
                            onClick={() => handleClearCache('CDN Cache')}
                            disabled={!!clearingCache}
                        >
                            {/* Purge is usually slower */}
                            {clearingCache === 'CDN Cache' ? <Loader2 className="w-4 h-4 animate-spin" /> : <RotateCcw className="w-4 h-4 mr-2" />}
                            Purge CDN
                        </MorphButton>
                    </MorphCard>
                </div>
            </section>

            {/* Service Health Section */}
            <section className="space-y-4">
                <div className="flex items-center gap-2 mb-4 pt-4 border-t border-[#F4F6F0]">
                    <div className="p-2 bg-[#F4F6F0] rounded-lg">
                        <Server className="w-5 h-5 text-[#485550]" />
                    </div>
                    <h3 className="text-lg font-bold text-[#485550]">System Services</h3>
                </div>

                <div className="grid gap-4">
                    {services.map((service) => (
                        <div
                            key={service.id}
                            className="group p-5 rounded-2xl bg-white border border-[#F4F6F0] hover:border-[#D1DBC1] hover:shadow-md transition-all duration-300 flex flex-col md:flex-row md:items-center justify-between gap-4"
                        >
                            <div className="flex items-center gap-4">
                                <div className={`w-12 h-12 rounded-xl flex items-center justify-center ${service.status === 'OPERATIONAL' ? 'bg-green-50 text-green-600' : 'bg-amber-50 text-amber-600'}`}>
                                    <service.icon className="w-6 h-6" />
                                </div>
                                <div>
                                    <h4 className="font-bold text-[#485550]">{service.name}</h4>
                                    <div className="flex items-center gap-3 text-sm text-[#6B7C6F] mt-1">
                                        <span className="flex items-center gap-1">
                                            <Clock className="w-3 h-3" />
                                            Uptime: {service.uptime}
                                        </span>
                                        <span className="w-1 h-1 rounded-full bg-[#D1DBC1]" />
                                        <span>Last restart: {service.lastRestart}</span>
                                    </div>
                                </div>
                            </div>

                            <div className="flex items-center gap-4 pl-16 md:pl-0">
                                <Badge className={`border ${statusColors[service.status]}`}>
                                    {service.status}
                                </Badge>

                                <MorphButton
                                    size="sm"
                                    variant="outline"
                                    className="bg-white hover:bg-gray-50 text-gray-700"
                                    onClick={() => handleRestartService(service.id)}
                                    disabled={!!restartingService || service.status === 'MAINTENANCE'}
                                >
                                    {restartingService === service.id ? (
                                        <Loader2 className="w-4 h-4 animate-spin text-[#485550]" />
                                    ) : (
                                        <RotateCcw className="w-4 h-4 text-[#485550]" />
                                    )}
                                    <span className="ml-2">Restart</span>
                                </MorphButton>
                            </div>
                        </div>
                    ))}
                </div>
            </section>
        </div>
    );
}
