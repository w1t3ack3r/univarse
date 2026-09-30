'use client';

import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
    AlertTriangle,
    Search,
    Filter,
    FileWarning,
    Send,
    MoreVertical,
    CheckCircle,
    GraduationCap
} from 'lucide-react';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

// Mock At-Risk Students
const atRiskStudents = [
    {
        id: 'STU-001',
        name: 'Mohammed Ali',
        matric: 'UNI/22/CSC/088',
        dept: 'Computer Science',
        level: '200L',
        cgpa: '0.92',
        failedCourses: 8,
        status: 'ADVISE_TO_WITHDRAW',
        lastSessionGPA: '0.45'
    },
    {
        id: 'STU-002',
        name: 'Sarah James',
        matric: 'UNI/21/MTH/044',
        dept: 'Mathematics',
        level: '300L',
        cgpa: '1.45',
        failedCourses: 4,
        status: 'PROBATION',
        lastSessionGPA: '1.20'
    },
    {
        id: 'STU-003',
        name: 'David Ojo',
        matric: 'UNI/23/PHY/012',
        dept: 'Physics',
        level: '100L',
        cgpa: '0.85',
        failedCourses: 6,
        status: 'ADVISE_TO_WITHDRAW',
        lastSessionGPA: '0.85'
    },
    {
        id: 'STU-004',
        name: 'Grace Eze',
        matric: 'UNI/22/CHM/056',
        dept: 'Chemistry',
        level: '200L',
        cgpa: '1.15',
        failedCourses: 3,
        status: 'PROBATION',
        lastSessionGPA: '1.40'
    }
];

export default function ProbationList() {
    const [searchTerm, setSearchTerm] = useState('');

    const filteredStudents = atRiskStudents.filter(s =>
        s.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        s.matric.toLowerCase().includes(searchTerm.toLowerCase())
    );

    return (
        <div className="space-y-6">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div>
                    <h1 className="text-3xl font-bold text-[#485550]">Academic Standing</h1>
                    <p className="text-[#485550]/70 mt-1">
                        Monitor students on Probation and Advice to Withdraw list
                    </p>
                </div>
                <div className="flex gap-2">
                    <Button variant="outline" className="border-red-200 text-red-600 hover:bg-red-50">
                        <FileWarning className="mr-2 h-4 w-4" /> Generate "Advice to Withdraw"
                    </Button>
                    <Button className="bg-[#485550] hover:bg-[#3a4543]">
                        <Send className="mr-2 h-4 w-4" /> Notify All at Risk
                    </Button>
                </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                <Card className="border-[#F4F6F0]">
                    <CardHeader className="pb-2">
                        <CardTitle className="text-sm font-medium text-[#485550]/70">Total on Probation</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <div className="text-3xl font-bold text-amber-600">42</div>
                        <p className="text-xs text-[#485550]/50 mt-1">CGPA between 1.00 - 1.50</p>
                    </CardContent>
                </Card>
                <Card className="border-[#F4F6F0]">
                    <CardHeader className="pb-2">
                        <CardTitle className="text-sm font-medium text-[#485550]/70">Advice to Withdraw</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <div className="text-3xl font-bold text-red-600">12</div>
                        <p className="text-xs text-[#485550]/50 mt-1">CGPA below 1.00</p>
                    </CardContent>
                </Card>
                <Card className="border-[#F4F6F0]">
                    <CardHeader className="pb-2">
                        <CardTitle className="text-sm font-medium text-[#485550]/70">Good Standing</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <div className="text-3xl font-bold text-[#C0EB6A] text-shadow-sm">2,399</div>
                        <p className="text-xs text-[#485550]/50 mt-1">98.2% of Faculty</p>
                    </CardContent>
                </Card>
            </div>

            <Card className="border-[#F4F6F0]">
                <CardHeader>
                    <div className="flex justify-between items-center">
                        <div className="relative w-full sm:w-64">
                            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-[#485550]/40" />
                            <Input
                                placeholder="Search student..."
                                className="pl-9 border-[#485550]/20"
                                value={searchTerm}
                                onChange={(e) => setSearchTerm(e.target.value)}
                            />
                        </div>
                        <Button variant="outline" size="sm" className="border-[#485550]/20 text-[#485550]">
                            <Filter className="mr-2 h-4 w-4" /> Filter by Dept
                        </Button>
                    </div>
                </CardHeader>
                <CardContent>
                    <div className="space-y-4">
                        {filteredStudents.map((student) => (
                            <div key={student.id} className="flex flex-col sm:flex-row sm:items-center justify-between p-4 rounded-xl border border-[#F4F6F0] bg-white hover:shadow-sm transition-shadow">
                                <div className="flex gap-4">
                                    <div className={`mt-1 h-12 w-12 shrink-0 rounded-full flex items-center justify-center ${student.status === 'ADVISE_TO_WITHDRAW' ? 'bg-red-100 text-red-600' : 'bg-amber-100 text-amber-600'
                                        }`}>
                                        <AlertTriangle className="h-6 w-6" />
                                    </div>
                                    <div>
                                        <h3 className="font-semibold text-[#485550] text-lg">{student.name}</h3>
                                        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-[#485550]/70">
                                            <span className="font-mono">{student.matric}</span>
                                            <span>•</span>
                                            <span>{student.dept}</span>
                                            <span>•</span>
                                            <span>{student.level}</span>
                                        </div>
                                        <div className="flex items-center gap-4 mt-2">
                                            <div className="text-xs">
                                                <span className="text-[#485550]/50">CGPA:</span>
                                                <span className="font-bold text-[#485550] ml-1">{student.cgpa}</span>
                                            </div>
                                            <div className="text-xs">
                                                <span className="text-[#485550]/50">Last Session:</span>
                                                <span className="font-bold text-[#485550] ml-1">{student.lastSessionGPA}</span>
                                            </div>
                                            <div className="text-xs">
                                                <span className="text-[#485550]/50">Failed Courses:</span>
                                                <span className="font-bold text-red-600 ml-1">{student.failedCourses}</span>
                                            </div>
                                        </div>
                                    </div>
                                </div>

                                <div className="flex flex-col sm:items-end gap-3 mt-4 sm:mt-0">
                                    {student.status === 'ADVISE_TO_WITHDRAW' ? (
                                        <Badge className="bg-red-100 text-red-700 border-red-200">Advice to Withdraw</Badge>
                                    ) : (
                                        <Badge className="bg-amber-100 text-amber-700 border-amber-200">Probation</Badge>
                                    )}

                                    <div className="flex gap-2">
                                        <Button size="sm" variant="outline" className="border-[#485550]/20">
                                            View Profile
                                        </Button>
                                        <DropdownMenu>
                                            <DropdownMenuTrigger asChild>
                                                <Button size="sm" variant="ghost" className="h-8 w-8 p-0">
                                                    <MoreVertical className="h-4 w-4 text-[#485550]" />
                                                </Button>
                                            </DropdownMenuTrigger>
                                            <DropdownMenuContent align="end">
                                                <DropdownMenuLabel>Actions</DropdownMenuLabel>
                                                <DropdownMenuItem>View Result History</DropdownMenuItem>
                                                <DropdownMenuItem>Contact Student</DropdownMenuItem>
                                                <DropdownMenuItem className="text-red-600">Manual Withdrawal</DropdownMenuItem>
                                            </DropdownMenuContent>
                                        </DropdownMenu>
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>
                </CardContent>
            </Card>
        </div>
    );
}
