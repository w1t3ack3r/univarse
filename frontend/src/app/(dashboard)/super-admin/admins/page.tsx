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
    DialogTrigger,
    DialogFooter
} from '@/components/ui/dialog';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue
} from '@/components/ui/select';
import Link from 'next/link';
import {
    Plus,
    RefreshCw,
    Calendar,
    Clock,
    Loader2,
    Shield,
    Search,
    UserCheck,
    UserX,
    Mail,
    Headphones // Added icon for support role
} from 'lucide-react';
import { toast } from 'sonner';
// import { api } from '@/lib/api';

interface SuperAdmin {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
    role: 'super_admin' | 'customer_support';
    isActive: boolean;
    isPasswordUpdated: boolean;
    lastLoginAt?: string;
    createdAt: string;
}

export default function SuperAdminsPage() {
    const [admins, setAdmins] = useState<SuperAdmin[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [isDialogOpen, setIsDialogOpen] = useState(false);
    const [searchTerm, setSearchTerm] = useState('');
    const [formData, setFormData] = useState<{
        email: string;
        firstName: string;
        lastName: string;
        role: 'super_admin' | 'customer_support';
        password: string;
    }>({
        email: '',
        firstName: '',
        lastName: '',
        role: 'super_admin',
        password: '',
    });

    const fetchAdmins = async () => {
        setIsLoading(true);
        // MOCK DATA FETCH
        try {
            await new Promise(resolve => setTimeout(resolve, 800));
            setAdmins([
                { id: '1', email: 'super@univarse.com', firstName: 'Super', lastName: 'Admin', role: 'super_admin', isActive: true, isPasswordUpdated: true, createdAt: '2024-01-01T00:00:00Z', lastLoginAt: new Date().toISOString() },
                { id: '2', email: 'samuel.o@univarse.com', firstName: 'Samuel', lastName: 'Adebayo', role: 'super_admin', isActive: true, isPasswordUpdated: false, createdAt: '2024-01-20T08:00:00Z', lastLoginAt: '2024-03-11T11:00:00Z' },
            ]);
        } catch (error: any) {
            toast.error('Failed to load super admins (Mock Mode)');
        } finally {
            setIsLoading(false);
        }
    };

    useEffect(() => {
        fetchAdmins();
    }, []);

    const handleAddAdmin = async () => {
        if (!formData.email || !formData.firstName || !formData.lastName || !formData.role) {
            toast.error('Please fill in all fields');
            return;
        }

        setIsSubmitting(true);
        // MOCK CREATE
        try {
            await new Promise(resolve => setTimeout(resolve, 1500));

            const tempPassword = Math.random().toString(36).slice(-8).toUpperCase();

            const newAdmin: SuperAdmin = {
                id: Math.random().toString(36).substr(2, 9),
                email: formData.email,
                firstName: formData.firstName,
                lastName: formData.lastName,
                role: formData.role,
                isActive: true,
                isPasswordUpdated: false,
                createdAt: new Date().toISOString(),
                lastLoginAt: undefined
            };

            setAdmins([...admins, newAdmin]);
            setIsDialogOpen(false);
            setFormData({ email: '', firstName: '', lastName: '', role: 'super_admin', password: '' });

            toast.success(`Invitation Sent Successfully`, {
                description: `Invite sent to ${formData.email} as ${formData.role === 'super_admin' ? 'Super Admin' : 'Customer Support'} with temp password: ${tempPassword}`
            });
        } catch (error: any) {
            toast.error('Failed to create super admin');
        } finally {
            setIsSubmitting(false);
        }
    };

    const filteredAdmins = admins.filter(admin =>
        admin.email.toLowerCase().includes(searchTerm.toLowerCase()) ||
        admin.firstName.toLowerCase().includes(searchTerm.toLowerCase()) ||
        admin.lastName.toLowerCase().includes(searchTerm.toLowerCase())
    );

    if (isLoading) {
        return (
            <div className="flex items-center justify-center h-[calc(100vh-200px)]">
                <div className="flex flex-col items-center gap-4">
                    <Loader2 className="w-10 h-10 text-[#C0EB6A] animate-spin" />
                    <p className="text-[#6B7C6F] animate-pulse">Loading administrators...</p>
                </div>
            </div>
        );
    }

    return (
        <div className="space-y-8">
            {/* Header & Controls */}
            <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
                <div>
                    <h2 className="text-2xl font-bold text-[#485550]">Administrators</h2>
                    <p className="text-[#6B7C6F]">Manage platform access and privileges</p>
                </div>

                <div className="flex items-center gap-3 w-full md:w-auto">
                    <div className="relative flex-1 md:w-64">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#6B7C6F]" />
                        <Input
                            placeholder="Search admins..."
                            value={searchTerm}
                            onChange={(e) => setSearchTerm(e.target.value)}
                            className="pl-9 bg-white/50 border-[#D1DBC1] focus:border-[#C0EB6A] focus:ring-[#C0EB6A] rounded-xl"
                        />
                    </div>
                    <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
                        <DialogTrigger asChild>
                            <Button className="btn-morph-primary shadow-lg">
                                <Plus className="w-4 h-4 mr-2" />
                                <span className="hidden sm:inline">Add Admin</span>
                                <span className="sm:hidden">Add</span>
                            </Button>
                        </DialogTrigger>
                        <DialogContent className="sm:max-w-3xl bg-[#F4F6F0] border-white shadow-2xl rounded-[2rem] p-0 overflow-hidden">
                            <div className="grid grid-cols-1 md:grid-cols-5 h-full">
                                {/* Left Side - Visual */}
                                <div className="md:col-span-2 bg-[#E8EDE0]/50 p-8 flex flex-col items-center justify-center border-b md:border-b-0 md:border-r border-[#D1DBC1]/50">
                                    <div className="w-24 h-24 rounded-3xl bg-white shadow-sm flex items-center justify-center mb-6 rotate-3 transform transition-transform hover:rotate-6">
                                        <div className="w-20 h-20 rounded-2xl bg-[#485550] flex items-center justify-center text-white">
                                            <Shield className="w-10 h-10" />
                                        </div>
                                    </div>
                                    <div className="text-center px-4">
                                        <h3 className="text-[#485550] font-bold text-lg mb-2">Grant Access</h3>
                                        <p className="text-[#6B7C6F] text-sm">
                                            Create a new administrator account with full platform privileges.
                                        </p>
                                    </div>
                                </div>

                                {/* Right Side - Form */}
                                <div className="md:col-span-3 p-8">
                                    <DialogHeader className="mb-4">
                                        <DialogTitle className="text-[#485550] text-xl font-bold flex items-center gap-2">
                                            Add Super Admin
                                        </DialogTitle>
                                        <DialogDescription className="text-[#6B7C6F]">
                                            Enter the details for the new admin.
                                        </DialogDescription>
                                    </DialogHeader>

                                    <div className="grid gap-5">
                                        <div className="grid grid-cols-2 gap-4">
                                            <div className="space-y-2">
                                                <Label htmlFor="firstName" className="text-[#485550]">First Name</Label>
                                                <Input
                                                    id="firstName"
                                                    value={formData.firstName}
                                                    onChange={(e) => setFormData({ ...formData, firstName: e.target.value })}
                                                    className="input-morph bg-white"
                                                    placeholder="John"
                                                />
                                            </div>
                                            <div className="space-y-2">
                                                <Label htmlFor="lastName" className="text-[#485550]">Last Name</Label>
                                                <Input
                                                    id="lastName"
                                                    value={formData.lastName}
                                                    onChange={(e) => setFormData({ ...formData, lastName: e.target.value })}
                                                    className="input-morph bg-white"
                                                    placeholder="Doe"
                                                />
                                            </div>
                                        </div>

                                        <div className="space-y-2">
                                            <Label htmlFor="role" className="text-[#485550]">Role</Label>
                                            <Select
                                                value={formData.role}
                                                onValueChange={(value: 'super_admin' | 'customer_support') => setFormData({ ...formData, role: value })}
                                            >
                                                <SelectTrigger className="input-morph bg-white">
                                                    <SelectValue placeholder="Select role" />
                                                </SelectTrigger>
                                                <SelectContent>
                                                    <SelectItem value="super_admin">Super Admin</SelectItem>
                                                    <SelectItem value="customer_support">Customer Care Staff</SelectItem>
                                                </SelectContent>
                                            </Select>
                                        </div>

                                        <div className="space-y-2">
                                            <Label htmlFor="email" className="text-[#485550]">Email Address</Label>
                                            <Input
                                                id="email"
                                                type="email"
                                                value={formData.email}
                                                onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                                                className="input-morph bg-white"
                                                placeholder="john.doe@univarse.com"
                                            />
                                        </div>
                                        <div className="p-4 bg-blue-50 text-blue-700 rounded-xl text-sm flex gap-3 items-start border border-blue-100">
                                            <Mail className="w-5 h-5 shrink-0 mt-0.5" />
                                            <div>
                                                <p className="opacity-90">
                                                    A secure temporary password will be generated and emailed to the user automatically.
                                                </p>
                                            </div>
                                        </div>
                                    </div>

                                    <DialogFooter className="mt-8 gap-2 sm:justify-between">
                                        <Button variant="ghost" onClick={() => setIsDialogOpen(false)} disabled={isSubmitting} className="text-[#6B7C6F] hover:text-[#485550]">Cancel</Button>
                                        <Button onClick={handleAddAdmin} className="btn-morph-primary" disabled={isSubmitting}>
                                            {isSubmitting ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Sending Invite...</> : 'Create & Invite'}
                                        </Button>
                                    </DialogFooter>
                                </div>
                            </div>
                        </DialogContent>
                    </Dialog>
                </div>
            </div>

            {/* Admins Grid */}
            <div className="grid md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
                {filteredAdmins.map((admin) => (
                    <Link href={`/super-admin/admins/${admin.id}`} key={admin.id} className="block">
                        <div className="morph-card p-6 flex flex-col group hover:shadow-xl transition-all duration-300 border border-transparent hover:border-[#D1DBC1] h-full">
                            <div className="flex justify-between items-start mb-4">
                                <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-[#485550] to-[#2A302D] flex items-center justify-center shadow-lg group-hover:scale-105 transition-transform duration-300">
                                    <span className="text-white font-bold text-lg">
                                        {admin.firstName[0]}{admin.lastName[0]}
                                    </span>
                                </div>
                                <div className="flex flex-col items-end gap-1">
                                    {admin.isActive ? (
                                        <Badge className="bg-green-100 text-green-700 hover:bg-green-200 border-0 flex items-center gap-1 px-2.5 py-0.5">
                                            <UserCheck className="w-3 h-3" /> Active
                                        </Badge>
                                    ) : (
                                        <Badge className="bg-red-100 text-red-700 hover:bg-red-200 border-0 flex items-center gap-1 px-2.5 py-0.5">
                                            <UserX className="w-3 h-3" /> Inactive
                                        </Badge>
                                    )}
                                </div>
                            </div>

                            <div className="mb-4">
                                <h3 className="font-bold text-[#485550] text-lg mb-2">{admin.firstName} {admin.lastName}</h3>
                                <div className="flex flex-col gap-2">
                                    <div className="flex items-center gap-2 text-sm text-[#6B7C6F] bg-[#F4F6F0] p-2 rounded-lg break-all">
                                        <Mail className="w-3 h-3 shrink-0" />
                                        {admin.email}
                                    </div>
                                    <div className="flex items-center gap-2 text-sm text-[#6B7C6F] bg-[#F4F6F0] p-2 rounded-lg">
                                        {admin.role === 'super_admin' ? <Shield className="w-3 h-3 shrink-0" /> : <Headphones className="w-3 h-3 shrink-0" />}
                                        <span className="capitalize">{admin.role.replace('_', ' ')}</span>
                                    </div>
                                </div>
                            </div>

                            <div className="mt-auto space-y-3 pt-4 border-t border-[#F4F6F0]">
                                <div className="flex items-center justify-between text-xs text-[#6B7C6F]">
                                    <div className="flex items-center gap-1.5">
                                        <Calendar className="w-3.5 h-3.5 text-[#C0EB6A]" />
                                        <span>Joined</span>
                                    </div>
                                    <span className="font-medium">{new Date(admin.createdAt).toLocaleDateString()}</span>
                                </div>
                                <div className="flex items-center justify-between text-xs text-[#6B7C6F]">
                                    <div className="flex items-center gap-1.5">
                                        <Clock className="w-3.5 h-3.5 text-[#C0EB6A]" />
                                        <span>Last Login</span>
                                    </div>
                                    <span className="font-medium">{admin.lastLoginAt ? new Date(admin.lastLoginAt).toLocaleDateString() : 'Never'}</span>
                                </div>
                            </div>
                        </div>
                    </Link>
                ))}
            </div>

            {filteredAdmins.length === 0 && !isLoading && (
                <div className="text-center py-12 rounded-2xl bg-white/30 border border-dashed border-[#D1DBC1]">
                    <div className="w-16 h-16 bg-[#F4F6F0] rounded-full flex items-center justify-center mx-auto mb-4">
                        <Shield className="w-8 h-8 text-[#D1DBC1]" />
                    </div>
                    <h3 className="text-[#485550] font-semibold">No administrators found</h3>
                    <p className="text-[#6B7C6F] text-sm">Try adjusting your search terms</p>
                </div>
            )}
        </div>
    );
}
