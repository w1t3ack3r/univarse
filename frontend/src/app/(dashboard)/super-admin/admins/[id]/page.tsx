'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
    ChevronLeft,
    Shield,
    Mail,
    Calendar,
    Clock,
    UserCheck,
    UserX,
    Lock,
    Headphones,
    AlertCircle,
    CheckCircle2
} from 'lucide-react';
import { Loader2 } from 'lucide-react';

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

export default function AdminDetailPage() {
    const params = useParams();
    const [admin, setAdmin] = useState<SuperAdmin | null>(null);
    const [isLoading, setIsLoading] = useState(true);

    useEffect(() => {
        const fetchAdmin = async () => {
            setIsLoading(true);
            // MOCK FETCH
            await new Promise(resolve => setTimeout(resolve, 800));
            // Find the admin from the same mock data as the list page
            const mockAdmins: SuperAdmin[] = [
                { id: '1', email: 'super@univarse.com', firstName: 'Super', lastName: 'Admin', role: 'super_admin', isActive: true, isPasswordUpdated: true, createdAt: '2024-01-01T00:00:00Z', lastLoginAt: new Date().toISOString() },
                { id: '2', email: 'samuel.o@univarse.com', firstName: 'Samuel', lastName: 'Olubayo', role: 'super_admin', isActive: true, isPasswordUpdated: false, createdAt: '2024-01-20T08:00:00Z', lastLoginAt: '2024-03-11T11:00:00Z' },
            ];
            const found = mockAdmins.find(a => a.id === params.id);
            setAdmin(found || null);
            setIsLoading(false);
        };

        if (params.id) {
            fetchAdmin();
        }
    }, [params.id]);

    if (isLoading) {
        return (
            <div className="flex items-center justify-center h-[calc(100vh-200px)]">
                <div className="flex flex-col items-center gap-4">
                    <Loader2 className="w-10 h-10 text-[#C0EB6A] animate-spin" />
                    <p className="text-[#6B7C6F] animate-pulse">Loading admin details...</p>
                </div>
            </div>
        );
    }

    if (!admin) {
        return (
            <div className="flex flex-col items-center justify-center h-[calc(100vh-200px)] gap-4">
                <p className="text-[#6B7C6F]">Admin not found</p>
                <Link href="/super-admin/admins">
                    <Button variant="outline">Back to Admins</Button>
                </Link>
            </div>
        );
    }

    return (
        <div className="space-y-6">
            {/* Header */}
            <div>
                <Link href="/super-admin/admins" className="inline-flex items-center text-[#6B7C6F] hover:text-[#485550] mb-6 transition-colors">
                    <ChevronLeft className="w-4 h-4 mr-1" />
                    Back to Administrators
                </Link>
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                    <div className="flex items-center gap-4">
                        <div className="w-20 h-20 rounded-3xl bg-gradient-to-br from-[#485550] to-[#2A302D] flex items-center justify-center shadow-lg">
                            <span className="text-white font-bold text-3xl">
                                {admin.firstName[0]}{admin.lastName[0]}
                            </span>
                        </div>
                        <div>
                            <h1 className="text-3xl font-bold text-[#485550]">{admin.firstName} {admin.lastName}</h1>
                            <div className="flex items-center gap-2 text-[#6B7C6F] mt-1">
                                <Mail className="w-4 h-4" />
                                <span>{admin.email}</span>
                            </div>
                        </div>
                    </div>
                    <div className="flex gap-3">
                        {admin.isActive ? (
                            <Badge className="bg-green-100 text-green-700 hover:bg-green-200 border-0 flex items-center gap-1.5 px-4 py-1.5 text-sm h-auto">
                                <UserCheck className="w-4 h-4" /> Active Account
                            </Badge>
                        ) : (
                            <Badge className="bg-red-100 text-red-700 hover:bg-red-200 border-0 flex items-center gap-1.5 px-4 py-1.5 text-sm h-auto">
                                <UserX className="w-4 h-4" /> Inactive Account
                            </Badge>
                        )}
                    </div>
                </div>
            </div>

            <div className="grid md:grid-cols-2 gap-6">
                {/* Role & Permissions Card */}
                <Card className="border-none shadow-lg bg-white/50 backdrop-blur-sm">
                    <CardHeader>
                        <CardTitle className="text-[#485550] flex items-center gap-2">
                            <Shield className="w-5 h-5" />
                            Role & Access
                        </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-6">
                        <div className="p-4 bg-[#F4F6F0] rounded-2xl border border-[#D1DBC1]">
                            <div className="flex items-center gap-3 mb-2">
                                {admin.role === 'super_admin' ? (
                                    <div className="w-10 h-10 rounded-full bg-[#485550] flex items-center justify-center text-white">
                                        <Shield className="w-5 h-5" />
                                    </div>
                                ) : (
                                    <div className="w-10 h-10 rounded-full bg-[#C0EB6A] flex items-center justify-center text-[#485550]">
                                        <Headphones className="w-5 h-5" />
                                    </div>
                                )}
                                <div>
                                    <h3 className="font-bold text-[#485550] capitalize">{admin.role.replace('_', ' ')}</h3>
                                    <p className="text-xs text-[#6B7C6F]">Current Role</p>
                                </div>
                            </div>
                            <p className="text-sm text-[#6B7C6F] leading-relaxed">
                                {admin.role === 'super_admin'
                                    ? 'Has full access to all system modules, including user management, financial records, and system settings.'
                                    : 'Has access to customer support tickets, user inquiries, and basic user management features.'}
                            </p>
                        </div>
                    </CardContent>
                </Card>

                {/* Security & Activity Card */}
                <Card className="border-none shadow-lg bg-white/50 backdrop-blur-sm">
                    <CardHeader>
                        <CardTitle className="text-[#485550] flex items-center gap-2">
                            <Lock className="w-5 h-5" />
                            Security & Activity
                        </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-6">
                        {/* Password Status */}
                        <div className={`p-4 rounded-2xl border flex items-start gap-3 ${admin.isPasswordUpdated ? 'bg-green-50 border-green-100' : 'bg-amber-50 border-amber-100'}`}>
                            {admin.isPasswordUpdated ? (
                                <CheckCircle2 className="w-5 h-5 text-green-600 shrink-0 mt-0.5" />
                            ) : (
                                <AlertCircle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
                            )}
                            <div>
                                <h3 className={`font-bold ${admin.isPasswordUpdated ? 'text-green-800' : 'text-amber-800'}`}>
                                    {admin.isPasswordUpdated ? 'Password Updated' : 'Temporary Password'}
                                </h3>
                                <p className={`text-sm mt-1 ${admin.isPasswordUpdated ? 'text-green-700' : 'text-amber-700'}`}>
                                    {admin.isPasswordUpdated
                                        ? 'User has changed their temporary password.'
                                        : 'User is still using the initial temporary password.'}
                                </p>
                            </div>
                        </div>

                        {/* Timestamps */}
                        <div className="space-y-4 pt-2">
                            <div className="flex items-center justify-between p-3 bg-white rounded-xl border border-[#F4F6F0]">
                                <div className="flex items-center gap-2 text-[#6B7C6F]">
                                    <Calendar className="w-4 h-4" />
                                    <span className="text-sm">Account Created</span>
                                </div>
                                <span className="font-medium text-[#485550]">{new Date(admin.createdAt).toLocaleDateString()}</span>
                            </div>
                            <div className="flex items-center justify-between p-3 bg-white rounded-xl border border-[#F4F6F0]">
                                <div className="flex items-center gap-2 text-[#6B7C6F]">
                                    <Clock className="w-4 h-4" />
                                    <span className="text-sm">Last Login</span>
                                </div>
                                <span className="font-medium text-[#485550]">
                                    {admin.lastLoginAt ? new Date(admin.lastLoginAt).toLocaleString() : 'Never'}
                                </span>
                            </div>
                        </div>
                    </CardContent>
                </Card>
            </div>
        </div>
    );
}
