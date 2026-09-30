'use client';

import { useState, useEffect } from 'react';
import { CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import {
    FileText,
    Search,
    Filter,
    Download,
    RefreshCw,
    Building2,
    Server,
    Shield,
    Database,
    Calendar,
    User,
    Clock,
    Activity,
    Loader2
} from 'lucide-react';
import { toast } from 'sonner';
// import { api } from '@/lib/api';

interface AuditLog {
    id: string;
    action: string;
    description: string;
    superAdminId?: string;
    institutionId?: string;
    createdAt: string;
}

export default function AuditLogsPage() {
    const [logs, setLogs] = useState<AuditLog[]>([]);
    const [searchQuery, setSearchQuery] = useState('');
    const [typeFilter, setTypeFilter] = useState('all');
    const [isLoading, setIsLoading] = useState(true);

    const fetchLogs = async () => {
        setIsLoading(true);
        // MOCK DATA FETCH
        try {
            await new Promise(resolve => setTimeout(resolve, 800));
            setLogs([
                { id: '109283-a', action: 'OFFICIAL_INSTITUTION_PROVISION', description: 'Provisioned database for Cyber Academy', createdAt: new Date(Date.now() - 1000 * 60 * 5).toISOString(), superAdminId: '1' },
                { id: '298374-b', action: 'SYSTEM_BACKUP_COMPLETED', description: 'Automated system backup completed successfully', createdAt: new Date(Date.now() - 1000 * 60 * 60).toISOString() },
                { id: '345678-c', action: 'SUPER_ADMIN_LOGIN', description: 'Super Admin login detected', createdAt: new Date(Date.now() - 1000 * 60 * 120).toISOString(), superAdminId: '1' },
                { id: '456789-d', action: 'INSTITUTION_REGISTERED', description: 'New institution registration: NextGen Learning', createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24).toISOString(), institutionId: '3' },
                { id: '567890-e', action: 'DATABASE_MIGRATION', description: 'Applied pending migrations to univar-core', createdAt: new Date(Date.now() - 1000 * 60 * 60 * 48).toISOString() },
                { id: '678901-f', action: 'AUTH_POLICY_UPDATE', description: 'Updated global password policy requirements', createdAt: new Date(Date.now() - 1000 * 60 * 60 * 72).toISOString(), superAdminId: '2' },
            ]);
        } catch (error: any) {
            toast.error('Failed to load audit logs (Mock Mode)');
        } finally {
            setIsLoading(false);
        }
    };

    useEffect(() => {
        fetchLogs();
    }, []);

    const getTypeFromAction = (action: string): string => {
        if (action.includes('INSTITUTION') || action.includes('PROVISION')) return 'institution';
        if (action.includes('SEED') || action.includes('SYSTEM')) return 'system';
        if (action.includes('LOGIN') || action.includes('AUTH') || action.includes('2FA')) return 'auth';
        if (action.includes('DATABASE') || action.includes('MIGRATE')) return 'database';
        return 'other';
    };

    const filteredLogs = logs.filter(log => {
        const matchesSearch = log.action.toLowerCase().includes(searchQuery.toLowerCase()) ||
            log.description.toLowerCase().includes(searchQuery.toLowerCase());
        const logType = getTypeFromAction(log.action);
        const matchesType = typeFilter === 'all' || logType === typeFilter;
        return matchesSearch && matchesType;
    });

    const getTypeIcon = (action: string) => {
        const type = getTypeFromAction(action);
        switch (type) {
            case 'institution': return <Building2 className="w-4 h-4 text-blue-500" />;
            case 'system': return <Server className="w-4 h-4 text-purple-500" />;
            case 'auth': return <Shield className="w-4 h-4 text-green-500" />;
            case 'database': return <Database className="w-4 h-4 text-orange-500" />;
            default: return <Activity className="w-4 h-4 text-gray-500" />;
        }
    };

    const getTypeColor = (action: string) => {
        const type = getTypeFromAction(action);
        switch (type) {
            case 'institution': return 'bg-blue-50 text-blue-700 border-blue-100';
            case 'system': return 'bg-purple-50 text-purple-700 border-purple-100';
            case 'auth': return 'bg-green-50 text-green-700 border-green-100';
            case 'database': return 'bg-orange-50 text-orange-700 border-orange-100';
            default: return 'bg-gray-50 text-gray-700 border-gray-100';
        }
    };

    if (isLoading) {
        return (
            <div className="flex items-center justify-center h-[calc(100vh-200px)]">
                <div className="flex flex-col items-center gap-4">
                    <Loader2 className="w-10 h-10 text-[#C0EB6A] animate-spin" />
                    <p className="text-[#6B7C6F] animate-pulse">Retrieving audit trails...</p>
                </div>
            </div>
        );
    }

    return (
        <div className="space-y-6">
            {/* Header */}
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div>
                    <h2 className="text-2xl font-bold text-[#485550]">Audit Logs</h2>
                    <p className="text-[#6B7C6F]">Detailed timeline of platform activities and security events</p>
                </div>
                <Button className="btn-morph-primary">
                    <Download className="w-4 h-4 mr-2" />
                    Export CSV
                </Button>
            </div>

            {/* Filters */}
            <div className="morph-card p-4">
                <div className="flex flex-col md:flex-row gap-4">
                    <div className="relative flex-1">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#6B7C6F]" />
                        <Input
                            placeholder="Search by action, description, or ID..."
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            className="input-morph pl-10 bg-white border-transparent"
                        />
                    </div>
                    <Select value={typeFilter} onValueChange={setTypeFilter}>
                        <SelectTrigger className="w-full md:w-56 bg-white border-transparent shadow-sm rounded-xl h-10 text-[#485550]">
                            <Filter className="w-4 h-4 mr-2 text-[#C0EB6A]" />
                            <SelectValue placeholder="Filter by type" />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="all">All Event Types</SelectItem>
                            <SelectItem value="institution">Institution Management</SelectItem>
                            <SelectItem value="system">System Operations</SelectItem>
                            <SelectItem value="auth">Authentication & Security</SelectItem>
                            <SelectItem value="database">Database Operations</SelectItem>
                        </SelectContent>
                    </Select>
                </div>
            </div>

            {/* Timeline View */}
            <div className="space-y-4">
                {filteredLogs.length > 0 ? (
                    filteredLogs.map((log) => (
                        <div key={log.id} className="morph-card p-4 hover:bg-[#F4F6F0] transition-colors group">
                            <div className="flex items-start gap-4">
                                <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 border ${getTypeColor(log.action)} shadow-sm group-hover:scale-110 transition-transform`}>
                                    {getTypeIcon(log.action)}
                                </div>

                                <div className="flex-1 min-w-0">
                                    <div className="flex items-center flex-wrap gap-2 mb-1">
                                        <Badge className={`border-0 font-mono tracking-wide ${getTypeColor(log.action)}`}>
                                            {log.action}
                                        </Badge>
                                        <span className="text-xs text-[#6B7C6F] flex items-center gap-1">
                                            <Clock className="w-3 h-3" />
                                            {new Date(log.createdAt).toLocaleString()}
                                        </span>
                                    </div>
                                    <p className="text-[#485550] text-sm font-medium">{log.description}</p>

                                    <div className="flex items-center gap-6 mt-3 text-xs text-[#6B7C6F]">
                                        <div className="flex items-center gap-1.5 bg-white px-2 py-1 rounded-md shadow-sm">
                                            <User className="w-3 h-3 text-[#C0EB6A]" />
                                            <span className="font-semibold text-[#485550]">{log.superAdminId ? 'Super Admin' : 'System'}</span>
                                        </div>
                                        {log.institutionId && (
                                            <div className="flex items-center gap-1.5 bg-white px-2 py-1 rounded-md shadow-sm">
                                                <Building2 className="w-3 h-3 text-blue-400" />
                                                <span>Institution: <span className="font-mono">{log.institutionId}</span></span>
                                            </div>
                                        )}
                                        <div className="flex items-center gap-1.5 opacity-60">
                                            <FileText className="w-3 h-3" />
                                            ID: <span className="font-mono">{log.id.substring(0, 8)}...</span>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    ))
                ) : (
                    <div className="morph-card py-16 text-center">
                        <div className="w-16 h-16 bg-[#F4F6F0] rounded-full flex items-center justify-center mx-auto mb-4">
                            <FileText className="w-8 h-8 text-[#D1DBC1]" />
                        </div>
                        <h3 className="text-lg font-bold text-[#485550]">No logs found</h3>
                        <p className="text-[#6B7C6F]">Try adjusting your search or filters</p>
                    </div>
                )}
            </div>
        </div>
    );
}
