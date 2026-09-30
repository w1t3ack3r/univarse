'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
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
    Search,
    Copy,
    AlertTriangle
} from 'lucide-react';
import { toast } from 'sonner';
import { Input } from '@/components/ui/input';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    DialogFooter,
} from '@/components/ui/dialog';

// Mock institutions for provisioning
const mockInstitutions = [
    { id: '1', code: 'UNIV', name: 'Universal Tech Institute', subdomain: 'universal', isProvisioned: true, dbName: 'univarse_universal' },
    { id: '2', code: 'CYBER', name: 'Cyber Academy', subdomain: 'cyber', isProvisioned: true, dbName: 'univarse_cyber' },
    { id: '3', code: 'NEXT', name: 'NextGen Learning', subdomain: 'nextgen', isProvisioned: false, dbName: 'univarse_nextgen' },
    { id: '4', code: 'GLOBAL', name: 'Global School of Arts', subdomain: 'global', isProvisioned: false, dbName: 'univarse_global' },
    { id: '5', code: 'IRON', name: 'Ironclad Logistics', subdomain: 'ironclad', isProvisioned: true, dbName: 'univarse_ironclad' },
    { id: '6', code: 'DEMO', name: 'Demo University', subdomain: 'demo', isProvisioned: false, dbName: 'univarse_demo' },
];

