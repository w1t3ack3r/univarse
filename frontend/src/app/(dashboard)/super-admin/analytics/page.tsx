'use client';

import { useState, useEffect } from 'react';
import { CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
    Building2,
    Users,
    Activity,
    TrendingUp,
    TrendingDown,
    RefreshCw,
    BarChart3,
    Clock,
    Shield,
    Loader2
} from 'lucide-react';
import { toast } from 'sonner';
// import { api } from '@/lib/api';

interface OverviewData {
    totalInstitutions: number;
    activeInstitutions: number;
    pendingInstitutions: number;
    suspendedInstitutions: number;
    deletionPending: number;
    provisionedInstitutions: number;
    recentActivity: number;
    superAdminCount: number;
    activeSessions: number;
    growth: {
        thisMonth: number;
        lastMonth: number;
        percentage: number;
    };
}

interface TrendData {
    date: string;
    institutions: number;
    activity: number;
}

export default function AnalyticsPage() {
    const [overview, setOverview] = useState<OverviewData | null>(null);
    const [trends, setTrends] = useState<TrendData[]>([]);
    const [period, setPeriod] = useState('30d');
    const [isLoading, setIsLoading] = useState(true);

    useEffect(() => {
        fetchData();
    }, [period]);

    const fetchData = async () => {
        setIsLoading(true);
        // MOCK DATA FETCH
        try {
            await new Promise(resolve => setTimeout(resolve, 1200));

            setOverview({
                totalInstitutions: 24,
                activeInstitutions: 18,
                pendingInstitutions: 4,
                suspendedInstitutions: 1,
                deletionPending: 1,
                provisionedInstitutions: 15,
                recentActivity: 1245,
                superAdminCount: 5,
                activeSessions: 3,
                growth: {
                    thisMonth: 3,
                    lastMonth: 2,
                    percentage: 15.5
                }
            });

            // Generate mock trend data
            const mockTrends = Array.from({ length: 30 }, (_, i) => {
                const date = new Date();
                date.setDate(date.getDate() - (29 - i));
                return {
                    date: date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
                    institutions: 20 + Math.floor(Math.random() * 5),
                    activity: 50 + Math.floor(Math.random() * 100)
                };
            });

            setTrends(mockTrends);
        } catch (error: any) {
            toast.error('Failed to load analytics (Mock Mode)');
        } finally {
            setIsLoading(false);
        }
    };

    if (isLoading) {
        return (
            <div className="flex items-center justify-center h-[calc(100vh-200px)]">
                <div className="flex flex-col items-center gap-4">
                    <Loader2 className="w-10 h-10 text-[#C0EB6A] animate-spin" />
                    <p className="text-[#6B7C6F] animate-pulse">Calculating metrics...</p>
                </div>
            </div>
        );
    }

    const maxActivity = Math.max(...trends.map(t => t.activity), 1);

    return (
        <div className="space-y-6">
            {/* Header */}
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div>
                    <h2 className="text-2xl font-bold text-[#485550]">Analytics</h2>
                    <p className="text-[#6B7C6F]">Platform-wide statistics and growth trends</p>
                </div>
                <Button variant="outline" onClick={fetchData} className="btn-morph bg-white">
                    <RefreshCw className="w-4 h-4 mr-2" />
                    Refresh
                </Button>
            </div>

            {/* Overview Stats */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
                <div className="morph-card p-6 flex flex-col justify-between hover:bg-[#F4F6F0] transition-colors group">
                    <div className="flex items-center justify-between">
                        <div>
                            <p className="text-[#6B7C6F] font-medium text-sm">Total Institutions</p>
                            <p className="text-3xl font-bold text-[#485550] mt-1">{overview?.totalInstitutions || 0}</p>
                        </div>
                        <div className="w-12 h-12 rounded-2xl bg-blue-100 flex items-center justify-center text-blue-600 shadow-sm group-hover:scale-110 transition-transform">
                            <Building2 className="w-6 h-6" />
                        </div>
                    </div>
                    <div className="flex items-center gap-2 mt-4">
                        {(overview?.growth?.percentage || 0) >= 0 ? (
                            <Badge className="bg-green-100 text-green-700 hover:bg-green-200">
                                <TrendingUp className="w-3 h-3 mr-1" />
                                +{overview?.growth?.percentage}%
                            </Badge>
                        ) : (
                            <Badge className="bg-red-100 text-red-700 hover:bg-red-200">
                                <TrendingDown className="w-3 h-3 mr-1" />
                                {overview?.growth?.percentage}%
                            </Badge>
                        )}
                        <span className="text-xs text-[#6B7C6F]">vs last month</span>
                    </div>
                </div>

                <div className="morph-card p-6 flex flex-col justify-between hover:bg-[#F4F6F0] transition-colors group">
                    <div className="flex items-center justify-between">
                        <div>
                            <p className="text-[#6B7C6F] font-medium text-sm">Active</p>
                            <p className="text-3xl font-bold text-[#485550] mt-1">{overview?.activeInstitutions || 0}</p>
                        </div>
                        <div className="w-12 h-12 rounded-2xl bg-green-100 flex items-center justify-center text-green-600 shadow-sm group-hover:scale-110 transition-transform">
                            <Activity className="w-6 h-6" />
                        </div>
                    </div>
                    <div className="flex gap-2 mt-4">
                        <Badge className="bg-amber-100 text-amber-700 hover:bg-amber-200 border-0">{overview?.pendingInstitutions || 0} pending</Badge>
                        <Badge className="bg-purple-100 text-purple-700 hover:bg-purple-200 border-0">{overview?.provisionedInstitutions || 0} provisioned</Badge>
                    </div>
                </div>

                <div className="morph-card p-6 flex flex-col justify-between hover:bg-[#F4F6F0] transition-colors group">
                    <div className="flex items-center justify-between">
                        <div>
                            <p className="text-[#6B7C6F] font-medium text-sm">Recent Activity</p>
                            <p className="text-3xl font-bold text-[#485550] mt-1">{overview?.recentActivity || 0}</p>
                        </div>
                        <div className="w-12 h-12 rounded-2xl bg-amber-100 flex items-center justify-center text-amber-600 shadow-sm group-hover:scale-110 transition-transform">
                            <Clock className="w-6 h-6" />
                        </div>
                    </div>
                    <p className="text-xs text-[#6B7C6F] mt-1">Actions in last 30 days</p>
                </div>

                <div className="morph-card p-6 flex flex-col justify-between hover:bg-[#F4F6F0] transition-colors group">
                    <div className="flex items-center justify-between">
                        <div>
                            <p className="text-[#6B7C6F] font-medium text-sm">Super Admins</p>
                            <p className="text-3xl font-bold text-[#485550] mt-1">{overview?.superAdminCount || 0}</p>
                        </div>
                        <div className="w-12 h-12 rounded-2xl bg-purple-100 flex items-center justify-center text-purple-600 shadow-sm group-hover:scale-110 transition-transform">
                            <Shield className="w-6 h-6" />
                        </div>
                    </div>
                    <p className="text-xs text-[#6B7C6F] mt-1">{overview?.activeSessions || 0} active sessions</p>
                </div>
            </div>

            {/* Status Breakdown */}
            <div className="morph-card p-6">
                <CardHeader className="px-0 pt-0 pb-6 border-b border-[#F4F6F0]">
                    <CardTitle className="flex items-center gap-2 text-[#485550]">
                        <BarChart3 className="w-5 h-5 text-[#C0EB6A]" />
                        Institution Status Breakdown
                    </CardTitle>
                </CardHeader>
                <CardContent className="px-0 pt-6">
                    <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
                        <div className="text-center p-4 bg-green-50 rounded-2xl border border-transparent hover:border-green-100 transition-colors">
                            <p className="text-2xl font-bold text-green-600">{overview?.activeInstitutions || 0}</p>
                            <p className="text-sm text-green-700 font-medium">Active</p>
                        </div>
                        <div className="text-center p-4 bg-amber-50 rounded-2xl border border-transparent hover:border-amber-100 transition-colors">
                            <p className="text-2xl font-bold text-amber-600">{overview?.pendingInstitutions || 0}</p>
                            <p className="text-sm text-amber-700 font-medium">Pending</p>
                        </div>
                        <div className="text-center p-4 bg-purple-50 rounded-2xl border border-transparent hover:border-purple-100 transition-colors">
                            <p className="text-2xl font-bold text-purple-600">{overview?.provisionedInstitutions || 0}</p>
                            <p className="text-sm text-purple-700 font-medium">Provisioned</p>
                        </div>
                        <div className="text-center p-4 bg-red-50 rounded-2xl border border-transparent hover:border-red-100 transition-colors">
                            <p className="text-2xl font-bold text-red-600">{overview?.suspendedInstitutions || 0}</p>
                            <p className="text-sm text-red-700 font-medium">Suspended</p>
                        </div>
                        <div className="text-center p-4 bg-gray-50 rounded-2xl border border-transparent hover:border-gray-200 transition-colors">
                            <p className="text-2xl font-bold text-gray-600">{overview?.deletionPending || 0}</p>
                            <p className="text-sm text-gray-700 font-medium">Pending Deletion</p>
                        </div>
                    </div>
                </CardContent>
            </div>

            {/* Activity Chart */}
            <div className="morph-card p-6">
                <CardHeader className="px-0 pt-0 pb-6 border-b border-[#F4F6F0] flex flex-row items-center justify-between">
                    <div>
                        <CardTitle className="flex items-center gap-2 text-[#485550]">
                            <Activity className="w-5 h-5 text-[#C0EB6A]" />
                            Activity Trends
                        </CardTitle>
                        <CardDescription className="text-[#6B7C6F] mt-1">Platform activity over time</CardDescription>
                    </div>
                    <div className="flex gap-2">
                        {['7d', '30d', '90d'].map(p => (
                            <Button
                                key={p}
                                variant={period === p ? 'default' : 'ghost'}
                                size="sm"
                                onClick={() => setPeriod(p)}
                                className={period === p
                                    ? 'bg-[#C0EB6A] text-[#485550] hover:bg-[#b0d960]'
                                    : 'text-[#6B7C6F] hover:text-[#485550] hover:bg-[#F4F6F0]'}
                            >
                                {p === '7d' ? '7 Days' : p === '30d' ? '30 Days' : '90 Days'}
                            </Button>
                        ))}
                    </div>
                </CardHeader>
                <CardContent className="px-0 pt-8" style={{ minHeight: '300px' }}>
                    {trends.length === 0 ? (
                        <div className="flex flex-col items-center justify-center h-full text-[#6B7C6F] opacity-50">
                            <Activity className="w-12 h-12 mb-2" />
                            <p>No trend data available</p>
                        </div>
                    ) : (
                        <div className="space-y-4 h-full flex flex-col justify-end">
                            {/* Simple bar chart */}
                            <div className="h-48 flex items-end gap-1.5">
                                {trends.slice(-30).map((t, i) => (
                                    <div
                                        key={i}
                                        className="flex-1 bg-[#C0EB6A] rounded-t-sm hover:bg-[#b0d960] transition-all relative group"
                                        style={{ height: `${(t.activity / maxActivity) * 100}%`, minHeight: '4px' }}
                                    >
                                        <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 bg-[#485550] text-white text-[10px] py-1 px-2 rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap pointer-events-none z-10">
                                            {t.date}: {t.activity} actions
                                        </div>
                                    </div>
                                ))}
                            </div>
                            <div className="flex justify-between text-xs text-[#6B7C6F] font-medium pt-2 border-t border-[#F4F6F0]">
                                <span>{trends[0]?.date}</span>
                                <span>{trends[trends.length - 1]?.date}</span>
                            </div>
                        </div>
                    )}
                </CardContent>
            </div>
        </div>
    );
}
