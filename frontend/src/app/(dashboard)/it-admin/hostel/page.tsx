'use client';

import { useState, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import {
    Building,
    Bed,
    Users,
    FileText,
    Settings,
    Plus,
    Edit,
    Trash2,
    Check,
    X,
    Search,
    Loader2,
    Home,
    User,
    DoorOpen,
    Clock,
    CheckCircle2,
    XCircle,
    AlertTriangle,
    Wifi,
    Droplets,
    Shield,
    Zap,
} from 'lucide-react';
import { toast } from 'sonner';

// Types
interface Hostel {
    id: string;
    name: string;
    code: string;
    gender: 'MALE' | 'FEMALE';
    capacity: number;
    occupied: number;
    floors: number;
    facilities: string[];
    feePerBed: number;
    status: 'ACTIVE' | 'MAINTENANCE' | 'CLOSED';
}

interface Room {
    id: string;
    hostelId: string;
    hostelName: string;
    roomNumber: string;
    floor: number;
    type: 'SINGLE' | 'DOUBLE' | 'SHARED';
    capacity: number;
    occupied: number;
    fee: number;
    status: 'AVAILABLE' | 'FULL' | 'MAINTENANCE';
}

interface BedAllocation {
    id: string;
    roomId: string;
    roomNumber: string;
    hostelName: string;
    bedNumber: number;
    studentId: string;
    studentName: string;
    matricNo: string;
    department: string;
    level: string;
    session: string;
    allocatedDate: string;
    status: 'ACTIVE' | 'EXPIRED' | 'REVOKED';
}

interface HostelApplication {
    id: string;
    studentId: string;
    studentName: string;
    matricNo: string;
    department: string;
    level: string;
    gender: 'MALE' | 'FEMALE';
    preferredHostel: string;
    roomType: string;
    session: string;
    applicationDate: string;
    paymentStatus: 'PAID' | 'PENDING';
    status: 'PENDING' | 'APPROVED' | 'REJECTED';
}

// Mock Data
const mockHostels: Hostel[] = [
    { id: 'h1', name: 'Queen Amina Hall', code: 'QAH', gender: 'FEMALE', capacity: 500, occupied: 420, floors: 4, facilities: ['WiFi', 'Water', 'Security', 'Generator'], feePerBed: 45000, status: 'ACTIVE' },
    { id: 'h2', name: 'Nnamdi Azikiwe Hall', code: 'NAH', gender: 'MALE', capacity: 600, occupied: 580, floors: 5, facilities: ['WiFi', 'Water', 'Security', 'Generator', 'Laundry'], feePerBed: 50000, status: 'ACTIVE' },
    { id: 'h3', name: 'Moremi Hall', code: 'MRH', gender: 'FEMALE', capacity: 400, occupied: 350, floors: 3, facilities: ['WiFi', 'Water', 'Security'], feePerBed: 40000, status: 'ACTIVE' },
    { id: 'h4', name: 'Jaja Hall', code: 'JAH', gender: 'MALE', capacity: 450, occupied: 200, floors: 4, facilities: ['Water', 'Security'], feePerBed: 35000, status: 'MAINTENANCE' },
];

const mockRooms: Room[] = [
    { id: 'r1', hostelId: 'h1', hostelName: 'Queen Amina Hall', roomNumber: 'A101', floor: 1, type: 'SHARED', capacity: 4, occupied: 3, fee: 45000, status: 'AVAILABLE' },
    { id: 'r2', hostelId: 'h1', hostelName: 'Queen Amina Hall', roomNumber: 'A102', floor: 1, type: 'SHARED', capacity: 4, occupied: 4, fee: 45000, status: 'FULL' },
    { id: 'r3', hostelId: 'h2', hostelName: 'Nnamdi Azikiwe Hall', roomNumber: 'B201', floor: 2, type: 'DOUBLE', capacity: 2, occupied: 1, fee: 60000, status: 'AVAILABLE' },
    { id: 'r4', hostelId: 'h2', hostelName: 'Nnamdi Azikiwe Hall', roomNumber: 'B202', floor: 2, type: 'SINGLE', capacity: 1, occupied: 1, fee: 80000, status: 'FULL' },
    { id: 'r5', hostelId: 'h3', hostelName: 'Moremi Hall', roomNumber: 'C301', floor: 3, type: 'SHARED', capacity: 6, occupied: 5, fee: 40000, status: 'AVAILABLE' },
];

const mockAllocations: BedAllocation[] = [
    { id: 'a1', roomId: 'r1', roomNumber: 'A101', hostelName: 'Queen Amina Hall', bedNumber: 1, studentId: 's1', studentName: 'Fatima Bello', matricNo: 'CSC/2021/001', department: 'Computer Science', level: '300', session: '2024/2025', allocatedDate: '2024-09-15', status: 'ACTIVE' },
    { id: 'a2', roomId: 'r1', roomNumber: 'A101', hostelName: 'Queen Amina Hall', bedNumber: 2, studentId: 's2', studentName: 'Amina Hassan', matricNo: 'PHY/2021/023', department: 'Physics', level: '300', session: '2024/2025', allocatedDate: '2024-09-16', status: 'ACTIVE' },
    { id: 'a3', roomId: 'r3', roomNumber: 'B201', hostelName: 'Nnamdi Azikiwe Hall', bedNumber: 1, studentId: 's3', studentName: 'Chukwu Emeka', matricNo: 'ENG/2020/012', department: 'Engineering', level: '400', session: '2024/2025', allocatedDate: '2024-09-14', status: 'ACTIVE' },
];

const mockApplications: HostelApplication[] = [
    { id: 'app1', studentId: 's4', studentName: 'Ngozi Okafor', matricNo: 'BIO/2022/045', department: 'Biology', level: '200', gender: 'FEMALE', preferredHostel: 'Queen Amina Hall', roomType: 'SHARED', session: '2024/2025', applicationDate: '2024-08-20', paymentStatus: 'PAID', status: 'PENDING' },
    { id: 'app2', studentId: 's5', studentName: 'Ibrahim Danjuma', matricNo: 'MTH/2022/018', department: 'Mathematics', level: '200', gender: 'MALE', preferredHostel: 'Nnamdi Azikiwe Hall', roomType: 'DOUBLE', session: '2024/2025', applicationDate: '2024-08-21', paymentStatus: 'PAID', status: 'PENDING' },
    { id: 'app3', studentId: 's6', studentName: 'Grace Williams', matricNo: 'CHM/2023/032', department: 'Chemistry', level: '100', gender: 'FEMALE', preferredHostel: 'Moremi Hall', roomType: 'SHARED', session: '2024/2025', applicationDate: '2024-08-22', paymentStatus: 'PENDING', status: 'PENDING' },
];

export default function Hostel() {
    const [isLoading, setIsLoading] = useState(true);
    const [activeTab, setActiveTab] = useState('hostels');
    const [hostels, setHostels] = useState<Hostel[]>([]);
    const [rooms, setRooms] = useState<Room[]>([]);
    const [allocations, setAllocations] = useState<BedAllocation[]>([]);
    const [applications, setApplications] = useState<HostelApplication[]>([]);

    // Filters
    const [searchTerm, setSearchTerm] = useState('');
    const [hostelFilter, setHostelFilter] = useState('all');
    const [genderFilter, setGenderFilter] = useState('all');

    // Dialog State
    const [hostelDialogOpen, setHostelDialogOpen] = useState(false);
    const [roomDialogOpen, setRoomDialogOpen] = useState(false);
    const [allocationDialogOpen, setAllocationDialogOpen] = useState(false);
    const [selectedHostel, setSelectedHostel] = useState<Hostel | null>(null);
    const [selectedRoom, setSelectedRoom] = useState<Room | null>(null);
    const [selectedApplication, setSelectedApplication] = useState<HostelApplication | null>(null);
    const [submitting, setSubmitting] = useState(false);

    // Forms
    const [hostelForm, setHostelForm] = useState<{ name: string; code: string; gender: 'MALE' | 'FEMALE'; floors: number; feePerBed: number; facilities: string[] }>({ name: '', code: '', gender: 'MALE', floors: 3, feePerBed: 40000, facilities: [] });
    const [roomForm, setRoomForm] = useState({ hostelId: '', roomNumber: '', floor: 1, type: 'SHARED' as const, capacity: 4, fee: 40000 });

    useEffect(() => {
        setTimeout(() => {
            setHostels(mockHostels);
            setRooms(mockRooms);
            setAllocations(mockAllocations);
            setApplications(mockApplications);
            setIsLoading(false);
        }, 500);
    }, []);

    // Stats
    const stats = {
        totalBeds: hostels.reduce((sum, h) => sum + h.capacity, 0),
        occupiedBeds: hostels.reduce((sum, h) => sum + h.occupied, 0),
        pendingApplications: applications.filter(a => a.status === 'PENDING').length,
        activeHostels: hostels.filter(h => h.status === 'ACTIVE').length,
    };

    // Handlers
    const handleCreateHostel = async () => {
        setSubmitting(true);
        await new Promise(r => setTimeout(r, 500));
        const newHostel: Hostel = {
            id: `h${Date.now()}`,
            ...hostelForm,
            capacity: 0,
            occupied: 0,
            status: 'ACTIVE',
        };
        setHostels([...hostels, newHostel]);
        toast.success('Hostel created successfully!');
        setHostelDialogOpen(false);
        setHostelForm({ name: '', code: '', gender: 'MALE', floors: 3, feePerBed: 40000, facilities: [] });
        setSubmitting(false);
    };

    const handleApproveApplication = async (app: HostelApplication) => {
        if (app.paymentStatus !== 'PAID') {
            toast.error('Payment not confirmed');
            return;
        }
        setSubmitting(true);
        await new Promise(r => setTimeout(r, 500));
        setApplications(applications.map(a => a.id === app.id ? { ...a, status: 'APPROVED' } : a));
        toast.success(`Application approved for ${app.studentName}`);
        setSubmitting(false);
    };

    const handleRejectApplication = async (app: HostelApplication) => {
        setSubmitting(true);
        await new Promise(r => setTimeout(r, 500));
        setApplications(applications.map(a => a.id === app.id ? { ...a, status: 'REJECTED' } : a));
        toast.success(`Application rejected`);
        setSubmitting(false);
    };

    const getFacilityIcon = (facility: string) => {
        switch (facility.toLowerCase()) {
            case 'wifi': return <Wifi className="w-3 h-3" />;
            case 'water': return <Droplets className="w-3 h-3" />;
            case 'security': return <Shield className="w-3 h-3" />;
            case 'generator': return <Zap className="w-3 h-3" />;
            default: return <Check className="w-3 h-3" />;
        }
    };

    const getStatusColor = (status: string) => {
        switch (status) {
            case 'ACTIVE':
            case 'AVAILABLE':
            case 'APPROVED':
            case 'PAID':
                return 'bg-green-100 text-green-700';
            case 'PENDING':
                return 'bg-amber-100 text-amber-700';
            case 'FULL':
                return 'bg-blue-100 text-blue-700';
            case 'MAINTENANCE':
            case 'EXPIRED':
                return 'bg-orange-100 text-orange-700';
            case 'CLOSED':
            case 'REVOKED':
            case 'REJECTED':
                return 'bg-red-100 text-red-700';
            default:
                return 'bg-gray-100 text-gray-700';
        }
    };

    // Filter rooms
    const filteredRooms = rooms.filter(r => {
        const matchesSearch = r.roomNumber.toLowerCase().includes(searchTerm.toLowerCase()) || r.hostelName.toLowerCase().includes(searchTerm.toLowerCase());
        const matchesHostel = hostelFilter === 'all' || r.hostelId === hostelFilter;
        return matchesSearch && matchesHostel;
    });

    // Filter applications
    const filteredApplications = applications.filter(a => {
        const matchesSearch = a.studentName.toLowerCase().includes(searchTerm.toLowerCase()) || a.matricNo.toLowerCase().includes(searchTerm.toLowerCase());
        const matchesGender = genderFilter === 'all' || a.gender === genderFilter;
        return matchesSearch && matchesGender;
    });

    if (isLoading) {
        return <div className="flex items-center justify-center h-64"><Loader2 className="h-8 w-8 animate-spin text-[#485550]" /></div>;
    }

    return (
        <div className="space-y-6">
            {/* Header */}
            <div>
                <h1 className="text-3xl font-bold text-[#485550]">Hostel Allocation</h1>
                <p className="text-[#485550]/60 mt-1">Manage hostels, rooms, and bed allocations</p>
            </div>

            {/* Stats Cards */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <Card className="border-[#F4F6F0]">
                    <CardContent className="p-4">
                        <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-lg bg-purple-100 flex items-center justify-center">
                                <Building className="w-5 h-5 text-purple-600" />
                            </div>
                            <div>
                                <p className="text-2xl font-bold text-purple-600">{stats.activeHostels}</p>
                                <p className="text-xs text-[#485550]/60">Active Hostels</p>
                            </div>
                        </div>
                    </CardContent>
                </Card>
                <Card className="border-[#F4F6F0]">
                    <CardContent className="p-4">
                        <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-lg bg-blue-100 flex items-center justify-center">
                                <Bed className="w-5 h-5 text-blue-600" />
                            </div>
                            <div>
                                <p className="text-2xl font-bold text-blue-600">{stats.totalBeds}</p>
                                <p className="text-xs text-[#485550]/60">Total Beds</p>
                            </div>
                        </div>
                    </CardContent>
                </Card>
                <Card className="border-[#F4F6F0]">
                    <CardContent className="p-4">
                        <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-lg bg-green-100 flex items-center justify-center">
                                <Users className="w-5 h-5 text-green-600" />
                            </div>
                            <div>
                                <p className="text-2xl font-bold text-green-600">{stats.occupiedBeds}</p>
                                <p className="text-xs text-[#485550]/60">Occupied</p>
                            </div>
                        </div>
                    </CardContent>
                </Card>
                <Card className="border-[#F4F6F0]">
                    <CardContent className="p-4">
                        <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-lg bg-amber-100 flex items-center justify-center">
                                <Clock className="w-5 h-5 text-amber-600" />
                            </div>
                            <div>
                                <p className="text-2xl font-bold text-amber-600">{stats.pendingApplications}</p>
                                <p className="text-xs text-[#485550]/60">Pending Apps</p>
                            </div>
                        </div>
                    </CardContent>
                </Card>
            </div>

            {/* Tabs */}
            <Tabs value={activeTab} onValueChange={setActiveTab}>
                <TabsList className="grid w-full grid-cols-4 bg-[#485550]">
                    <TabsTrigger value="hostels" className="text-white data-[state=active]:bg-[#C0EB6A] data-[state=active]:text-[#485550]">
                        <Building className="w-4 h-4 mr-1" /> Hostels
                    </TabsTrigger>
                    <TabsTrigger value="rooms" className="text-white data-[state=active]:bg-[#C0EB6A] data-[state=active]:text-[#485550]">
                        <DoorOpen className="w-4 h-4 mr-1" /> Rooms
                    </TabsTrigger>
                    <TabsTrigger value="applications" className="text-white data-[state=active]:bg-[#C0EB6A] data-[state=active]:text-[#485550]">
                        <FileText className="w-4 h-4 mr-1" /> Applications
                    </TabsTrigger>
                    <TabsTrigger value="allocations" className="text-white data-[state=active]:bg-[#C0EB6A] data-[state=active]:text-[#485550]">
                        <Bed className="w-4 h-4 mr-1" /> Allocations
                    </TabsTrigger>
                </TabsList>

                {/* Hostels Tab */}
                <TabsContent value="hostels" className="mt-4 space-y-4">
                    <div className="flex justify-between items-center">
                        <h2 className="text-lg font-semibold text-[#485550]">Hostel Management</h2>
                        <Button onClick={() => setHostelDialogOpen(true)} className="bg-[#485550] hover:bg-[#6b7c6f]">
                            <Plus className="w-4 h-4 mr-2" /> Add Hostel
                        </Button>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        {hostels.map(hostel => (
                            <Card key={hostel.id} className={`border-[#F4F6F0] ${hostel.status === 'MAINTENANCE' ? 'opacity-75' : ''}`}>
                                <CardContent className="p-4">
                                    <div className="flex items-start justify-between mb-3">
                                        <div className="flex items-center gap-3">
                                            <div className={`w-12 h-12 rounded-lg flex items-center justify-center ${hostel.gender === 'FEMALE' ? 'bg-pink-100' : 'bg-blue-100'}`}>
                                                <Home className={`w-6 h-6 ${hostel.gender === 'FEMALE' ? 'text-pink-600' : 'text-blue-600'}`} />
                                            </div>
                                            <div>
                                                <h3 className="font-bold text-[#485550]">{hostel.name}</h3>
                                                <p className="text-sm text-[#485550]/60">{hostel.code} • {hostel.gender}</p>
                                            </div>
                                        </div>
                                        <Badge className={getStatusColor(hostel.status)}>{hostel.status}</Badge>
                                    </div>

                                    {/* Capacity Bar */}
                                    <div className="mb-3">
                                        <div className="flex justify-between text-sm mb-1">
                                            <span className="text-[#485550]/60">Occupancy</span>
                                            <span className="font-medium text-[#485550]">{hostel.occupied}/{hostel.capacity}</span>
                                        </div>
                                        <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
                                            <div
                                                className={`h-full ${hostel.occupied / hostel.capacity > 0.9 ? 'bg-red-500' : hostel.occupied / hostel.capacity > 0.7 ? 'bg-amber-500' : 'bg-green-500'}`}
                                                style={{ width: `${(hostel.occupied / hostel.capacity) * 100}%` }}
                                            />
                                        </div>
                                    </div>

                                    <div className="flex items-center justify-between">
                                        <div className="flex gap-1">
                                            {hostel.facilities.slice(0, 4).map(f => (
                                                <span key={f} className="inline-flex items-center gap-1 px-2 py-1 bg-[#F4F6F0] rounded text-xs text-[#485550]">
                                                    {getFacilityIcon(f)} {f}
                                                </span>
                                            ))}
                                        </div>
                                        <p className="font-bold text-[#485550]">₦{hostel.feePerBed.toLocaleString()}</p>
                                    </div>
                                </CardContent>
                            </Card>
                        ))}
                    </div>
                </TabsContent>

                {/* Rooms Tab */}
                <TabsContent value="rooms" className="mt-4 space-y-4">
                    <Card className="border-[#F4F6F0]">
                        <CardHeader>
                            <div className="flex items-center justify-between">
                                <div>
                                    <CardTitle className="text-[#485550]">Room Management</CardTitle>
                                    <CardDescription>View and manage rooms across hostels</CardDescription>
                                </div>
                                <Button onClick={() => setRoomDialogOpen(true)} className="bg-[#485550] hover:bg-[#6b7c6f]">
                                    <Plus className="w-4 h-4 mr-2" /> Add Room
                                </Button>
                            </div>
                        </CardHeader>
                        <CardContent>
                            {/* Filters */}
                            <div className="flex gap-4 mb-4">
                                <div className="relative flex-1">
                                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#485550]/40" />
                                    <Input
                                        placeholder="Search rooms..."
                                        value={searchTerm}
                                        onChange={(e) => setSearchTerm(e.target.value)}
                                        className="pl-10 border-[#485550]/20"
                                    />
                                </div>
                                <Select value={hostelFilter} onValueChange={setHostelFilter}>
                                    <SelectTrigger className="w-[200px] border-[#485550]/20">
                                        <SelectValue placeholder="Filter by hostel" />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="all">All Hostels</SelectItem>
                                        {hostels.map(h => (
                                            <SelectItem key={h.id} value={h.id}>{h.name}</SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </div>

                            <div className="overflow-x-auto">
                                <table className="w-full">
                                    <thead>
                                        <tr className="border-b border-[#F4F6F0]">
                                            <th className="text-left py-3 px-2 text-sm font-medium text-[#485550]/60">Room</th>
                                            <th className="text-left py-3 px-2 text-sm font-medium text-[#485550]/60">Hostel</th>
                                            <th className="text-center py-3 px-2 text-sm font-medium text-[#485550]/60">Type</th>
                                            <th className="text-center py-3 px-2 text-sm font-medium text-[#485550]/60">Capacity</th>
                                            <th className="text-center py-3 px-2 text-sm font-medium text-[#485550]/60">Fee</th>
                                            <th className="text-center py-3 px-2 text-sm font-medium text-[#485550]/60">Status</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {filteredRooms.map(room => (
                                            <tr key={room.id} className="border-b border-[#F4F6F0]/50 hover:bg-[#F4F6F0]/30">
                                                <td className="py-3 px-2 font-medium text-[#485550]">{room.roomNumber}</td>
                                                <td className="py-3 px-2 text-sm text-[#485550]">{room.hostelName}</td>
                                                <td className="py-3 px-2 text-center">
                                                    <Badge variant="outline" className="border-[#485550]/20">{room.type}</Badge>
                                                </td>
                                                <td className="py-3 px-2 text-center text-sm text-[#485550]">{room.occupied}/{room.capacity}</td>
                                                <td className="py-3 px-2 text-center font-medium text-[#485550]">₦{room.fee.toLocaleString()}</td>
                                                <td className="py-3 px-2 text-center">
                                                    <Badge className={getStatusColor(room.status)}>{room.status}</Badge>
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        </CardContent>
                    </Card>
                </TabsContent>

                {/* Applications Tab */}
                <TabsContent value="applications" className="mt-4 space-y-4">
                    <Card className="border-[#F4F6F0]">
                        <CardHeader>
                            <CardTitle className="text-[#485550]">Hostel Applications</CardTitle>
                            <CardDescription>Review and process student hostel applications</CardDescription>
                        </CardHeader>
                        <CardContent>
                            <div className="space-y-4">
                                {filteredApplications.map(app => (
                                    <div key={app.id} className={`p-4 rounded-lg border ${app.status === 'APPROVED' ? 'border-green-200 bg-green-50/50' : app.status === 'REJECTED' ? 'border-red-200 bg-red-50/50' : 'border-[#F4F6F0] bg-[#F4F6F0]/30'}`}>
                                        <div className="flex items-center justify-between">
                                            <div className="flex items-center gap-3">
                                                <div className={`w-12 h-12 rounded-full flex items-center justify-center ${app.gender === 'FEMALE' ? 'bg-pink-100' : 'bg-blue-100'}`}>
                                                    <User className={`w-6 h-6 ${app.gender === 'FEMALE' ? 'text-pink-600' : 'text-blue-600'}`} />
                                                </div>
                                                <div>
                                                    <p className="font-bold text-[#485550]">{app.studentName}</p>
                                                    <p className="text-sm text-[#485550]/60">{app.matricNo} • {app.department} • {app.level} Level</p>
                                                </div>
                                            </div>
                                            <div className="flex items-center gap-2">
                                                <Badge className={getStatusColor(app.paymentStatus)}>
                                                    {app.paymentStatus === 'PAID' ? <Check className="w-3 h-3 mr-1" /> : <Clock className="w-3 h-3 mr-1" />}
                                                    {app.paymentStatus}
                                                </Badge>
                                                <Badge className={getStatusColor(app.status)}>{app.status}</Badge>
                                            </div>
                                        </div>

                                        <div className="mt-3 flex items-center justify-between">
                                            <div className="text-sm text-[#485550]/60">
                                                <span>Preferred: <strong className="text-[#485550]">{app.preferredHostel}</strong></span>
                                                <span className="mx-2">•</span>
                                                <span>Room Type: <strong className="text-[#485550]">{app.roomType}</strong></span>
                                            </div>
                                            {app.status === 'PENDING' && (
                                                <div className="flex gap-2">
                                                    <Button size="sm" variant="outline" onClick={() => handleRejectApplication(app)} disabled={submitting} className="border-red-500 text-red-600 hover:bg-red-50">
                                                        <XCircle className="w-4 h-4 mr-1" /> Reject
                                                    </Button>
                                                    <Button size="sm" onClick={() => handleApproveApplication(app)} disabled={submitting || app.paymentStatus !== 'PAID'} className="bg-green-600 hover:bg-green-700">
                                                        <CheckCircle2 className="w-4 h-4 mr-1" /> Approve
                                                    </Button>
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                ))}

                                {filteredApplications.length === 0 && (
                                    <div className="text-center py-12 text-[#485550]/60">
                                        <FileText className="w-12 h-12 mx-auto mb-2 opacity-30" />
                                        <p>No applications found</p>
                                    </div>
                                )}
                            </div>
                        </CardContent>
                    </Card>
                </TabsContent>

                {/* Allocations Tab */}
                <TabsContent value="allocations" className="mt-4 space-y-4">
                    <Card className="border-[#F4F6F0]">
                        <CardHeader>
                            <CardTitle className="text-[#485550]">Current Allocations</CardTitle>
                            <CardDescription>View all active bed allocations</CardDescription>
                        </CardHeader>
                        <CardContent>
                            <div className="overflow-x-auto">
                                <table className="w-full">
                                    <thead>
                                        <tr className="border-b border-[#F4F6F0]">
                                            <th className="text-left py-3 px-2 text-sm font-medium text-[#485550]/60">Student</th>
                                            <th className="text-left py-3 px-2 text-sm font-medium text-[#485550]/60">Hostel</th>
                                            <th className="text-center py-3 px-2 text-sm font-medium text-[#485550]/60">Room</th>
                                            <th className="text-center py-3 px-2 text-sm font-medium text-[#485550]/60">Bed</th>
                                            <th className="text-center py-3 px-2 text-sm font-medium text-[#485550]/60">Session</th>
                                            <th className="text-center py-3 px-2 text-sm font-medium text-[#485550]/60">Status</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {allocations.map(alloc => (
                                            <tr key={alloc.id} className="border-b border-[#F4F6F0]/50 hover:bg-[#F4F6F0]/30">
                                                <td className="py-3 px-2">
                                                    <p className="font-medium text-[#485550]">{alloc.studentName}</p>
                                                    <p className="text-xs text-[#485550]/60">{alloc.matricNo}</p>
                                                </td>
                                                <td className="py-3 px-2 text-sm text-[#485550]">{alloc.hostelName}</td>
                                                <td className="py-3 px-2 text-center font-mono text-[#485550]">{alloc.roomNumber}</td>
                                                <td className="py-3 px-2 text-center text-[#485550]">Bed {alloc.bedNumber}</td>
                                                <td className="py-3 px-2 text-center text-sm text-[#485550]">{alloc.session}</td>
                                                <td className="py-3 px-2 text-center">
                                                    <Badge className={getStatusColor(alloc.status)}>{alloc.status}</Badge>
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        </CardContent>
                    </Card>
                </TabsContent>
            </Tabs>

            {/* Add Hostel Dialog */}
            <Dialog open={hostelDialogOpen} onOpenChange={setHostelDialogOpen}>
                <DialogContent className="max-w-md">
                    <DialogHeader>
                        <DialogTitle className="text-[#485550]">Add New Hostel</DialogTitle>
                        <DialogDescription>Create a new hostel in the system</DialogDescription>
                    </DialogHeader>
                    <div className="space-y-4 py-4">
                        <div className="grid grid-cols-2 gap-4">
                            <div className="space-y-2">
                                <Label>Hostel Name</Label>
                                <Input value={hostelForm.name} onChange={(e) => setHostelForm({ ...hostelForm, name: e.target.value })} placeholder="e.g., New Hall" className="border-[#485550]/20" />
                            </div>
                            <div className="space-y-2">
                                <Label>Code</Label>
                                <Input value={hostelForm.code} onChange={(e) => setHostelForm({ ...hostelForm, code: e.target.value.toUpperCase() })} placeholder="e.g., NWH" className="border-[#485550]/20" />
                            </div>
                        </div>
                        <div className="grid grid-cols-2 gap-4">
                            <div className="space-y-2">
                                <Label>Gender</Label>
                                <Select value={hostelForm.gender} onValueChange={(v) => setHostelForm({ ...hostelForm, gender: v as 'MALE' | 'FEMALE' })}>
                                    <SelectTrigger className="border-[#485550]/20">
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="MALE">Male</SelectItem>
                                        <SelectItem value="FEMALE">Female</SelectItem>
                                    </SelectContent>
                                </Select>
                            </div>
                            <div className="space-y-2">
                                <Label>Floors</Label>
                                <Input type="number" value={hostelForm.floors} onChange={(e) => setHostelForm({ ...hostelForm, floors: parseInt(e.target.value) || 1 })} className="border-[#485550]/20" />
                            </div>
                        </div>
                        <div className="space-y-2">
                            <Label>Fee per Bed (₦)</Label>
                            <Input type="number" value={hostelForm.feePerBed} onChange={(e) => setHostelForm({ ...hostelForm, feePerBed: parseInt(e.target.value) || 0 })} className="border-[#485550]/20" />
                        </div>
                    </div>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setHostelDialogOpen(false)}>Cancel</Button>
                        <Button onClick={handleCreateHostel} disabled={submitting || !hostelForm.name || !hostelForm.code} className="bg-[#485550] hover:bg-[#6b7c6f]">
                            {submitting ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Plus className="w-4 h-4 mr-2" />}
                            Create Hostel
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}
