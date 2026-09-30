'use client';

import { useState, useEffect } from 'react';
import { CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
    Building2,
    Users,
    Database,
    Activity,
    CheckCircle2,
    Clock,
    ArrowRight,
    Server,
    Plus,
    RefreshCw,
    MoreHorizontal,
    Globe,
    Zap
} from 'lucide-react';
import Link from 'next/link';
// import { api } from '@/lib/api';
import { toast } from 'sonner';

interface Stats {
    totalInstitutions: number;
    activeInstitutions: number;
    provisionedInstitutions: number;
    totalAdmins: number;
    connectionStats: { totalConnections: number };
}

interface Institution {
    id: string;
    code: string;
    name: string;
    subdomain: string;
    isActive: boolean;
    isProvisioned: boolean;
}

interface AuditLog {
    id: string;
    action: string;
    description: string;
    createdAt: string;
    institutionId?: string;
}

export default function SuperAdminDashboard() {
    const [isLoading, setIsLoading] = useState(true);
    const [stats, setStats] = useState<Stats | null>(null);
    const [institutions, setInstitutions] = useState<Institution[]>([]);
    const [recentActivity, setRecentActivity] = useState<AuditLog[]>([]);

    const fetchDashboardData = async () => {
        setIsLoading(true);
        // MOCK DATA FETCH
        try {
            await new Promise(resolve => setTimeout(resolve, 800)); // Simulate network

            setStats({
                totalInstitutions: 24,
                activeInstitutions: 18,
                provisionedInstitutions: 15,
                totalAdmins: 42,
                connectionStats: { totalConnections: 156 }
            });

            setInstitutions([
                { id: '1', code: 'UNIV', name: 'Universal Tech Institute', subdomain: 'universal', isActive: true, isProvisioned: true },
                { id: '2', code: 'CYBER', name: 'Cyber Academy', subdomain: 'cyber', isActive: true, isProvisioned: true },
                { id: '3', code: 'NEXT', name: 'NextGen Learning', subdomain: 'nextgen', isActive: true, isProvisioned: false },
                { id: '4', code: 'GLOBAL', name: 'Global School of Arts', subdomain: 'global', isActive: false, isProvisioned: false },
                { id: '5', code: 'IRON', name: 'Ironclad Logistics', subdomain: 'ironclad', isActive: true, isProvisioned: true },
            ]);

            setRecentActivity([
                { id: '1', action: 'INSTITUTION_PROVISION', description: 'Provisioned database for Cyber Academy', createdAt: new Date(Date.now() - 1000 * 60 * 5).toISOString() },
                { id: '2', action: 'SYSTEM_BACKUP', description: 'Automated system backup completed', createdAt: new Date(Date.now() - 1000 * 60 * 60).toISOString() },
                { id: '3', action: 'ADMIN_LOGIN', description: 'Super Admin login detected', createdAt: new Date(Date.now() - 1000 * 60 * 120).toISOString() },
                { id: '4', action: 'INSTITUTION_CREATE', description: 'Registered new institution: NextGen Learning', createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24).toISOString() },
            ]);
        } catch (error: any) {
            toast.error('Failed to load dashboard data (Mock Mode)');
        } finally {
            setIsLoading(false);
        }
    };

    useEffect(() => {
        fetchDashboardData();
    }, []);

    const getStatusColor = (isActive: boolean, isProvisioned: boolean) => {
        if (!isProvisioned) return 'bg-amber-100/50 text-amber-700 border-amber-200';
        if (isActive) return 'bg-green-100/50 text-green-700 border-green-200';
        return 'bg-gray-100/50 text-gray-700 border-gray-200';
    };

    const getActivityIcon = (action: string) => {
        if (action.includes('INSTITUTION') || action.includes('PROVISION')) {
            return <Building2 className="w-5 h-5 text-[#485550]" />;
        }
        if (action.includes('SEED') || action.includes('SYSTEM')) {
            return <Server className="w-5 h-5 text-[#C0EB6A]" />;
        }
        return <Activity className="w-5 h-5 text-gray-400" />;
    };

    if (isLoading) {
        return (
            <div className="flex items-center justify-center h-[calc(100vh-200px)]">
                <div className="flex flex-col items-center gap-4">
                    <div className="relative w-16 h-16">
                        <div className="absolute inset-0 rounded-full border-4 border-[#E8EDE0]"></div>
                        <div className="absolute inset-0 rounded-full border-4 border-[#C0EB6A] border-t-transparent animate-spin"></div>
                    </div>
                    <p className="text-[#6B7C6F] animate-pulse">Loading ecosystem data...</p>
                </div>
            </div>
        );
    }

    return (
        <div className="space-y-8">
            {/* Action Bar */}
            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 bg-white/50 backdrop-blur-sm p-4 rounded-2xl border border-white/60 shadow-sm">
                <div>
                    <h2 className="text-lg font-semibold text-[#485550]">Quick Actions</h2>
                    <p className="text-xs text-[#6B7C6F]">Manage your platform efficiently</p>
                </div>
                <div className="flex gap-3 w-full sm:w-auto">
                    <Button variant="outline" className="flex-1 sm:flex-none border-[#D1DBC1] text-[#485550] hover:bg-[#F4F6F0] rounded-xl cursor-pointer" onClick={fetchDashboardData}>
                        <RefreshCw className="w-4 h-4 mr-2" />
                        Refresh
                    </Button>
                    <Link href="/super-admin/institutions" className="flex-1 sm:flex-none">
                        <Button className="w-full bg-[#485550] hover:bg-[#3d4744] text-white rounded-xl shadow-[4px_4px_10px_#b0c492,-4px_-4px_10px_#ffffff] hover:translate-y-[-2px] transition-all cursor-pointer">
                            <Plus className="w-4 h-4 mr-2" />
                            Add Institution
                        </Button>
                    </Link>
                </div>
            </div>

            {/* Stats Grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
                {/* Total Institutions */}
                <div className="morph-card p-6 relative overflow-hidden group">
                    <div className="absolute right-0 top-0 w-32 h-32 bg-blue-500/10 rounded-full blur-3xl -mr-10 -mt-10 group-hover:bg-blue-500/20 transition-colors"></div>
                    <div className="relative z-10">
                        <div className="flex justify-between items-start mb-4">
                            <div className="p-3 rounded-2xl bg-blue-50 text-blue-600 shadow-sm group-hover:scale-110 transition-transform duration-300">
                                <Building2 className="w-6 h-6" />
                            </div>
                            <Badge className="bg-blue-100 text-blue-700 hover:bg-blue-200 border-0">{stats?.activeInstitutions ?? 0} Active</Badge>
                        </div>
                        <div>
                            <p className="text-3xl font-bold text-[#485550]">{stats?.totalInstitutions ?? 0}</p>
                            <p className="text-sm text-[#6B7C6F] font-medium mt-1">Total Institutions</p>
                        </div>
                    </div>
                </div>

                {/* Super Admins */}
                <div className="morph-card p-6 relative overflow-hidden group">
                    <div className="absolute right-0 top-0 w-32 h-32 bg-emerald-500/10 rounded-full blur-3xl -mr-10 -mt-10 group-hover:bg-emerald-500/20 transition-colors"></div>
                    <div className="relative z-10">
                        <div className="flex justify-between items-start mb-4">
                            <div className="p-3 rounded-2xl bg-emerald-50 text-emerald-600 shadow-sm group-hover:scale-110 transition-transform duration-300">
                                <Users className="w-6 h-6" />
                            </div>
                        </div>
                        <div>
                            <p className="text-3xl font-bold text-[#485550]">{stats?.totalAdmins ?? 0}</p>
                            <p className="text-sm text-[#6B7C6F] font-medium mt-1">Platform Admins</p>
                        </div>
                    </div>
                </div>

                {/* Provisioned DBs */}
                <div className="morph-card p-6 relative overflow-hidden group">
                    <div className="absolute right-0 top-0 w-32 h-32 bg-purple-500/10 rounded-full blur-3xl -mr-10 -mt-10 group-hover:bg-purple-500/20 transition-colors"></div>
                    <div className="relative z-10">
                        <div className="flex justify-between items-start mb-4">
                            <div className="p-3 rounded-2xl bg-purple-50 text-purple-600 shadow-sm group-hover:scale-110 transition-transform duration-300">
                                <Database className="w-6 h-6" />
                            </div>
                            <Badge className="bg-purple-100 text-purple-700 hover:bg-purple-200 border-0">
                                <Zap className="w-3 h-3 mr-1" />
                                {stats?.connectionStats?.totalConnections ?? 0}
                            </Badge>
                        </div>
                        <div>
                            <p className="text-3xl font-bold text-[#485550]">{stats?.provisionedInstitutions ?? 0}</p>
                            <p className="text-sm text-[#6B7C6F] font-medium mt-1">Live Databases</p>
                        </div>
                    </div>
                </div>

                {/* Pending Setup */}
                <div className="morph-card p-6 relative overflow-hidden group">
                    <div className="absolute right-0 top-0 w-32 h-32 bg-amber-500/10 rounded-full blur-3xl -mr-10 -mt-10 group-hover:bg-amber-500/20 transition-colors"></div>
                    <div className="relative z-10">
                        <div className="flex justify-between items-start mb-4">
                            <div className="p-3 rounded-2xl bg-amber-50 text-amber-600 shadow-sm group-hover:scale-110 transition-transform duration-300">
                                <Clock className="w-6 h-6" />
                            </div>
                        </div>
                        <div>
                            <p className="text-3xl font-bold text-[#485550]">{(stats?.totalInstitutions ?? 0) - (stats?.provisionedInstitutions ?? 0)}</p>
                            <p className="text-sm text-[#6B7C6F] font-medium mt-1">Pending Setup</p>
                        </div>
                    </div>
                </div>
            </div>

            {/* Main Content Grid */}
            <div className="grid lg:grid-cols-3 gap-8">
                {/* Institutions List */}
                <div className="morph-card lg:col-span-2 flex flex-col h-full">
                    <CardHeader className="pb-4 border-b border-gray-100">
                        <div className="flex items-center justify-between">
                            <div>
                                <CardTitle className="text-xl font-bold text-[#485550]">Recent Institutions</CardTitle>
                                <CardDescription className="text-[#6B7C6F]">overview of registered entities</CardDescription>
                            </div>
                            <Link href="/super-admin/institutions">
                                <Button variant="ghost" size="sm" className="text-[#6B7C6F] hover:text-[#485550] hover:bg-[#F4F6F0]">
                                    View All <ArrowRight className="w-4 h-4 ml-1" />
                                </Button>
                            </Link>
                        </div>
                    </CardHeader>
                    <CardContent className="pt-6 flex-1">
                        <div className="space-y-4">
                            {institutions.map((inst) => (
                                <div key={inst.id} className="flex items-center justify-between p-4 rounded-2xl bg-[#F4F6F0]/50 hover:bg-[#F4F6F0] border border-transparent hover:border-[#D1DBC1] transition-all duration-300 group">
                                    <div className="flex items-center gap-4">
                                        <div className="w-12 h-12 rounded-2xl bg-white shadow-sm flex items-center justify-center border border-[#E8EDE0] group-hover:scale-105 transition-transform">
                                            <span className="text-[#485550] font-bold text-sm tracking-wider">{inst.code}</span>
                                        </div>
                                        <div>
                                            <p className="font-bold text-[#485550]">{inst.name}</p>
                                            <div className="flex items-center gap-2 mt-1">
                                                <Globe className="w-3 h-3 text-[#C0EB6A]" />
                                                <span className="text-xs text-[#6B7C6F] font-medium">{inst.subdomain}.univarse.com</span>
                                            </div>
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-3">
                                        <Badge className={`border ${getStatusColor(inst.isActive, inst.isProvisioned)}`}>
                                            {!inst.isProvisioned ? 'Not Provisioned' : inst.isActive ? 'Active' : 'Inactive'}
                                        </Badge>
                                        <Button variant="ghost" size="icon" className="h-8 w-8 text-gray-400 hover:text-[#485550]">
                                            <MoreHorizontal className="w-4 h-4" />
                                        </Button>
                                    </div>
                                </div>
                            ))}

                            {institutions.length === 0 && (
                                <div className="text-center py-12 text-[#6B7C6F]">
                                    <p>No institutions found</p>
                                </div>
                            )}
                        </div>
                    </CardContent>
                </div>

                {/* Right Column: Activity & Health */}
                <div className="space-y-8">
                    {/* System Health */}
                    <div className="morph-card p-6">
                        <div className="flex items-center gap-3 mb-6">
                            <div className="w-10 h-10 rounded-xl bg-green-50 flex items-center justify-center">
                                <Activity className="w-5 h-5 text-green-600" />
                            </div>
                            <div>
                                <h3 className="font-bold text-[#485550]">System Health</h3>
                                <p className="text-xs text-[#6B7C6F]">Real-time status</p>
                            </div>
                        </div>

                        <div className="space-y-3">
                            <div className="flex items-center justify-between p-3 rounded-xl bg-[#F4F6F0]/80">
                                <div className="flex items-center gap-3">
                                    <CheckCircle2 className="w-4 h-4 text-green-500" />
                                    <span className="text-sm font-medium text-[#485550]">Master Database</span>
                                </div>
                                <span className="text-xs text-green-600 font-bold bg-green-100 px-2 py-1 rounded-lg">ONLINE</span>
                            </div>
                            <div className="flex items-center justify-between p-3 rounded-xl bg-[#F4F6F0]/80">
                                <div className="flex items-center gap-3">
                                    <CheckCircle2 className="w-4 h-4 text-green-500" />
                                    <span className="text-sm font-medium text-[#485550]">Auth Service</span>
                                </div>
                                <span className="text-xs text-green-600 font-bold bg-green-100 px-2 py-1 rounded-lg">ONLINE</span>
                            </div>
                            <div className="flex items-center justify-between p-3 rounded-xl bg-[#F4F6F0]/80">
                                <div className="flex items-center gap-3">
                                    <Database className="w-4 h-4 text-purple-500" />
                                    <span className="text-sm font-medium text-[#485550]">Tenant DBs</span>
                                </div>
                                <span className="text-xs text-purple-600 font-bold bg-purple-100 px-2 py-1 rounded-lg">{stats?.provisionedInstitutions ?? 0} ACTIVE</span>
                            </div>
                        </div>
                    </div>

                    {/* Recent Activity */}
                    <div className="morph-card flex flex-col">
                        <CardHeader className="pb-3 border-b border-gray-100">
                            <CardTitle className="text-lg font-bold text-[#485550]">Audit Log</CardTitle>
                        </CardHeader>
                        <CardContent className="pt-4">
                            <div className="space-y-4">
                                {recentActivity.map((activity) => (
                                    <div key={activity.id} className="flex gap-4 group">
                                        <div className="relative mt-1">
                                            <div className="w-8 h-8 rounded-full bg-[#F4F6F0] flex items-center justify-center border border-[#D1DBC1] group-hover:border-[#C0EB6A] transition-colors z-10 relative">
                                                {getActivityIcon(activity.action)}
                                            </div>
                                            <div className="absolute top-8 left-1/2 -translate-x-1/2 w-[1px] h-full bg-[#D1DBC1] -z-0 last:hidden"></div>
                                        </div>
                                        <div className="flex-1 min-w-0 pb-4 border-b border-gray-50 last:border-0 last:pb-0">
                                            <p className="text-sm text-[#485550] font-semibold truncate">{activity.action}</p>
                                            <p className="text-xs text-[#6B7C6F] my-0.5 line-clamp-2">{activity.description}</p>
                                            <p className="text-[10px] text-gray-400 font-medium">{new Date(activity.createdAt).toLocaleString()}</p>
                                        </div>
                                    </div>
                                ))}
                                {recentActivity.length === 0 && (
                                    <p className="text-sm text-[#6B7C6F] text-center py-4">No recent activity</p>
                                )}
                            </div>
                            <Link href="/super-admin/audit-logs">
                                <Button variant="ghost" className="w-full mt-4 text-xs h-8 text-[#6B7C6F] hover:text-[#485550] hover:bg-[#F4F6F0]">
                                    View Full History
                                </Button>
                            </Link>
                        </CardContent>
                    </div>
                </div>
            </div>
        </div>
    );
}
