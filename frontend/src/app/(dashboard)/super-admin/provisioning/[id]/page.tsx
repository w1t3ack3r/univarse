'use client';

import { useState, useEffect, use } from 'react';
import { CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
    Database,
    RefreshCw,
    CheckCircle2,
    Clock,
    Play,
    ArrowRight,
    Server,
    Loader2,
    HardDrive,
    Terminal,
    Shield,
    Globe,
    Mail,
    AlertTriangle,
    RotateCcw,
    FileText,
    Download
} from 'lucide-react';
import { toast } from 'sonner';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

// Mock Data Types
interface LogEntry {
    timestamp: string;
    level: 'INFO' | 'WARN' | 'ERROR' | 'SUCCESS';
    message: string;
}

export default function ProvisioningDetailsPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = use(params);
    const [isLoading, setIsLoading] = useState(true);
    const [activeTab, setActiveTab] = useState('overview');
    const [logs, setLogs] = useState<LogEntry[]>([]);
    const [isProvisioning, setIsProvisioning] = useState(false);

    // Mock specific institution data
    /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
    const [institution, setInstitution] = useState<any>(null);

    useEffect(() => {
        // Mock fetch
        setTimeout(() => {
            setInstitution({
                id,
                name: 'Universal Tech Institute',
                code: 'UNIV',
                subdomain: 'universal',
                status: 'PROVISIONED',
                adminEmail: 'admin@universal.edu',
                plan: 'Enterprise',
                passwordStatus: 'TEMPORARY', // Mock status
                database: {
                    host: 'db-cluster-01.univarse.internal',
                    port: 5432,
                    name: 'univarse_universal_db',
                    user: 'univ_admin',
                    size: '2.4 GB',
                    version: 'PostgreSQL 15.4',
                    lastBackup: '2024-03-10T02:00:00Z'
                },
                createdAt: '2023-09-15T10:30:00Z'
            });
            setLogs([
                { timestamp: '2024-03-10 10:30:01', level: 'INFO', message: 'Initializing provisioning sequence for tenant: universal' },
                { timestamp: '2024-03-10 10:30:05', level: 'SUCCESS', message: 'Tenant record created in main registry.' },
                { timestamp: '2024-03-10 10:30:12', level: 'INFO', message: 'Allocating database resources on Cluster-01' },
                { timestamp: '2024-03-10 10:30:45', level: 'SUCCESS', message: 'Database univarse_universal_db created.' },
                { timestamp: '2024-03-10 10:31:00', level: 'INFO', message: 'Running initial migrations (Schema v2.4)...' },
                { timestamp: '2024-03-10 10:32:15', level: 'SUCCESS', message: 'Migrations completed successfully.' },
                { timestamp: '2024-03-10 10:32:20', level: 'INFO', message: 'Seeding default admin account' },
                { timestamp: '2024-03-10 10:32:25', level: 'SUCCESS', message: 'Provisioning completed successfully.' },
            ]);
            setIsLoading(false);
        }, 800);
    }, [id]);

    const handleRetry = async () => {
        setIsProvisioning(true);
        setLogs(prev => [...prev, { timestamp: new Date().toISOString().replace('T', ' ').split('.')[0], level: 'INFO', message: 'Manual provisioning retry initiated...' }]);

        await new Promise(resolve => setTimeout(resolve, 2000));

        setLogs(prev => [...prev, { timestamp: new Date().toISOString().replace('T', ' ').split('.')[0], level: 'SUCCESS', message: 'Retry sequence completed.' }]);
        setIsProvisioning(false);
        toast.success('Provisioning retry completed');
    };

    if (isLoading) {
        return (
            <div className="flex items-center justify-center h-[calc(100vh-200px)]">
                <Loader2 className="w-10 h-10 text-[#C0EB6A] animate-spin" />
            </div>
        );
    }

    return (
        <div className="space-y-8">
            {/* Header */}
            <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
                <div>
                    <div className="flex items-center gap-2 mb-1">
                        <Badge className="bg-green-100 text-green-700 hover:bg-green-200 border-0">
                            {institution.status}
                        </Badge>
                        <span className="text-sm text-[#6B7C6F] font-mono">ID: {institution.id}</span>
                    </div>
                    <h2 className="text-3xl font-bold text-[#485550]">{institution.name}</h2>
                    <p className="text-[#6B7C6F]">Provisioning & Infrastructure Setup</p>
                </div>

                <div className="flex gap-3">
                    <Button variant="outline" className="border-red-200 text-red-600 hover:bg-red-50">
                        <RotateCcw className="w-4 h-4 mr-2" />
                        Rollback
                    </Button>
                    <Button onClick={handleRetry} disabled={isProvisioning} className="btn-morph-primary">
                        {isProvisioning ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <RefreshCw className="w-4 h-4 mr-2" />}
                        Retry Provisioning
                    </Button>
                </div>
            </div>

            {/* Core Metrics */}
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                <div className="morph-card p-4 flex flex-col justify-center">
                    <span className="text-xs text-[#6B7C6F] font-medium uppercase tracking-wider">Database Name</span>
                    <div className="text-lg font-bold text-[#485550] mt-1 flex items-center gap-2">
                        <Database className="w-4 h-4 text-blue-500" />
                        {institution.database.name}
                    </div>
                </div>
                <div className="morph-card p-4 flex flex-col justify-center">
                    <span className="text-xs text-[#6B7C6F] font-medium uppercase tracking-wider">Host</span>
                    <div className="text-lg font-bold text-[#485550] mt-1 flex items-center gap-2">
                        <Server className="w-4 h-4 text-amber-500" />
                        {institution.database.host}
                    </div>
                </div>
                <div className="morph-card p-4 flex flex-col justify-center">
                    <span className="text-xs text-[#6B7C6F] font-medium uppercase tracking-wider">DB Size</span>
                    <div className="text-lg font-bold text-[#485550] mt-1 flex items-center gap-2">
                        <HardDrive className="w-4 h-4 text-purple-500" />
                        {institution.database.size}
                    </div>
                </div>
                <div className="morph-card p-4 flex flex-col justify-center">
                    <span className="text-xs text-[#6B7C6F] font-medium uppercase tracking-wider">Subdomain</span>
                    <div className="text-lg font-bold text-[#485550] mt-1 flex items-center gap-2">
                        <Globe className="w-4 h-4 text-green-500" />
                        {institution.subdomain}.univarse.com
                    </div>
                </div>
            </div>

            <Tabs defaultValue="overview" value={activeTab} onValueChange={setActiveTab} className="space-y-6">
                <TabsList className="bg-transparent p-0 gap-6 border-b border-[#D1DBC1] w-full justify-start rounded-none h-auto">
                    <TabsTrigger value="overview" className="tab-trigger">
                        <Server className="w-4 h-4 mr-2" />
                        Configuration
                    </TabsTrigger>
                    <TabsTrigger value="logs" className="tab-trigger">
                        <Terminal className="w-4 h-4 mr-2" />
                        Live Logs
                    </TabsTrigger>
                    <TabsTrigger value="backups" className="tab-trigger">
                        <RotateCcw className="w-4 h-4 mr-2" />
                        Backups & Snapshots
                    </TabsTrigger>
                </TabsList>

                <TabsContent value="overview" className="space-y-6 animate-in slide-in-from-bottom-2 duration-300">
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                        {/* Tenant Details */}
                        <div className="morph-card p-6">
                            <h3 className="text-lg font-bold text-[#485550] mb-4 flex items-center gap-2">
                                <Shield className="w-5 h-5 text-[#C0EB6A]" />
                                Tenant Configuration
                            </h3>
                            <div className="space-y-4">
                                <div className="grid grid-cols-3 gap-4 pb-4 border-b border-[#F4F6F0]">
                                    <span className="text-sm text-[#6B7C6F]">Admin Email</span>
                                    <span className="col-span-2 text-sm font-medium text-[#485550]">{institution.adminEmail}</span>
                                </div>
                                <div className="grid grid-cols-3 gap-4 pb-4 border-b border-[#F4F6F0]">
                                    <span className="text-sm text-[#6B7C6F]">Subscription Plan</span>
                                    <span className="col-span-2 text-sm font-medium text-[#485550]">{institution.plan}</span>
                                </div>
                                <div className="grid grid-cols-3 gap-4 pb-4 border-b border-[#F4F6F0]">
                                    <span className="text-sm text-[#6B7C6F]">Created At</span>
                                    <span className="col-span-2 text-sm font-medium text-[#485550]">{new Date(institution.createdAt).toLocaleString()}</span>
                                </div>
                                <div className="grid grid-cols-3 gap-4 pb-4 border-b border-[#F4F6F0]">
                                    <span className="text-sm text-[#6B7C6F]">Password Status</span>
                                    <span className="col-span-2">
                                        {institution.passwordStatus === 'TEMPORARY' ? (
                                            <Badge variant="outline" className="bg-amber-50 text-amber-600 border-amber-200 flex w-fit gap-1">
                                                <AlertTriangle className="w-3 h-3" /> Temporary
                                            </Badge>
                                        ) : (
                                            <Badge variant="outline" className="bg-green-50 text-green-600 border-green-200 flex w-fit gap-1">
                                                <CheckCircle2 className="w-3 h-3" /> Secure
                                            </Badge>
                                        )}
                                    </span>
                                </div>
                                <div className="grid grid-cols-3 gap-4">
                                    <span className="text-sm text-[#6B7C6F]">Institution Code</span>
                                    <span className="col-span-2 text-sm font-medium text-[#485550]">{institution.code}</span>
                                </div>
                            </div>
                        </div>

                        {/* Database Details */}
                        <div className="morph-card p-6">
                            <h3 className="text-lg font-bold text-[#485550] mb-4 flex items-center gap-2">
                                <Database className="w-5 h-5 text-blue-500" />
                                Connection Details
                            </h3>
                            <div className="bg-[#2A302D] rounded-xl p-4 font-mono text-sm text-[#E8EDE0] space-y-2 overflow-x-auto">
                                <div className="flex gap-4">
                                    <span className="text-[#6B7C6F] w-24">DB_HOST:</span>
                                    <span>{institution.database.host}</span>
                                </div>
                                <div className="flex gap-4">
                                    <span className="text-[#6B7C6F] w-24">DB_PORT:</span>
                                    <span>{institution.database.port}</span>
                                </div>
                                <div className="flex gap-4">
                                    <span className="text-[#6B7C6F] w-24">DB_NAME:</span>
                                    <span>{institution.database.name}</span>
                                </div>
                                <div className="flex gap-4">
                                    <span className="text-[#6B7C6F] w-24">DB_USER:</span>
                                    <span>{institution.database.user}</span>
                                </div>
                                <div className="flex gap-4">
                                    <span className="text-[#6B7C6F] w-24">DB_VERSION:</span>
                                    <span>{institution.database.version}</span>
                                </div>
                            </div>
                            <div className="mt-4 flex items-start gap-3 p-3 bg-amber-50 text-amber-700 rounded-lg text-sm">
                                <AlertTriangle className="w-5 h-5 shrink-0" />
                                <p>These credentials are for internal super-admin use only. Do not share with tenant administrators.</p>
                            </div>
                        </div>
                    </div>
                </TabsContent>

                <TabsContent value="logs" className="space-y-6 animate-in slide-in-from-bottom-2 duration-300">
                    <div className="morph-card bg-[#1E1E1E] border-[#2A302D] overflow-hidden flex flex-col h-[500px]">
                        <div className="flex items-center justify-between px-4 py-2 bg-[#252526] border-b border-[#333]">
                            <span className="text-xs text-[#9CA3AF] font-mono">provisioning.log</span>
                            <div className="flex gap-2">
                                <Button size="sm" variant="ghost" className="h-6 text-[#9CA3AF] hover:text-white hover:bg-[#333]">
                                    <Download className="w-3 h-3 mr-1" /> Raw
                                </Button>
                            </div>
                        </div>
                        <div className="flex-1 overflow-y-auto p-4 font-mono text-sm space-y-1">
                            {logs.map((log, i) => (
                                <div key={i} className="flex gap-3">
                                    <span className="text-gray-500 select-none">{log.timestamp}</span>
                                    <span className={
                                        log.level === 'INFO' ? 'text-blue-400' :
                                            log.level === 'SUCCESS' ? 'text-green-400' :
                                                log.level === 'WARN' ? 'text-amber-400' :
                                                    'text-red-400'
                                    }>[{log.level}]</span>
                                    <span className="text-gray-300">{log.message}</span>
                                </div>
                            ))}
                            {isProvisioning && (
                                <div className="flex gap-3 animate-pulse">
                                    <span className="text-gray-500 select-none">...</span>
                                    <span className="text-blue-400">[RUNNING]</span>
                                    <span className="text-gray-300">_</span>
                                </div>
                            )}
                        </div>
                    </div>
                </TabsContent>

                <TabsContent value="backups" className="space-y-6 animate-in slide-in-from-bottom-2 duration-300">
                    <div className="morph-card p-10 flex flex-col items-center justify-center text-center">
                        <div className="w-16 h-16 bg-[#F4F6F0] rounded-full flex items-center justify-center mb-4">
                            <RotateCcw className="w-8 h-8 text-[#D1DBC1]" />
                        </div>
                        <h3 className="text-xl font-bold text-[#485550]">Automated Backup Policy</h3>
                        <p className="text-[#6B7C6F] max-w-md mx-auto mt-2">
                            Daily backups are enabled and stored in S3 Glacier.
                            Last backup was successfully completed at <b>{new Date(institution.database.lastBackup).toLocaleString()}</b>.
                        </p>
                        <Button className="btn-morph-primary mt-6">
                            Manage Backup Policy
                        </Button>
                    </div>
                </TabsContent>
            </Tabs>
        </div>
    );
}
