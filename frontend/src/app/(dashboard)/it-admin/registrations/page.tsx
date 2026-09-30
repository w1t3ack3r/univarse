'use client';

import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import {
    Search,
    Filter,
    Download,
    Calendar,
    User,
    BookOpen,
    AlertCircle,
    CheckCircle2,
    XCircle
} from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

// Mock Registration Data
const MOCK_REGISTRATIONS = [
    {
        id: 'REG-001',
        student: { name: 'Oluwaseun Adebayo', matNo: 'UNI/20/CSC/045', dept: 'Computer Science' },
        course: { code: 'CSC 401', title: 'Artificial Intelligence', unit: 3 },
        semester: 'First',
        session: '2024/2025',
        date: '2024-09-15',
        status: 'REGISTERED'
    },
    {
        id: 'REG-002',
        student: { name: 'Oluwaseun Adebayo', matNo: 'UNI/20/CSC/045', dept: 'Computer Science' },
        course: { code: 'MTH 401', title: 'Numerical Analysis', unit: 3 },
        semester: 'First',
        session: '2024/2025',
        date: '2024-09-15',
        status: 'REGISTERED'
    },
    {
        id: 'REG-003',
        student: { name: 'Chioma Nwosu', matNo: 'UNI/20/CSC/052', dept: 'Computer Science' },
        course: { code: 'CSC 401', title: 'Artificial Intelligence', unit: 3 },
        semester: 'First',
        session: '2024/2025',
        date: '2024-09-16',
        status: 'REGISTERED'
    },
    {
        id: 'REG-004',
        student: { name: 'Chioma Nwosu', matNo: 'UNI/20/CSC/052', dept: 'Computer Science' },
        course: { code: 'ELECT 101', title: 'Basic Electronics', unit: 2 },
        semester: 'First',
        session: '2024/2025',
        date: '2024-09-16',
        status: 'DROPPED', // Dropped Course
        dropDate: '2024-09-28'
    },
    {
        id: 'REG-005',
        student: { name: 'Ibrahim Musa', matNo: 'UNI/20/CSC/066', dept: 'Computer Science' },
        course: { code: 'CSC 401', title: 'Artificial Intelligence', unit: 3 },
        semester: 'First',
        session: '2024/2025',
        date: '2024-09-17',
        status: 'REGISTERED'
    },
    {
        id: 'REG-006',
        student: { name: 'Ibrahim Musa', matNo: 'UNI/20/CSC/066', dept: 'Computer Science' },
        course: { code: 'CSC 499', title: 'Final Year Project', unit: 6 },
        semester: 'First',
        session: '2024/2025',
        date: '2024-09-17',
        status: 'REGISTERED'
    },
    {
        id: 'REG-007',
        student: { name: 'Sarah Idahosa', matNo: 'UNI/21/CSC/012', dept: 'Computer Science' },
        course: { code: 'GNS 301', title: 'Entrepreneurship', unit: 2 },
        semester: 'First',
        session: '2024/2025',
        date: '2024-09-20',
        status: 'DROPPED',
        dropDate: '2024-10-05'
    }
];

