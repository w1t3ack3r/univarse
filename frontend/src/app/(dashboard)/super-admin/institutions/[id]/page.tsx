'use client';

import { useState, useEffect, use } from 'react';
import {
    ArrowLeft,
    Building2,
    Globe,
    MoreVertical,
    Power,
    ShieldAlert,
    Users,
    Database,
    HardDrive,
    ExternalLink,
    CheckCircle2,
    XCircle,
    Loader2,
    LogIn,
    RefreshCw,
    Undo2,
    CreditCard,
    FileText,
    Settings,
    Mail,
    Phone,
    MapPin,
    Search,
    GraduationCap,
    BookOpen,
    Calendar,
    Award
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';
import { useRouter } from 'next/navigation';

// Mock Data Types
type InstitutionStatus = 'ACTIVE' | 'SUSPENDED' | 'PROVISIONING' | 'MAINTENANCE';

interface Programme {
    id: string;
    name: string;
    faculty: string;
    studentsEnrolled: number;
    duration: string;
    level: 'B.Sc' | 'M.Sc' | 'Ph.D' | 'ND' | 'HND' | 'Diploma';
}

interface InstitutionDetail {
    id: string;
    name: string;
    code: string;
    domain: string;
    logo: string; // url or placeholder
    status: InstitutionStatus;
    plan: 'FREE' | 'BASIC' | 'PREMIUM' | 'ENTERPRISE';
    about: {
        description: string;
        foundedYear: number;
        accreditation: string;
        type: 'Public' | 'Private' | 'Polytechnic' | 'University';
    };
    contact: {
        email: string;
        phone: string;
        address: string;
        website: string;
    };
    stats: {
        students: number;
        staff: number;
        storageUsed: number; // in GB
        storageLimit: number; // in GB
        activeCourses: number;
        totalProgrammes: number;
    };
    modules: {
        lms: boolean;
        videoConferencing: boolean;
        aiTutor: boolean;
        library: boolean;
        analytics: boolean;
        payments: boolean;
    };
    subscription: {
        status: 'ACTIVE' | 'PAST_DUE' | 'CANCELLED';
        nextBillingDate: string;
        amount: number;
        currency: string;
    };
    admins: {
        id: string;
        name: string;
        email: string;
        role: 'SUPER_ADMIN' | 'ADMIN' | 'SUPPORT';
        lastLogin: string;
        status: 'ACTIVE' | 'LOCKED';
    }[];
    programmes: Programme[];
}

// Mock Data Store
const MOCK_DB: Record<string, InstitutionDetail> = {
    '1': {
        id: '1',
        name: 'Universal Tech Institute',
        code: 'UNIV',
        domain: 'universal.univarse.com',
        logo: '',
        status: 'ACTIVE',
        plan: 'ENTERPRISE',
        about: {
            description: 'A premier technological institution dedicated to fostering innovation and excellence in digital sciences. Known for its cutting-edge research facilities and industry partnerships.',
            foundedYear: 1998,
            accreditation: 'NUC Accredited (Grade A)',
            type: 'Private'
        },
        contact: {
            email: 'admin@universal.edu',
            phone: '+234 801 234 5678',
            address: '123 Tech Avenue, Lagos, Nigeria',
            website: 'https://universal.edu',
        },
        stats: {
            students: 12500,
            staff: 850,
            storageUsed: 450,
            storageLimit: 1000,
            activeCourses: 342,
            totalProgrammes: 45
        },
        modules: {
            lms: true,
            videoConferencing: true,
            aiTutor: true,
            library: true,
            analytics: true,
            payments: true,
        },
        subscription: {
            status: 'ACTIVE',
            nextBillingDate: '2026-03-01',
            amount: 2500,
            currency: 'USD',
        },
        admins: [
            { id: 'a1', name: 'Dr. Sarah Johnson', email: 's.johnson@universal.edu', role: 'SUPER_ADMIN', lastLogin: '2026-01-30T09:45:00Z', status: 'ACTIVE' },
            { id: 'a2', name: 'IT Support', email: 'it@universal.edu', role: 'SUPPORT', lastLogin: '2026-01-29T14:20:00Z', status: 'ACTIVE' },
        ],
        programmes: [
            { id: 'p1', name: 'Computer Science', faculty: 'Science', studentsEnrolled: 1200, duration: '4 Years', level: 'B.Sc' },
            { id: 'p2', name: 'Software Engineering', faculty: 'Engineering', studentsEnrolled: 850, duration: '5 Years', level: 'B.Sc' },
            { id: 'p3', name: 'Data Science', faculty: 'Science', studentsEnrolled: 400, duration: '2 Years', level: 'M.Sc' },
            { id: 'p4', name: 'Cybersecurity', faculty: 'Science', studentsEnrolled: 600, duration: '4 Years', level: 'B.Sc' },
            { id: 'p5', name: 'Information Technology', faculty: 'Science', studentsEnrolled: 1500, duration: '4 Years', level: 'B.Sc' },
        ]
    },
    '2': {
        id: '2',
        name: 'Cyber Academy',
        code: 'CYBER',
        domain: 'cyber.univarse.com',
        logo: '',
        status: 'ACTIVE',
        plan: 'PREMIUM',
        about: {
            description: 'A specialized security training center focused on defensive and offensive cyber operations. Training the next generation of digital defenders.',
            foundedYear: 2015,
            accreditation: 'NBTE Accredited',
            type: 'Private'
        },
        contact: {
            email: 'contact@cyber.academy',
            phone: '+234 809 999 8888',
            address: '45 Digital Way, Abuja, Nigeria',
            website: 'https://cyber.academy',
        },
        stats: {
            students: 3200,
            staff: 150,
            storageUsed: 120,
            storageLimit: 500,
            activeCourses: 85,
            totalProgrammes: 12
        },
        modules: {
            lms: true,
            videoConferencing: true,
            aiTutor: false,
            library: true,
            analytics: true,
            payments: false,
        },
        subscription: {
            status: 'ACTIVE',
            nextBillingDate: '2026-02-15',
            amount: 800,
            currency: 'USD',
        },
        admins: [
            { id: 'a3', name: 'Alex Cyber', email: 'alex@cyber.academy', role: 'SUPER_ADMIN', lastLogin: '2026-01-31T08:00:00Z', status: 'ACTIVE' },
        ],
        programmes: [
            { id: 'p1', name: 'Ethical Hacking', faculty: 'Security', studentsEnrolled: 800, duration: '2 Years', level: 'Diploma' },
            { id: 'p2', name: 'Network Security', faculty: 'Security', studentsEnrolled: 600, duration: '2 Years', level: 'Diploma' },
        ]
    }
};

export default function InstitutionDetailsPage({ params }: { params: Promise<{ id: string }> }) {
    // Unwrapping params using React.use for Next.js 15+ compatibility
    const { id } = use(params);
    const router = useRouter();

    const [isLoading, setIsLoading] = useState(true);
    const [institution, setInstitution] = useState<InstitutionDetail | null>(null);
    const [isImpersonating, setIsImpersonating] = useState(false);

    // Fetch Logic
    useEffect(() => {
        const fetchInstitution = async () => {
            try {
                // Mock Network Delay
                await new Promise(resolve => setTimeout(resolve, 800));

                const data = MOCK_DB[id];
                if (data) {
                    setInstitution(data);
                } else {
                    toast.error('Institution not found');
                }
            } catch (error) {
                console.error("Failed to fetch institution", error);
                toast.error("Failed to load institution details");
            } finally {
                setIsLoading(false);
            }
        };

        fetchInstitution();
    }, [id, router]);

    // Actions
    const handleImpersonate = async () => {
        setIsImpersonating(true);
        // Mock Impersonation
        setTimeout(() => {
            setIsImpersonating(false);
            toast.success(`Logged in as Admin for ${institution?.name}`, {
                description: "You are now viewing the portal as an Institution Admin."
            });
        }, 1500);
    };

    const handleModuleToggle = async (moduleKey: keyof InstitutionDetail['modules']) => {
        if (!institution) return;

        // Optimistic Update
        const updatedModules = { ...institution.modules, [moduleKey]: !institution.modules[moduleKey] };
        setInstitution({ ...institution, modules: updatedModules });

        // Mock Save
        toast.success(`Module ${moduleKey} ${updatedModules[moduleKey] ? 'enabled' : 'disabled'}`);
    };

    const handleSuspend = () => {
        if (!institution) return;

        const newStatus = institution.status === 'ACTIVE' ? 'SUSPENDED' : 'ACTIVE';
        setInstitution({ ...institution, status: newStatus });

        if (newStatus === 'SUSPENDED') {
            toast.warning(`${institution.name} has been suspended.`);
        } else {
            toast.success(`${institution.name} has been reactivated.`);
        }
    };

    if (isLoading) {
        return (
            <div className="flex items-center justify-center h-[calc(100vh-100px)]">
                <div className="flex flex-col items-center gap-4">
                    <Loader2 className="w-10 h-10 text-[#C0EB6A] animate-spin" />
                    <p className="text-[#6B7C6F] animate-pulse">Loading institution details...</p>
                </div>
            </div>
        );
    }

    if (!institution) {
        return (
            <div className="flex flex-col items-center justify-center h-[60vh] text-center">
                <Building2 className="w-16 h-16 text-gray-300 mb-4" />
                <h2 className="text-xl font-bold text-[#485550]">Institution Not Found</h2>
                <p className="text-[#6B7C6F] mb-6">The institution you are looking for does not exist or has been deleted.</p>
                <Button onClick={() => router.back()} variant="outline" className="btn-morph bg-white">
                    <ArrowLeft className="w-4 h-4 mr-2" />
                    Back to Institutions
                </Button>
            </div>
        );
    }

    return (
        <div className="space-y-6">
            {/* Top Navigation */}
            <div>
                <Button variant="ghost" className="mb-4 text-[#6B7C6F] hover:text-[#485550] px-0 hover:bg-transparent" onClick={() => router.back()}>
                    <ArrowLeft className="w-4 h-4 mr-2" />
                    Back to Institutions
                </Button>
            </div>

            {/* Header Card */}
            <div className="morph-card p-6">
                <div className="flex flex-col md:flex-row md:items-start justify-between gap-6">
                    <div className="flex items-start gap-5">
                        <div className="w-20 h-20 rounded-2xl bg-gradient-to-br from-[#C0EB6A] to-[#A0D850] flex items-center justify-center text-[#485550] shadow-md shrink-0">
                            <span className="text-3xl font-bold">{institution.code.substring(0, 2)}</span>
                        </div>
                        <div>
                            <div className="flex items-center gap-3">
                                <h1 className="text-3xl font-bold text-[#485550]">{institution.name}</h1>
                                <Badge className={`
                                    ${institution.status === 'ACTIVE' ? 'bg-green-100 text-green-700' : ''}
                                    ${institution.status === 'SUSPENDED' ? 'bg-red-100 text-red-700' : ''}
                                    ${institution.status === 'PROVISIONING' ? 'bg-blue-100 text-blue-700' : ''}
                                    ${institution.status === 'MAINTENANCE' ? 'bg-amber-100 text-amber-700' : ''}
                                `}>
                                    {institution.status}
                                </Badge>
                                <Badge variant="outline" className="border-[#C0EB6A] text-[#485550]">
                                    {institution.plan} PLAN
                                </Badge>
                            </div>
                            <div className="flex flex-col sm:flex-row gap-2 sm:gap-6 mt-2 text-[#6B7C6F] text-sm font-medium">
                                <div className="flex items-center gap-1.5">
                                    <Globe className="w-4 h-4" />
                                    <a href={`https://${institution.domain}`} target="_blank" rel="noreferrer" className="hover:underline hover:text-[#485550]">
                                        {institution.domain}
                                    </a>
                                </div>
                                <div className="flex items-center gap-1.5">
                                    <Building2 className="w-4 h-4" />
                                    {institution.code}
                                </div>
                                <div className="flex items-center gap-1.5">
                                    <Users className="w-4 h-4" />
                                    {institution.stats.students.toLocaleString()} Students
                                </div>
                            </div>
                        </div>
                    </div>

                    <div className="flex flex-wrap gap-3">
                        <Button
                            onClick={handleImpersonate}
                            disabled={isImpersonating || institution.status === 'SUSPENDED'}
                            className="bg-[#485550] hover:bg-[#3a4440] text-white shadow-lg shadow-[#485550]/20 min-w-[160px]"
                        >
                            {isImpersonating ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <LogIn className="w-4 h-4 mr-2" />}
                            Login as Admin
                        </Button>

                        <div className="flex gap-2">
                            <Button
                                variant="outline"
                                onClick={handleSuspend}
                                className={`btn-morph bg-white border-red-100 hover:bg-red-50 hover:text-red-600 ${institution.status === 'SUSPENDED' ? 'text-red-600' : 'text-[#6B7C6F]'}`}
                            >
                                {institution.status === 'SUSPENDED' ? <RefreshCw className="w-4 h-4 mr-2" /> : <Power className="w-4 h-4 mr-2" />}
                                {institution.status === 'SUSPENDED' ? 'Reactivate' : 'Suspend'}
                            </Button>
                        </div>
                    </div>
                </div>
            </div>

            {/* Content Tabs */}
            <Tabs defaultValue="overview" className="space-y-6">
                <TabsList className="bg-transparent p-0 gap-6 border-b border-[#D1DBC1] w-full justify-start rounded-none h-auto overflow-x-auto">
                    {['overview', 'programmes', 'configuration', 'subscription', 'admins'].map((tab) => (
                        <TabsTrigger
                            key={tab}
                            value={tab}
                            className="rounded-none border-b-2 border-transparent data-[state=active]:border-[#C0EB6A] data-[state=active]:bg-transparent data-[state=active]:text-[#485550] text-[#6B7C6F] px-2 py-3 capitalize font-semibold shadow-none transition-all hover:text-[#485550]"
                        >
                            {tab}
                        </TabsTrigger>
                    ))}
                </TabsList>

                {/* OVERVIEW TAB */}
                <TabsContent value="overview" className="space-y-6 animate-in slide-in-from-bottom-2 duration-300">
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
                        <div className="p-5 rounded-2xl bg-white border border-[#F4F6F0] shadow-sm">
                            <h3 className="text-sm font-bold text-[#6B7C6F] mb-2 uppercase tracking-wider">Total Students</h3>
                            <div className="flex items-end justify-between">
                                <span className="text-3xl font-bold text-[#485550]">{institution.stats.students.toLocaleString()}</span>
                                <div className="p-2 bg-blue-50 text-blue-600 rounded-lg"><Users className="w-5 h-5" /></div>
                            </div>
                        </div>
                        <div className="p-5 rounded-2xl bg-white border border-[#F4F6F0] shadow-sm">
                            <h3 className="text-sm font-bold text-[#6B7C6F] mb-2 uppercase tracking-wider">Storage Used</h3>
                            <div className="flex items-end justify-between">
                                <div>
                                    <span className="text-3xl font-bold text-[#485550]">{institution.stats.storageUsed} <span className="text-lg text-[#6B7C6F]">GB</span></span>
                                    <p className="text-xs text-[#6B7C6F] mt-1">of {institution.stats.storageLimit} GB Limit</p>
                                </div>
                                <div className="p-2 bg-purple-50 text-purple-600 rounded-lg"><HardDrive className="w-5 h-5" /></div>
                            </div>
                            <div className="mt-3 h-2 w-full bg-[#F4F6F0] rounded-full overflow-hidden">
                                <div className="h-full bg-purple-500 rounded-full" style={{ width: `${(institution.stats.storageUsed / institution.stats.storageLimit) * 100}%` }}></div>
                            </div>
                        </div>
                        <div className="p-5 rounded-2xl bg-white border border-[#F4F6F0] shadow-sm">
                            <h3 className="text-sm font-bold text-[#6B7C6F] mb-2 uppercase tracking-wider">Active Courses</h3>
                            <div className="flex items-end justify-between">
                                <span className="text-3xl font-bold text-[#485550]">{institution.stats.activeCourses}</span>
                                <div className="p-2 bg-amber-50 text-amber-600 rounded-lg"><Database className="w-5 h-5" /></div>
                            </div>
                        </div>
                        <div className="p-5 rounded-2xl bg-white border border-[#F4F6F0] shadow-sm">
                            <h3 className="text-sm font-bold text-[#6B7C6F] mb-2 uppercase tracking-wider">Programmes</h3>
                            <div className="flex items-end justify-between">
                                <span className="text-3xl font-bold text-[#485550]">{institution.stats.totalProgrammes}</span>
                                <div className="p-2 bg-green-50 text-green-600 rounded-lg"><GraduationCap className="w-5 h-5" /></div>
                            </div>
                        </div>
                    </div>

                    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                        {/* Profile & About Info Card (Enhanced) */}
                        <div className="lg:col-span-2 morph-card p-6">
                            <h3 className="text-lg font-bold text-[#485550] mb-4 flex items-center gap-2">
                                <Building2 className="w-5 h-5 text-[#C0EB6A]" />
                                Institution Profile
                            </h3>
                            <div className="bg-[#F4F6F0]/50 p-6 rounded-xl border border-[#D1DBC1] mb-6">
                                <p className="text-[#485550] leading-relaxed">
                                    {institution.about.description}
                                </p>
                            </div>
                            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                                <div className="flex items-center gap-3">
                                    <div className="p-3 bg-white rounded-xl shadow-sm border border-[#F4F6F0]">
                                        <Calendar className="w-5 h-5 text-[#6B7C6F]" />
                                    </div>
                                    <div>
                                        <p className="text-xs text-[#6B7C6F] font-bold uppercase">Founded</p>
                                        <p className="text-[#485550] font-bold">{institution.about.foundedYear}</p>
                                    </div>
                                </div>
                                <div className="flex items-center gap-3">
                                    <div className="p-3 bg-white rounded-xl shadow-sm border border-[#F4F6F0]">
                                        <Award className="w-5 h-5 text-[#6B7C6F]" />
                                    </div>
                                    <div>
                                        <p className="text-xs text-[#6B7C6F] font-bold uppercase">Accreditation</p>
                                        <p className="text-[#485550] font-bold">{institution.about.accreditation}</p>
                                    </div>
                                </div>
                                <div className="flex items-center gap-3">
                                    <div className="p-3 bg-white rounded-xl shadow-sm border border-[#F4F6F0]">
                                        <Building2 className="w-5 h-5 text-[#6B7C6F]" />
                                    </div>
                                    <div>
                                        <p className="text-xs text-[#6B7C6F] font-bold uppercase">Type</p>
                                        <p className="text-[#485550] font-bold">{institution.about.type}</p>
                                    </div>
                                </div>
                            </div>
                        </div>

                        {/* Contact Info Card */}
                        <div className="morph-card p-6">
                            <h3 className="text-lg font-bold text-[#485550] mb-4 flex items-center gap-2">
                                <MapPin className="w-5 h-5 text-[#C0EB6A]" />
                                Contact Information
                            </h3>
                            <div className="space-y-4">
                                <div className="flex items-start gap-3 p-3 bg-white rounded-xl border border-[#F4F6F0]">
                                    <Mail className="w-5 h-5 text-[#6B7C6F] mt-0.5" />
                                    <div>
                                        <p className="text-xs text-[#6B7C6F] font-bold uppercase">Primary Email</p>
                                        <p className="text-[#485550] font-medium">{institution.contact.email}</p>
                                    </div>
                                </div>
                                <div className="flex items-start gap-3 p-3 bg-white rounded-xl border border-[#F4F6F0]">
                                    <Phone className="w-5 h-5 text-[#6B7C6F] mt-0.5" />
                                    <div>
                                        <p className="text-xs text-[#6B7C6F] font-bold uppercase">Phone Number</p>
                                        <p className="text-[#485550] font-medium">{institution.contact.phone}</p>
                                    </div>
                                </div>
                                <div className="flex items-start gap-3 p-3 bg-white rounded-xl border border-[#F4F6F0]">
                                    <MapPin className="w-5 h-5 text-[#6B7C6F] mt-0.5" />
                                    <div>
                                        <p className="text-xs text-[#6B7C6F] font-bold uppercase">Physical Address</p>
                                        <p className="text-[#485550] font-medium">{institution.contact.address}</p>
                                    </div>
                                </div>
                                <div className="flex items-start gap-3 p-3 bg-white rounded-xl border border-[#F4F6F0]">
                                    <Globe className="w-5 h-5 text-[#6B7C6F] mt-0.5" />
                                    <div>
                                        <p className="text-xs text-[#6B7C6F] font-bold uppercase">Website</p>
                                        <a href={institution.contact.website} target="_blank" className="text-blue-600 hover:underline font-medium break-all">{institution.contact.website}</a>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </TabsContent>

                {/* PROGRAMMES TAB */}
                <TabsContent value="programmes" className="space-y-6 animate-in slide-in-from-bottom-2 duration-300">
                    <div className="morph-card overflow-hidden">
                        <div className="flex flex-col md:flex-row items-center justify-between p-6 pb-0 mb-4 gap-4">
                            <h3 className="text-lg font-bold text-[#485550] flex items-center gap-2">
                                <BookOpen className="w-5 h-5 text-[#C0EB6A]" />
                                Academic Programmes
                            </h3>
                            <div className="flex gap-2 w-full md:w-auto">
                                <div className="relative flex-1 md:w-64">
                                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                                    <Input placeholder="Search programmes..." className="pl-10 bg-[#F4F6F0] border-transparent focus:bg-white" />
                                </div>
                                <Button className="btn-morph-primary">Add Programme</Button>
                            </div>
                        </div>

                        <div className="overflow-x-auto">
                            <table className="w-full">
                                <thead className="bg-[#F4F6F0]">
                                    <tr>
                                        <th className="px-6 py-4 text-left text-xs font-bold text-[#6B7C6F] uppercase tracking-wider">Programme Name</th>
                                        <th className="px-6 py-4 text-left text-xs font-bold text-[#6B7C6F] uppercase tracking-wider">Faculty/Dept</th>
                                        <th className="px-6 py-4 text-left text-xs font-bold text-[#6B7C6F] uppercase tracking-wider">Level</th>
                                        <th className="px-6 py-4 text-left text-xs font-bold text-[#6B7C6F] uppercase tracking-wider">Students</th>
                                        <th className="px-6 py-4 text-left text-xs font-bold text-[#6B7C6F] uppercase tracking-wider">Duration</th>
                                        <th className="px-6 py-4 text-right text-xs font-bold text-[#6B7C6F] uppercase tracking-wider">Actions</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-[#F4F6F0]">
                                    {institution.programmes.map((prog) => (
                                        <tr key={prog.id} className="hover:bg-[#F4F6F0]/50 transition-colors">
                                            <td className="px-6 py-4 whitespace-nowrap">
                                                <div className="font-bold text-[#485550]">{prog.name}</div>
                                            </td>
                                            <td className="px-6 py-4 whitespace-nowrap text-[#6B7C6F]">
                                                {prog.faculty}
                                            </td>
                                            <td className="px-6 py-4 whitespace-nowrap">
                                                <Badge variant="outline" className="border-[#C0EB6A] text-[#485550] bg-[#C0EB6A]/10">
                                                    {prog.level}
                                                </Badge>
                                            </td>
                                            <td className="px-6 py-4 whitespace-nowrap font-medium text-[#485550]">
                                                {prog.studentsEnrolled.toLocaleString()}
                                            </td>
                                            <td className="px-6 py-4 whitespace-nowrap text-[#6B7C6F]">
                                                {prog.duration}
                                            </td>
                                            <td className="px-6 py-4 whitespace-nowrap text-right">
                                                <Button variant="ghost" size="icon" className="text-[#6B7C6F] hover:text-[#485550]">
                                                    <MoreVertical className="w-4 h-4" />
                                                </Button>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                        {institution.programmes.length === 0 && (
                            <div className="p-12 text-center text-[#6B7C6F]">
                                <BookOpen className="w-12 h-12 mx-auto mb-4 opacity-20" />
                                <p>No programmes listed for this institution yet.</p>
                            </div>
                        )}
                    </div>
                </TabsContent>

                {/* CONFIGURATION TAB */}
                <TabsContent value="configuration" className="space-y-6 animate-in slide-in-from-bottom-2 duration-300">
                    <div className="bg-[#485550] text-white p-6 rounded-2xl shadow-lg mb-6">
                        <div className="flex items-start justify-between">
                            <div>
                                <h3 className="text-xl font-bold">Feature Modules</h3>
                                <p className="text-[#C0EB6A]/80 max-w-2xl mt-1">
                                    Enable or disable specific modules for this institution. Disabling a module hides it from all users in their tenant immediately.
                                </p>
                            </div>
                            <Settings className="w-10 h-10 text-[#C0EB6A] opacity-50" />
                        </div>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                        {Object.entries(institution.modules).map(([key, isEnabled]) => (
                            <div key={key} className={`morph-card p-5 transition-all hover:shadow-md ${!isEnabled ? 'opacity-80' : ''}`}>
                                <div className="flex items-center justify-between mb-3">
                                    <div className={`p-3 rounded-xl ${isEnabled ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
                                        {key === 'lms' && <Building2 className="w-6 h-6" />}
                                        {key === 'videoConferencing' && <Users className="w-6 h-6" />}
                                        {key === 'aiTutor' && <Settings className="w-6 h-6" />}
                                        {key === 'library' && <Database className="w-6 h-6" />}
                                        {key === 'analytics' && <HardDrive className="w-6 h-6" />}
                                        {key === 'payments' && <CreditCard className="w-6 h-6" />}
                                    </div>
                                    <Switch
                                        checked={isEnabled}
                                        onCheckedChange={() => handleModuleToggle(key as any)}
                                        className="data-[state=checked]:bg-[#C0EB6A] data-[state=unchecked]:bg-[#D1DBC1]"
                                    />
                                </div>
                                <h4 className="text-lg font-bold text-[#485550] capitalize mb-1">
                                    {key.replace(/([A-Z])/g, ' $1').trim()}
                                </h4>
                                <p className="text-sm text-[#6B7C6F]">
                                    {isEnabled ? 'Active and accessible to users.' : 'Disabled globally for this tenant.'}
                                </p>
                            </div>
                        ))}
                    </div>
                </TabsContent>

                {/* SUBSCRIPTION TAB */}
                <TabsContent value="subscription" className="space-y-6 animate-in slide-in-from-bottom-2 duration-300">
                    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                        {/* Current Plan Card */}
                        <div className="lg:col-span-2 morph-card p-0 overflow-hidden">
                            <div className="bg-gradient-to-r from-[#485550] to-[#5a6b63] p-8 text-white relative overflow-hidden">
                                <div className="relative z-10 flex justify-between items-start">
                                    <div>
                                        <p className="text-[#C0EB6A] font-bold tracking-wider uppercase text-sm mb-2">Current Subscription</p>
                                        <h3 className="text-4xl font-bold mb-1">{institution.plan} Plan</h3>
                                        <p className="text-gray-300">Renews on {new Date(institution.subscription.nextBillingDate).toLocaleDateString()}</p>
                                    </div>
                                    <div className="text-right">
                                        <span className="text-4xl font-bold">{institution.subscription.currency} {institution.subscription.amount}</span>
                                        <span className="text-gray-300 block text-sm">/ month</span>
                                    </div>
                                </div>
                                {/* Decorative Circles */}
                                <div className="absolute -right-10 -top-10 w-40 h-40 bg-white/10 rounded-full blur-2xl"></div>
                                <div className="absolute -left-10 -bottom-10 w-32 h-32 bg-[#C0EB6A]/20 rounded-full blur-xl"></div>
                            </div>
                            <div className="p-8">
                                <div className="flex items-center justify-between mb-6">
                                    <div>
                                        <h4 className="font-bold text-[#485550] mb-1">Plan Features</h4>
                                        <p className="text-[#6B7C6F] text-sm">Features included in the {institution.plan} tier</p>
                                    </div>
                                    <Button variant="outline" className="btn-morph bg-white">Upgrade Plan</Button>
                                </div>
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                    {['Unlimited Students', 'Advanced Analytics', 'Priority Support', 'Custom Domain', 'White-labeling', 'API Access'].map((feature) => (
                                        <div key={feature} className="flex items-center gap-2 text-[#485550]">
                                            <CheckCircle2 className="w-5 h-5 text-[#C0EB6A]" />
                                            <span>{feature}</span>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        </div>

                        {/* Invoice History */}
                        <div className="morph-card p-6">
                            <div className="flex items-center justify-between mb-4">
                                <h3 className="font-bold text-[#485550]">Recent Invoices</h3>
                                <Button variant="link" className="text-[#C0EB6A] p-0 h-auto font-bold">View All</Button>
                            </div>
                            <div className="space-y-4">
                                {[1, 2, 3].map((i) => (
                                    <div key={i} className="flex items-center justify-between p-3 rounded-xl bg-white border border-[#F4F6F0] hover:border-[#C0EB6A] transition-colors cursor-pointer group">
                                        <div className="flex items-center gap-3">
                                            <div className="p-2 bg-gray-100 rounded-lg group-hover:bg-[#C0EB6A]/20 text-gray-500 group-hover:text-[#485550] transition-colors">
                                                <FileText className="w-5 h-5" />
                                            </div>
                                            <div>
                                                <p className="font-bold text-[#485550]">INV-2026-00{i}</p>
                                                <p className="text-xs text-[#6B7C6F]">Oct {31 - i}, 2026</p>
                                            </div>
                                        </div>
                                        <div className="text-right">
                                            <p className="font-bold text-[#485550]">$2,500.00</p>
                                            <span className="text-xs font-bold text-green-600 bg-green-50 px-2 py-0.5 rounded-full">Paid</span>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    </div>
                </TabsContent>

                {/* ADMINS TAB */}
                <TabsContent value="admins" className="space-y-6 animate-in slide-in-from-bottom-2 duration-300">
                    <div className="flex justify-between items-center bg-white p-4 rounded-2xl border border-[#F4F6F0] shadow-sm mb-6">
                        <div className="relative w-full max-w-sm">
                            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                            <Input placeholder="Search admins..." className="pl-10 bg-[#F4F6F0] border-transparent focus:bg-white transition-all" />
                        </div>
                        <Button className="btn-morph-primary">
                            <Users className="w-4 h-4 mr-2" />
                            Invite Admin
                        </Button>
                    </div>

                    <div className="morph-card overflow-hidden">
                        <div className="overflow-x-auto">
                            <table className="w-full">
                                <thead className="bg-[#F4F6F0]">
                                    <tr>
                                        <th className="px-6 py-4 text-left text-xs font-bold text-[#6B7C6F] uppercase tracking-wider">Name / Email</th>
                                        <th className="px-6 py-4 text-left text-xs font-bold text-[#6B7C6F] uppercase tracking-wider">Role</th>
                                        <th className="px-6 py-4 text-left text-xs font-bold text-[#6B7C6F] uppercase tracking-wider">Status</th>
                                        <th className="px-6 py-4 text-left text-xs font-bold text-[#6B7C6F] uppercase tracking-wider">Last Login</th>
                                        <th className="px-6 py-4 text-right text-xs font-bold text-[#6B7C6F] uppercase tracking-wider">Actions</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-[#F4F6F0]">
                                    {institution.admins.map((admin) => (
                                        <tr key={admin.id} className="hover:bg-[#F4F6F0]/50 transition-colors">
                                            <td className="px-6 py-4 whitespace-nowrap">
                                                <div className="flex items-center gap-3">
                                                    <div className="w-10 h-10 rounded-full bg-gradient-to-br from-purple-100 to-blue-100 flex items-center justify-center text-purple-700 font-bold">
                                                        {admin.name.charAt(0)}
                                                    </div>
                                                    <div>
                                                        <div className="font-bold text-[#485550]">{admin.name}</div>
                                                        <div className="text-sm text-[#6B7C6F]">{admin.email}</div>
                                                    </div>
                                                </div>
                                            </td>
                                            <td className="px-6 py-4 whitespace-nowrap">
                                                <Badge variant="outline" className="border-[#D1DBC1] text-[#485550]">
                                                    {admin.role.replace('_', ' ')}
                                                </Badge>
                                            </td>
                                            <td className="px-6 py-4 whitespace-nowrap">
                                                <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${admin.status === 'ACTIVE' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'
                                                    }`}>
                                                    {admin.status}
                                                </span>
                                            </td>
                                            <td className="px-6 py-4 whitespace-nowrap text-sm text-[#6B7C6F]">
                                                {new Date(admin.lastLogin).toLocaleDateString()}
                                            </td>
                                            <td className="px-6 py-4 whitespace-nowrap text-right">
                                                <Button variant="ghost" size="icon" className="text-[#6B7C6F] hover:text-[#485550]">
                                                    <MoreVertical className="w-4 h-4" />
                                                </Button>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </div>
                </TabsContent>
            </Tabs>
        </div>
    );
}