export default function ProvisioningPage() {
    const [institutions, setInstitutions] = useState(mockInstitutions);
    const [isLoading, setIsLoading] = useState(true);
    const [provisioningId, setProvisioningId] = useState<string | null>(null);

    useEffect(() => {
        setTimeout(() => setIsLoading(false), 500);
    }, []);

    const [showSuccessDialog, setShowSuccessDialog] = useState(false);
    const [createdCredentials, setCreatedCredentials] = useState<{ email: string; password: string; loginUrl: string; name: string } | null>(null);

    const handleProvision = async (id: string) => {
        setProvisioningId(id);

        // Simulate provisioning process
        await new Promise(resolve => setTimeout(resolve, 3000));

        const updatedInstitutions = institutions.map(inst =>
            inst.id === id ? { ...inst, isProvisioned: true } : inst
        );
        setInstitutions(updatedInstitutions);

        const provisionedInst = updatedInstitutions.find(i => i.id === id);

        if (provisionedInst) {
            // Generate Mock Credentials
            const tempPassword = Math.random().toString(36).slice(-8).toUpperCase() + Math.random().toString(36).slice(-4) + '!';
            const credentials = {
                name: provisionedInst.name,
                email: `admin@${provisionedInst.subdomain}.univarse.com`,
                password: tempPassword,
                loginUrl: `https://${provisionedInst.subdomain}.univarse.com/login`
            };

            setCreatedCredentials(credentials);
            setShowSuccessDialog(true);
            toast.success('Database provisioned & Admin credentials generated!');
        }

        setProvisioningId(null);
    };

    const copyToClipboard = (text: string) => {
        navigator.clipboard.writeText(text);
        toast.success('Copied to clipboard');
    };

    const getStatusBadge = (isProvisioned: boolean, isProvisioning: boolean) => {
        if (isProvisioning) {
            return <Badge className="bg-blue-100 text-blue-700 hover:bg-blue-200">Provisioning...</Badge>;
        }
        if (isProvisioned) {
            return <Badge className="bg-green-100 text-green-700 hover:bg-green-200">Provisioned</Badge>;
        }
        return <Badge className="bg-amber-100 text-amber-700 hover:bg-amber-200">Pending</Badge>;
    };

    if (isLoading) {
        return (
            <div className="flex items-center justify-center h-[calc(100vh-200px)]">
                <div className="flex flex-col items-center gap-4">
                    <Loader2 className="w-10 h-10 text-[#C0EB6A] animate-spin" />
                    <p className="text-[#6B7C6F] animate-pulse">Loading databases...</p>
                </div>
            </div>
        );
    }

    return (
        <div className="space-y-8">
            {/* Header */}
            <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
                <div>
                    <h2 className="text-2xl font-bold text-[#485550]">Database Provisioning</h2>
                    <p className="text-[#6B7C6F]">Manage tenant databases and deployment pipelines</p>
                </div>
            </div>

            {/* Stats */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                <div className="morph-card p-6 flex flex-col items-center sm:flex-row sm:items-center justify-between gap-4 group hover:bg-[#F4F6F0] transition-colors">
                    <div className="flex items-center gap-4">
                        <div className="w-14 h-14 rounded-2xl bg-amber-100 flex items-center justify-center text-amber-600 shadow-lg group-hover:scale-110 transition-transform">
                            <Clock className="w-7 h-7" />
                        </div>
                        <div>
                            <p className="text-3xl font-bold text-[#485550]">{institutions.filter(i => !i.isProvisioned).length}</p>
                            <p className="text-sm font-medium text-[#6B7C6F] uppercase tracking-wide">Pending</p>
                        </div>
                    </div>
                </div>

                <div className="morph-card p-6 flex flex-col items-center sm:flex-row sm:items-center justify-between gap-4 group hover:bg-[#F4F6F0] transition-colors">
                    <div className="flex items-center gap-4">
                        <div className="w-14 h-14 rounded-2xl bg-green-100 flex items-center justify-center text-green-600 shadow-lg group-hover:scale-110 transition-transform">
                            <CheckCircle2 className="w-7 h-7" />
                        </div>
                        <div>
                            <p className="text-3xl font-bold text-[#485550]">{institutions.filter(i => i.isProvisioned).length}</p>
                            <p className="text-sm font-medium text-[#6B7C6F] uppercase tracking-wide">Provisioned</p>
                        </div>
                    </div>
                </div>

                <div className="morph-card p-6 flex flex-col items-center sm:flex-row sm:items-center justify-between gap-4 group hover:bg-[#F4F6F0] transition-colors">
                    <div className="flex items-center gap-4">
                        <div className="w-14 h-14 rounded-2xl bg-blue-100 flex items-center justify-center text-blue-600 shadow-lg group-hover:scale-110 transition-transform">
                            <Database className="w-7 h-7" />
                        </div>
                        <div>
                            <p className="text-3xl font-bold text-[#485550]">{institutions.length}</p>
                            <p className="text-sm font-medium text-[#6B7C6F] uppercase tracking-wide">Total Databases</p>
                        </div>
                    </div>
                </div>
            </div>

            {/* Provisioning Queue */}
            <div className="morph-card overflow-hidden">
                <CardHeader className="flex flex-row items-center justify-between border-b border-[#F4F6F0] bg-[#F4F6F0]/30 py-4">
                    <div className="flex items-center gap-3">
                        <div className="p-2 bg-white rounded-lg text-[#485550]">
                            <Server className="w-5 h-5" />
                        </div>
                        <div>
                            <CardTitle className="text-[#485550] text-lg font-bold">Details</CardTitle>
                        </div>
                    </div>
                    <div className="relative w-64 hidden sm:block">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#6B7C6F]" />
                        <Input
                            placeholder="Search databases..."
                            className="pl-9 bg-white border-transparent focus:border-[#C0EB6A] h-9"
                        />
                    </div>
                </CardHeader>
                <CardContent className="space-y-4 pt-6">
                    {institutions.map((inst) => (
                        <div key={inst.id} className="p-5 rounded-2xl bg-white border border-[#F4F6F0] hover:border-[#D1DBC1] hover:shadow-md transition-all duration-300 group">
                            <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-6">
                                <div className="flex items-center gap-5">
                                    <div className={`w-14 h-14 rounded-2xl flex items-center justify-center text-lg font-bold shadow-sm ${inst.isProvisioned ? 'bg-[#F4F6F0] text-[#485550]' : 'bg-gradient-to-br from-[#485550] to-[#2A302D] text-[#C0EB6A]'
                                        }`}>
                                        {inst.code}
                                    </div>
                                    <div>
                                        <h3 className="font-bold text-[#485550] text-lg">{inst.name}</h3>
                                        <div className="flex items-center gap-2 mt-1">
                                            <HardDrive className="w-3 h-3 text-[#6B7C6F]" />
                                            <p className="text-sm text-[#6B7C6F] font-mono bg-[#F4F6F0] px-2 py-0.5 rounded">{inst.dbName}</p>
                                        </div>
                                    </div>
                                </div>

                                <div className="flex items-center gap-4 border-t lg:border-t-0 pt-4 lg:pt-0 border-[#F4F6F0]">
                                    {getStatusBadge(inst.isProvisioned, provisioningId === inst.id)}

                                    {!inst.isProvisioned && (
                                        <Button
                                            onClick={() => handleProvision(inst.id)}
                                            disabled={provisioningId !== null}
                                            className="btn-morph-primary"
                                        >
                                            {provisioningId === inst.id ? (
                                                <>
                                                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                                                    Provisioning...
                                                </>
                                            ) : (
                                                <>
                                                    <Play className="w-4 h-4 mr-2 fill-current" />
                                                    Provision DB
                                                </>
                                            )}
                                        </Button>
                                    )}

                                    {inst.isProvisioned && (
                                        <Link href={`/super-admin/provisioning/${inst.id}`}>
                                            <Button variant="outline" className="btn-morph bg-[#F4F6F0] hover:bg-[#E8EDE0] text-[#485550]">
                                                <Server className="w-4 h-4 mr-2" />
                                                Manage
                                            </Button>
                                        </Link>
                                    )}
                                </div>
                            </div>
                        </div>
                    ))}
                </CardContent>
            </div>

            {/* Provisioning Process */}
            <div className="morph-card p-8 bg-gradient-to-r from-white to-[#F9FAF7]">
                <div className="mb-6">
                    <h3 className="text-lg font-bold text-[#485550]">Automated Provisioning Pipeline</h3>
                    <p className="text-[#6B7C6F]">Visual representation of the database creation workflow</p>
                </div>

                <div className="relative">
                    {/* Connecting Line (Desktop) */}
                    <div className="hidden lg:block absolute top-1/2 left-0 w-full h-1 bg-[#F4F6F0] -z-10 -translate-y-1/2 rounded-full"></div>

                    <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
                        {[
                            { step: 1, label: 'Create DB', icon: Database, color: 'bg-blue-500' },
                            { step: 2, label: 'Create User', icon: Clock, color: 'bg-purple-500' },
                            { step: 3, label: 'Run Migrations', icon: Server, color: 'bg-[#C0EB6A]' },
                            { step: 4, label: 'Seed Data', icon: HardDrive, color: 'bg-amber-500' },
                            { step: 5, label: 'Ready', icon: CheckCircle2, color: 'bg-green-500' }
                        ].map((item, index) => (
                            <div key={index} className="flex flex-col items-center gap-3 group cursor-default">
                                <div className={`w-12 h-12 rounded-full flex items-center justify-center text-white shadow-lg transition-transform group-hover:scale-110 ${item.color}`}>
                                    <item.icon className={`w-5 h-5 ${item.color === 'bg-[#C0EB6A]' ? 'text-[#485550]' : 'text-white'}`} />
                                </div>
                                <div className="text-center bg-white px-4 py-2 rounded-xl shadow-sm border border-[#F4F6F0]">
                                    <p className="text-xs font-bold text-[#6B7C6F] uppercase mb-0.5">Step 0{item.step}</p>
                                    <p className="font-bold text-[#485550]">{item.label}</p>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            </div>

            {/* Success Credentials Dialog */}
            <Dialog open={showSuccessDialog} onOpenChange={setShowSuccessDialog}>
                <DialogContent className="sm:max-w-3xl bg-[#F4F6F0] border-white shadow-2xl rounded-[2rem] p-0 overflow-hidden">
                    <div className="grid grid-cols-1 md:grid-cols-5 h-full">
                        {/* Left Side - Visual */}
                        <div className="md:col-span-2 bg-[#E8EDE0]/50 p-8 flex flex-col items-center justify-center border-b md:border-b-0 md:border-r border-[#D1DBC1]/50 relative overflow-hidden text-center">
                            <div className="relative z-10 w-full flex flex-col items-center">
                                <div className="p-4 bg-white rounded-full shadow-sm mb-6 scale-110 animate-bounce">
                                    <div className="p-3 bg-green-100 rounded-full text-green-600">
                                        <CheckCircle2 className="w-8 h-8" />
                                    </div>
                                </div>
                                <h3 className="text-[#485550] font-bold text-xl mb-2">Provisioning Complete!</h3>
                                <p className="text-[#6B7C6F] text-sm leading-relaxed px-2">
                                    The tenant database is live and the admin account is ready.
                                </p>
                            </div>

                            {/* Decor */}
                            <div className="absolute -bottom-12 -left-12 text-[#D1DBC1]/30 transform -rotate-12">
                                <Server className="w-48 h-48" />
                            </div>
                        </div>

                        {/* Right Side - Credentials */}
                        <div className="md:col-span-3 p-8 flex flex-col justify-center">
                            <DialogHeader className="mb-6 text-left">
                                <DialogTitle className="text-[#485550] text-xl font-bold">Admin Credentials</DialogTitle>
                                <DialogDescription className="text-[#6B7C6F]">
                                    Save these details securely. They will not be shown again.
                                </DialogDescription>
                            </DialogHeader>

                            {createdCredentials && (
                                <div className="space-y-5">
                                    <div className="bg-white rounded-2xl border border-[#F4F6F0] p-1 shadow-inner">
                                        <div className="p-4 bg-[#F4F6F0]/50 rounded-xl space-y-4">
                                            <div className="flex justify-between items-center group">
                                                <div>
                                                    <p className="text-[10px] uppercase font-bold text-[#6B7C6F] tracking-wider mb-0.5">Admin Email</p>
                                                    <p className="font-medium text-[#485550] text-sm">{createdCredentials.email}</p>
                                                </div>
                                                <Button size="icon" variant="ghost" className="h-8 w-8 text-[#6B7C6F] hover:text-[#485550] opacity-0 group-hover:opacity-100 transition-opacity" onClick={() => copyToClipboard(createdCredentials.email)}>
                                                    <Copy className="w-4 h-4" />
                                                </Button>
                                            </div>

                                            <div className="h-px bg-[#D1DBC1]/30 w-full" />

                                            <div className="flex justify-between items-center group">
                                                <div>
                                                    <p className="text-[10px] uppercase font-bold text-[#6B7C6F] tracking-wider mb-0.5">Temp Password</p>
                                                    <p className="font-mono text-sm font-bold text-[#485550] bg-white px-2 py-1 rounded border border-[#D1DBC1]/50 inline-block shadow-sm">
                                                        {createdCredentials.password}
                                                    </p>
                                                </div>
                                                <Button size="icon" variant="ghost" className="h-8 w-8 text-[#6B7C6F] hover:text-[#485550] opacity-0 group-hover:opacity-100 transition-opacity" onClick={() => copyToClipboard(createdCredentials.password)}>
                                                    <Copy className="w-4 h-4" />
                                                </Button>
                                            </div>

                                            <div className="h-px bg-[#D1DBC1]/30 w-full" />

                                            <div className="flex justify-between items-center group">
                                                <div className="overflow-hidden pr-2">
                                                    <p className="text-[10px] uppercase font-bold text-[#6B7C6F] tracking-wider mb-0.5">Login URL</p>
                                                    <a href="#" className="font-mono text-xs text-blue-600 hover:underline truncate block">{createdCredentials.loginUrl}</a>
                                                </div>
                                                <Button size="icon" variant="ghost" className="h-8 w-8 text-[#6B7C6F] hover:text-[#485550] opacity-0 group-hover:opacity-100 transition-opacity" onClick={() => copyToClipboard(createdCredentials.loginUrl)}>
                                                    <Copy className="w-4 h-4" />
                                                </Button>
                                            </div>
                                        </div>
                                    </div>

                                    <div className="bg-amber-50 p-3 rounded-xl flex items-start gap-3 border border-amber-100">
                                        <AlertTriangle className="w-5 h-5 text-amber-500 shrink-0 mt-0.5" />
                                        <p className="text-xs text-amber-700 leading-relaxed">
                                            This is a temporary password. The administrator will be required to set a new password upon their first login.
                                        </p>
                                    </div>
                                </div>
                            )}

                            <DialogFooter className="mt-8">
                                <Button
                                    className="w-full btn-morph-primary h-12 text-base shadow-lg shadow-green-100"
                                    onClick={() => setShowSuccessDialog(false)}
                                >
                                    <CheckCircle2 className="w-5 h-5 mr-2" />
                                    I have saved these credentials
                                </Button>
                            </DialogFooter>
                        </div>
                    </div>
                </DialogContent>
            </Dialog>
        </div>
    );
}
