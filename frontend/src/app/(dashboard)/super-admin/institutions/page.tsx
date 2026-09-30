'use client';

import { useState, useEffect } from 'react';
import { CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    DialogFooter,
} from '@/components/ui/dialog';
import {
    Building2,
    Plus,
    Search,
    Globe,
    Database,
    MoreHorizontal,
    Trash2,
    CheckCircle2,
    Clock,
    Loader2,
    Ban,
    AlertTriangle,
    Mail,
    Phone,
    MapPin,
    Shield,
    Server
} from 'lucide-react';
import { toast } from 'sonner';
// import { api } from '@/lib/api';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

// ============================================
// TYPE DEFINITIONS
// ============================================

type InstitutionStatus = 'PENDING' | 'PROVISIONED' | 'ACTIVE' | 'SUSPENDED' | 'PENDING_DELETION' | 'DELETED';

interface Institution {
    id: string;
    code: string;
    name: string;
    subdomain: string;
    email?: string;
    phone?: string;
    address?: string;
    dbHost: string;
    dbPort: number;
    dbName: string;
    status: InstitutionStatus;
    isActive: boolean;
    isProvisioned: boolean;
    deletionRequestedAt?: string;
    deletionScheduledAt?: string;
    deletionWarningsSent?: number;
    createdAt: string;
    updatedAt?: string;
}

// ============================================
// HELPER FUNCTIONS
// ============================================

const getEffectiveStatus = (inst: Institution): InstitutionStatus => {
    if (inst.status) return inst.status;
    if (!inst.isProvisioned) return 'PENDING';
    if (!inst.isActive) return 'SUSPENDED';
    return 'ACTIVE';
};