export default function RegistrationLog() {
    const [searchTerm, setSearchTerm] = useState('');
    const [statusFilter, setStatusFilter] = useState('ALL');

    const filteredRegs = MOCK_REGISTRATIONS.filter(reg => {
        const matchesSearch =
            reg.student.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
            reg.student.matNo.toLowerCase().includes(searchTerm.toLowerCase()) ||
            reg.course.code.toLowerCase().includes(searchTerm.toLowerCase());

        const matchesStatus = statusFilter === 'ALL' || reg.status === statusFilter;

        return matchesSearch && matchesStatus;
    });

    const getStatusBadge = (status: string) => {
        switch (status) {
            case 'REGISTERED':
                return <Badge className="bg-green-100 text-green-700 hover:bg-green-200 border-green-200"><CheckCircle2 className="w-3 h-3 mr-1" /> Registered</Badge>;
            case 'DROPPED':
                return <Badge variant="secondary" className="bg-amber-100 text-amber-700 hover:bg-amber-200 border-amber-200"><XCircle className="w-3 h-3 mr-1" /> Dropped</Badge>;
            default:
                return <Badge variant="outline">{status}</Badge>;
        }
    };

    return (
        <div className="space-y-6">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div>
                    <h1 className="text-3xl font-bold text-[#485550]">Course Registration Log</h1>
                    <p className="text-[#485550]/60 mt-1">Track student course registrations, adds, and drops.</p>
                </div>
                <div className="flex gap-2">
                    <Button variant="outline" className="border-[#485550]/20 text-[#485550]">
                        <Download className="mr-2 h-4 w-4" /> Export Report
                    </Button>
                </div>
            </div>

            <Card className="border-[#F4F6F0]">
                <CardHeader className="pb-3 border-b border-[#F4F6F0]">
                    <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                        <div className="relative w-full md:w-96">
                            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-[#485550]/40" />
                            <Input
                                placeholder="Search student or course code..."
                                className="pl-9 border-[#485550]/20"
                                value={searchTerm}
                                onChange={(e) => setSearchTerm(e.target.value)}
                            />
                        </div>
                        <div className="flex items-center gap-2">
                            <Select value={statusFilter} onValueChange={setStatusFilter}>
                                <SelectTrigger className="w-[180px] border-[#485550]/20">
                                    <SelectValue placeholder="All Status" />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="ALL">All Status</SelectItem>
                                    <SelectItem value="REGISTERED">Registered</SelectItem>
                                    <SelectItem value="DROPPED">Dropped</SelectItem>
                                </SelectContent>
                            </Select>
                            <Button variant="outline" size="icon" className="border-[#485550]/20 text-[#485550]">
                                <Filter className="h-4 w-4" />
                            </Button>
                        </div>
                    </div>
                </CardHeader>
                <CardContent className="p-0">
                    <Table>
                        <TableHeader className="bg-[#F4F6F0]">
                            <TableRow>
                                <TableHead className="font-bold text-[#485550]">Student Details</TableHead>
                                <TableHead className="font-bold text-[#485550]">Course Information</TableHead>
                                <TableHead className="font-bold text-[#485550]">Session / Date</TableHead>
                                <TableHead className="font-bold text-[#485550]">Status</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {filteredRegs.length === 0 ? (
                                <TableRow>
                                    <TableCell colSpan={4} className="h-24 text-center text-[#485550]/60">
                                        No records found matching your filters.
                                    </TableCell>
                                </TableRow>
                            ) : (
                                filteredRegs.map((reg) => (
                                    <TableRow key={reg.id} className="hover:bg-[#F4F6F0]/30 transition-colors">
                                        <TableCell>
                                            <div className="flex items-center gap-3">
                                                <div className="w-8 h-8 rounded-full bg-[#C0EB6A]/20 flex items-center justify-center text-[#485550]">
                                                    <User className="h-4 w-4" />
                                                </div>
                                                <div>
                                                    <p className="font-medium text-[#485550]">{reg.student.name}</p>
                                                    <p className="text-xs text-[#485550]/60 font-mono">{reg.student.matNo}</p>
                                                </div>
                                            </div>
                                        </TableCell>
                                        <TableCell>
                                            <div className="flex items-start gap-2">
                                                <BookOpen className="h-4 w-4 text-[#485550]/40 mt-1" />
                                                <div>
                                                    <p className="font-medium text-[#485550]">{reg.course.code}</p>
                                                    <p className="text-xs text-[#485550]/60">{reg.course.title} ({reg.course.unit} Units)</p>
                                                </div>
                                            </div>
                                        </TableCell>
                                        <TableCell>
                                            <div className="flex items-start gap-2">
                                                <Calendar className="h-4 w-4 text-[#485550]/40 mt-1" />
                                                <div>
                                                    <p className="text-sm text-[#485550]">{reg.session} ({reg.semester})</p>
                                                    <p className="text-xs text-[#485550]/60">Action: {reg.date}</p>
                                                    {reg.status === 'DROPPED' && (
                                                        <p className="text-[10px] text-amber-600 font-medium">Dropped on: {reg.dropDate}</p>
                                                    )}
                                                </div>
                                            </div>
                                        </TableCell>
                                        <TableCell>
                                            {getStatusBadge(reg.status)}
                                        </TableCell>
                                    </TableRow>
                                ))
                            )}
                        </TableBody>
                    </Table>
                </CardContent>
            </Card>
        </div>
    );
}