export default function InstitutionsPage() {
    // Core state
    const [institutions, setInstitutions] = useState<Institution[]>([]);
    const [searchQuery, setSearchQuery] = useState('');
    const [statusFilter, setStatusFilter] = useState('all');
    const [isLoading, setIsLoading] = useState(true);
    const [provisioningId, setProvisioningId] = useState<string | null>(null);

    // Dialog states
    const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
    const [isSubmitting, setIsSubmitting] = useState(false);

    // Form state
    const [formData, setFormData] = useState({
        code: '',
        name: '',
        subdomain: '',
        email: '',
        phone: '',
        address: '',
    });

    const fetchInstitutions = async () => {
        setIsLoading(true);
        // MOCK DATA FETCH
        try {
            await new Promise(resolve => setTimeout(resolve, 800));
            setInstitutions([
                { id: '1', code: 'UNIV', name: 'Universal Tech Institute', subdomain: 'universal', email: 'admin@univ.edu', phone: '+1234567890', address: '123 Tech Blvd', dbHost: 'localhost', dbPort: 5432, dbName: 'univarse_universal', status: 'ACTIVE', isActive: true, isProvisioned: true, createdAt: '2024-01-01T00:00:00Z' },
                { id: '2', code: 'CYBER', name: 'Cyber Academy', subdomain: 'cyber', email: 'info@cyber.edu', phone: '+9876543210', address: '456 Cyber Lane', dbHost: 'localhost', dbPort: 5432, dbName: 'univarse_cyber', status: 'ACTIVE', isActive: true, isProvisioned: true, createdAt: '2024-02-01T00:00:00Z' },
                { id: '3', code: 'NEXT', name: 'NextGen Learning', subdomain: 'nextgen', email: 'contact@nextgen.edu', phone: '+1122334455', address: '789 Gen Z Way', dbHost: 'localhost', dbPort: 5432, dbName: 'univarse_nextgen', status: 'PENDING', isActive: false, isProvisioned: false, createdAt: '2024-03-01T00:00:00Z' },
                { id: '4', code: 'GLOBAL', name: 'Global School of Arts', subdomain: 'global', email: 'art@global.edu', phone: '+5566778899', address: '101 Art Ave', dbHost: 'localhost', dbPort: 5432, dbName: 'univarse_global', status: 'PENDING', isActive: false, isProvisioned: false, createdAt: '2024-03-05T00:00:00Z' },
                { id: '5', code: 'IRON', name: 'Ironclad Logistics', subdomain: 'ironclad', email: 'logistics@iron.com', phone: '+9988776655', dbHost: 'localhost', dbPort: 5432, dbName: 'univarse_ironclad', status: 'ACTIVE', isActive: true, isProvisioned: true, createdAt: '2024-01-15T00:00:00Z' },
                { id: '6', code: 'DEMO', name: 'Demo University', subdomain: 'demo', email: 'demo@demo.edu', dbHost: 'localhost', dbPort: 5432, dbName: 'univarse_demo', status: 'PENDING', isActive: false, isProvisioned: false, createdAt: '2024-03-10T00:00:00Z' },
            ]);
        } catch (error: any) {
            toast.error('Failed to load institutions (Mock Mode)');
        } finally {
            setIsLoading(false);
        }
    };

    useEffect(() => {
        fetchInstitutions();
    }, []);

    const filteredInstitutions = institutions.filter(inst => {
        const matchesSearch = inst.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
            inst.code.toLowerCase().includes(searchQuery.toLowerCase()) ||
            inst.subdomain.toLowerCase().includes(searchQuery.toLowerCase());

        if (statusFilter === 'all') return matchesSearch;
        const effectiveStatus = getEffectiveStatus(inst);
        return matchesSearch && effectiveStatus === statusFilter;
    });

    const stats = {
        total: institutions.length,
        active: institutions.filter(i => getEffectiveStatus(i) === 'ACTIVE').length,
        provisioned: institutions.filter(i => ['PROVISIONED', 'ACTIVE', 'SUSPENDED', 'PENDING_DELETION'].includes(getEffectiveStatus(i))).length,
        pending: institutions.filter(i => getEffectiveStatus(i) === 'PENDING').length,
    };

    const handleAddInstitution = async () => {
        if (!formData.code || !formData.name || !formData.subdomain) {
            toast.error('Please fill in all required fields');
            return;
        }

        setIsSubmitting(true);
        // MOCK CREATE
        try {
            await new Promise(resolve => setTimeout(resolve, 1500));

            const newInstitution: Institution = {
                id: Math.random().toString(36).substr(2, 9),
                code: formData.code,
                name: formData.name,
                subdomain: formData.subdomain,
                email: formData.email,
                phone: formData.phone,
                address: formData.address,
                dbHost: 'localhost',
                dbPort: 5432,
                dbName: `univarse_${formData.subdomain}`,
                status: 'PENDING',
                isActive: false,
                isProvisioned: false,
                createdAt: new Date().toISOString()
            };

            setInstitutions([...institutions, newInstitution]);
            setIsAddDialogOpen(false);
            setFormData({ code: '', name: '', subdomain: '', email: '', phone: '', address: '' });
            toast.success(`Institution "${formData.name}" created successfully (Mock Mode)`);
        } catch (error: any) {
            toast.error(error.message || 'Failed to create institution');
        } finally {
            setIsSubmitting(false);
        }
    };

    const handleProvision = async (id: string) => {
        // const institution = institutions.find(i => i.id === id);
        setProvisioningId(id);
        // MOCK PROVISION
        try {
            await new Promise(resolve => setTimeout(resolve, 2000));

            setInstitutions(institutions.map(inst =>
                inst.id === id ? { ...inst, isProvisioned: true, status: 'ACTIVE' as InstitutionStatus, isActive: true } : inst
            ));
            toast.success('Database provisioned successfully! (Mock Mode)');
        } catch (error: any) {
            toast.error(error.message || 'Failed to provision database');
        } finally {
            setProvisioningId(null);
        }
    };

    const getStatusBadge = (inst: Institution) => {
        const status = getEffectiveStatus(inst);
        switch (status) {
            case 'PENDING':
                return <Badge className="bg-amber-100 text-amber-700 border-amber-200 hover:bg-amber-200">Pending Setup</Badge>;
            case 'PROVISIONED':
                return <Badge className="bg-blue-100 text-blue-700 border-blue-200 hover:bg-blue-200">Provisioned</Badge>;
            case 'ACTIVE':
                return <Badge className="bg-green-100 text-green-700 border-green-200 hover:bg-green-200">Active</Badge>;
            case 'SUSPENDED':
                return <Badge className="bg-red-100 text-red-700 border-red-200 hover:bg-red-200">Suspended</Badge>;
            case 'PENDING_DELETION':
                return <Badge className="bg-orange-100 text-orange-700 border-orange-200 hover:bg-orange-200">Deleting...</Badge>;
            default:
                return <Badge className="bg-gray-100 text-gray-700 border-gray-200">Unknown</Badge>;
        }
    };

    if (isLoading) {
        return (
            <div className="flex items-center justify-center h-[calc(100vh-200px)]">
                <div className="flex flex-col items-center gap-4">
                    <Loader2 className="w-10 h-10 text-[#C0EB6A] animate-spin" />
                    <p className="text-[#6B7C6F] animate-pulse">Loading institutions...</p>
                </div>
            </div>
        );
    }

    return (
        <div className="space-y-8">
            {/* Header & Controls */}
            <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
                <div>
                    <h2 className="text-2xl font-bold text-[#485550]">Institutions</h2>
                    <p className="text-[#6B7C6F]">Manage registered universities and colleges</p>
                </div>

                <div className="flex items-center gap-3 w-full md:w-auto">
                    <div className="relative flex-1 md:w-64">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#6B7C6F]" />
                        <Input
                            placeholder="Search institutions..."
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            className="pl-9 bg-white/50 border-[#D1DBC1] focus:border-[#C0EB6A] focus:ring-[#C0EB6A] rounded-xl"
                        />
                    </div>
                    <Button
                        onClick={() => setIsAddDialogOpen(true)}
                        className="btn-morph-primary shadow-lg"
                    >
                        <Plus className="w-4 h-4 mr-2" />
                        <span className="hidden sm:inline">Add New</span>
                        <span className="sm:hidden">Add</span>
                    </Button>
                </div>
            </div>

            {/* Stats Row */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                <div className="morph-card p-5 group hover:bg-[#F4F6F0] transition-colors">
                    <div className="flex items-center gap-4">
                        <div className="w-12 h-12 rounded-xl bg-blue-50 text-blue-600 flex items-center justify-center shadow-sm group-hover:scale-105 transition-transform">
                            <Building2 className="w-6 h-6" />
                        </div>
                        <div>
                            <p className="text-2xl font-bold text-[#485550]">{stats.total}</p>
                            <p className="text-sm text-[#6B7C6F]">Total Registered</p>
                        </div>
                    </div>
                </div>
                <div className="morph-card p-5 group hover:bg-[#F4F6F0] transition-colors">
                    <div className="flex items-center gap-4">
                        <div className="w-12 h-12 rounded-xl bg-green-50 text-green-600 flex items-center justify-center shadow-sm group-hover:scale-105 transition-transform">
                            <CheckCircle2 className="w-6 h-6" />
                        </div>
                        <div>
                            <p className="text-2xl font-bold text-[#485550]">{stats.active}</p>
                            <p className="text-sm text-[#6B7C6F]">Active Campus</p>
                        </div>
                    </div>
                </div>
                <div className="morph-card p-5 group hover:bg-[#F4F6F0] transition-colors">
                    <div className="flex items-center gap-4">
                        <div className="w-12 h-12 rounded-xl bg-purple-50 text-purple-600 flex items-center justify-center shadow-sm group-hover:scale-105 transition-transform">
                            <Database className="w-6 h-6" />
                        </div>
                        <div>
                            <p className="text-2xl font-bold text-[#485550]">{stats.provisioned}</p>
                            <p className="text-sm text-[#6B7C6F]">Databases Live</p>
                        </div>
                    </div>
                </div>
                <div className="morph-card p-5 group hover:bg-[#F4F6F0] transition-colors">
                    <div className="flex items-center gap-4">
                        <div className="w-12 h-12 rounded-xl bg-amber-50 text-amber-600 flex items-center justify-center shadow-sm group-hover:scale-105 transition-transform">
                            <Clock className="w-6 h-6" />
                        </div>
                        <div>
                            <p className="text-2xl font-bold text-[#485550]">{stats.pending}</p>
                            <p className="text-sm text-[#6B7C6F]">Pending Setup</p>
                        </div>
                    </div>
                </div>
            </div>

            {/* Institutions Grid */}
            <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-6">
                {filteredInstitutions.map((inst) => (
                    <div key={inst.id} onClick={() => window.location.href = `/super-admin/institutions/${inst.id}`} className="morph-card p-6 flex flex-col group hover:shadow-xl transition-all duration-300 border border-transparent hover:border-[#D1DBC1] cursor-pointer relative">
                        {/* Card Header */}
                        <div className="flex justify-between items-start mb-4">
                            <div className="flex items-center gap-4">
                                <div className="w-14 h-14 rounded-2xl bg-gradient-brand flex items-center justify-center shadow-lg group-hover:scale-105 transition-transform duration-300">
                                    <span className="text-white font-bold text-lg tracking-wider">
                                        {inst.code}
                                    </span>
                                </div>
                                <div>
                                    <h3 className="font-bold text-[#485550] text-lg leading-tight line-clamp-1" title={inst.name}>{inst.name}</h3>
                                    <div className="flex items-center gap-1.5 text-sm text-[#6B7C6F] mt-1">
                                        <Globe className="w-3.5 h-3.5 text-[#C0EB6A]" />
                                        <span>{inst.subdomain}.univarse.com</span>
                                    </div>
                                </div>
                            </div>
                            <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                    <Button variant="ghost" size="icon" className="h-8 w-8 text-[#6B7C6F] hover:text-[#485550]" onClick={(e) => e.stopPropagation()}>
                                        <MoreHorizontal className="w-4 h-4" />
                                    </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end" className="w-48">
                                    {getEffectiveStatus(inst) === 'PENDING' && (
                                        <DropdownMenuItem onClick={(e) => { e.stopPropagation(); handleProvision(inst.id); }}>
                                            <Database className="w-4 h-4 mr-2" /> Provision DB
                                        </DropdownMenuItem>
                                    )}
                                    <DropdownMenuItem className="text-red-600 focus:text-red-600" onClick={(e) => e.stopPropagation()}>
                                        <Trash2 className="w-4 h-4 mr-2" /> Delete
                                    </DropdownMenuItem>
                                </DropdownMenuContent>
                            </DropdownMenu>
                        </div>

                        {/* Card Content */}
                        <div className="space-y-4 my-4">
                            <div className="grid grid-cols-2 gap-3 text-sm">
                                <div className="bg-[#F4F6F0] p-2.5 rounded-xl flex items-center gap-2 text-[#485550]">
                                    <Mail className="w-4 h-4 text-[#6B7C6F]" />
                                    <span className="truncate">{inst.email || 'N/A'}</span>
                                </div>
                                <div className="bg-[#F4F6F0] p-2.5 rounded-xl flex items-center gap-2 text-[#485550]">
                                    <Phone className="w-4 h-4 text-[#6B7C6F]" />
                                    <span className="truncate">{inst.phone || 'N/A'}</span>
                                </div>
                            </div>

                            <div className="flex items-center gap-2 text-sm text-[#6B7C6F]">
                                <MapPin className="w-4 h-4 text-[#C0EB6A]" />
                                <span className="truncate">{inst.address || 'No address provided'}</span>
                            </div>
                        </div>

                        {/* Footer & Actions */}
                        <div className="mt-auto pt-4 border-t border-[#F4F6F0] flex items-center justify-between">
                            {getStatusBadge(inst)}

                            {getEffectiveStatus(inst) === 'PENDING' && (
                                <Button
                                    size="sm"
                                    className="bg-[#C0EB6A] text-[#485550] hover:bg-[#b0d95e] font-semibold h-8 rounded-lg shadow-sm"
                                    onClick={(e) => { e.stopPropagation(); handleProvision(inst.id); }}
                                    disabled={provisioningId === inst.id}
                                >
                                    {provisioningId === inst.id ? (
                                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                    ) : (
                                        <>
                                            <Server className="w-3.5 h-3.5 mr-1.5" /> Provision
                                        </>
                                    )}
                                </Button>
                            )}
                        </div>
                    </div>
                ))}
            </div>

            {filteredInstitutions.length === 0 && !isLoading && (
                <div className="text-center py-16 rounded-[2rem] bg-white/30 border border-dashed border-[#D1DBC1]">
                    <div className="w-20 h-20 bg-[#F4F6F0] rounded-full flex items-center justify-center mx-auto mb-6 shadow-inner">
                        <Building2 className="w-10 h-10 text-[#D1DBC1]" />
                    </div>
                    <h3 className="text-[#485550] font-bold text-lg">No institutions found</h3>
                    <p className="text-[#6B7C6F]">Get started by adding a new university or college.</p>
                    <Button
                        onClick={() => setIsAddDialogOpen(true)}
                        className="btn-morph-primary shadow-lg mt-6"
                    >
                        <Plus className="w-4 h-4 mr-2" />
                        Add First Institution
                    </Button>
                </div>
            )}

            {/* Add Institution Dialog */}
            <Dialog open={isAddDialogOpen} onOpenChange={setIsAddDialogOpen}>
                <DialogContent className="sm:max-w-4xl bg-[#F4F6F0] border-white shadow-2xl rounded-[2rem] p-0 overflow-hidden">
                    <div className="grid grid-cols-1 md:grid-cols-5 h-full">
                        {/* Left Side - Visual */}
                        <div className="md:col-span-2 bg-[#E8EDE0]/50 p-8 flex flex-col justify-between border-b md:border-b-0 md:border-r border-[#D1DBC1]/50 relative overflow-hidden">
                            <div className="relative z-10">
                                <div className="p-4 bg-white rounded-2xl w-fit shadow-sm mb-6 rotate-[-6deg] transition-transform hover:rotate-[-3deg]">
                                    <div className="p-3 bg-[#C0EB6A] rounded-xl text-[#485550]">
                                        <Building2 className="w-10 h-10" />
                                    </div>
                                </div>
                                <h3 className="text-[#485550] font-bold text-xl mb-2">New Institution</h3>
                                <p className="text-[#6B7C6F] text-sm leading-relaxed">
                                    Register a new university or college. This will provision a dedicated tenant environment.
                                </p>
                            </div>

                            {/* Checklist Visual */}
                            <div className="relative z-10 space-y-3 mt-8">
                                <div className="flex items-center gap-3 text-sm text-[#485550]">
                                    <div className="w-6 h-6 rounded-full bg-[#C0EB6A]/20 flex items-center justify-center text-[#485550]">1</div>
                                    <span className="font-medium">Basic Details</span>
                                </div>
                                <div className="flex items-center gap-3 text-sm text-[#485550]">
                                    <div className="w-6 h-6 rounded-full bg-[#C0EB6A]/20 flex items-center justify-center text-[#485550]">2</div>
                                    <span className="font-medium">Subdomain Setup</span>
                                </div>
                                <div className="flex items-center gap-3 text-sm text-[#485550]">
                                    <div className="w-6 h-6 rounded-full bg-[#C0EB6A]/20 flex items-center justify-center text-[#485550]">3</div>
                                    <span className="font-medium">Database Provisioning</span>
                                </div>
                            </div>

                            {/* Decor */}
                            <div className="absolute -bottom-16 -right-16 opacity-10">
                                <Database className="w-64 h-64 text-[#485550]" />
                            </div>
                        </div>

                        {/* Right Side - Form */}
                        <div className="md:col-span-3 p-8">
                            <DialogHeader className="mb-6">
                                <DialogTitle className="text-[#485550] text-xl font-bold">Registration Details</DialogTitle>
                                <DialogDescription className="text-[#6B7C6F]">
                                    Enter the official details for the new campus.
                                </DialogDescription>
                            </DialogHeader>

                            <div className="grid gap-5">
                                <div className="grid grid-cols-2 gap-5">
                                    <div className="space-y-2">
                                        <Label htmlFor="code" className="text-[#485550] font-medium">Institution Code *</Label>
                                        <Input
                                            id="code"
                                            placeholder="e.g., UNILAG"
                                            value={formData.code}
                                            onChange={(e) => setFormData({ ...formData, code: e.target.value.toUpperCase() })}
                                            className="input-morph bg-white"
                                        />
                                    </div>
                                    <div className="space-y-2">
                                        <Label htmlFor="subdomain" className="text-[#485550] font-medium">Subdomain *</Label>
                                        <div className="flex items-center">
                                            <Input
                                                id="subdomain"
                                                placeholder="unilag"
                                                value={formData.subdomain}
                                                onChange={(e) => setFormData({ ...formData, subdomain: e.target.value.toLowerCase() })}
                                                className="input-morph bg-white rounded-r-none border-r-0"
                                            />
                                            <span className="px-3 bg-[#E8EDE0] border border-[#E8EDE0] border-l-0 rounded-r-xl text-xs text-[#485550] font-medium h-[46px] flex items-center shadow-inner whitespace-nowrap">
                                                .univarse.com
                                            </span>
                                        </div>
                                    </div>
                                </div>

                                <div className="space-y-2">
                                    <Label htmlFor="name" className="text-[#485550] font-medium">Institution Name *</Label>
                                    <Input
                                        id="name"
                                        placeholder="e.g., University of Lagos"
                                        value={formData.name}
                                        onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                                        className="input-morph bg-white"
                                    />
                                </div>

                                <div className="grid grid-cols-2 gap-5">
                                    <div className="space-y-2">
                                        <Label htmlFor="email" className="text-[#485550] font-medium">Contact Email</Label>
                                        <Input
                                            id="email"
                                            type="email"
                                            placeholder="admin@school.edu.ng"
                                            value={formData.email}
                                            onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                                            className="input-morph bg-white"
                                        />
                                    </div>
                                    <div className="space-y-2">
                                        <Label htmlFor="phone" className="text-[#485550] font-medium">Phone Number</Label>
                                        <Input
                                            id="phone"
                                            placeholder="+234..."
                                            value={formData.phone}
                                            onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                                            className="input-morph bg-white"
                                        />
                                    </div>
                                </div>

                                <div className="space-y-2">
                                    <Label htmlFor="address" className="text-[#485550] font-medium">Address</Label>
                                    <Input
                                        id="address"
                                        placeholder="Campus address"
                                        value={formData.address}
                                        onChange={(e) => setFormData({ ...formData, address: e.target.value })}
                                        className="input-morph bg-white"
                                    />
                                </div>
                            </div>

                            <DialogFooter className="mt-8 gap-3 sm:gap-0 sm:justify-between">
                                <Button
                                    variant="ghost"
                                    onClick={() => setIsAddDialogOpen(false)}
                                    disabled={isSubmitting}
                                    className="text-[#6B7C6F] hover:text-[#485550] hover:bg-[#D1DBC1]/20 rounded-xl"
                                >
                                    Cancel
                                </Button>
                                <Button
                                    onClick={handleAddInstitution}
                                    className="btn-morph-primary"
                                    disabled={isSubmitting}
                                >
                                    {isSubmitting ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Creating...</> : 'Create Institution'}
                                </Button>
                            </DialogFooter>
                        </div>
                    </div>
                </DialogContent>
            </Dialog>
        </div>
    );
}
