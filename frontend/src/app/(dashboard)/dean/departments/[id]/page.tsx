'use client';

import { useParams } from 'next/navigation';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import {
    Building2,
    Users,
    BookOpen,
    GraduationCap,
    ArrowLeft,
    Mail,
    Phone
} from 'lucide-react';
import Link from 'next/link';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

// Detailed Mock Data (Idempotent for demo)
const deptData = {
    name: 'Computer Science',
    hod: 'Dr. Adewale Johnson',
    email: 'hod.cs@uni.edu.ng',
    phone: '+234 801 222 3333',
    stats: { students: 453, staff: 18, courses: 42, avgGPA: 3.85 },
    staff: [
        { name: 'Dr. Adewale Johnson', role: 'Head of Department', rank: 'Senior Lecturer' },
        { name: 'Prof. Sarah Okon', role: 'Lecturer', rank: 'Professor' },
        { name: 'Mr. David Lee', role: 'Technologist', rank: 'Technologist I' },
    ],
    courses: [
        { code: 'CSC 101', title: 'Intro to Computer Science', unit: 3, level: '100L' },
        { code: 'CSC 201', title: 'Programming I', unit: 3, level: '200L' },
        { code: 'CSC 301', title: 'Operating Systems', unit: 3, level: '300L' },
        { code: 'CSC 401', title: 'Software Engineering', unit: 3, level: '400L' },
    ],

};

export default function DepartmentDetail() {
    const params = useParams();
    const id = params.id as string; // in real app fetch by ID

    return (
        <div className="space-y-6">
            <div className="flex items-center gap-4">
                <Link href="/dean/departments">
                    <Button variant="ghost" size="icon">
                        <ArrowLeft className="h-5 w-5" />
                    </Button>
                </Link>
                <div>
                    <div className="flex items-center gap-3">
                        <h1 className="text-3xl font-bold text-[#485550]">{deptData.name} ({id})</h1>
                        <span className="bg-[#C0EB6A]/20 text-[#485550] text-xs px-2 py-1 rounded-full font-bold">Active</span>
                    </div>
                    <p className="text-[#485550]/70 mt-1">
                        Department Overview
                    </p>
                </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
                {/* Info Card */}
                <Card className="md:col-span-1 border-[#F4F6F0] h-fit">
                    <CardHeader>
                        <CardTitle className="text-lg text-[#485550]">HOD Contact</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-4">
                        <div>
                            <div className="h-16 w-16 rounded-full bg-[#F4F6F0] flex items-center justify-center mx-auto mb-3">
                                <Users className="h-8 w-8 text-[#485550]/60" />
                            </div>
                            <p className="text-center font-bold text-[#485550]">{deptData.hod}</p>
                            <p className="text-center text-xs text-[#485550]/60">Head of Department</p>
                        </div>
                        <div className="space-y-2 text-sm pt-4 border-t border-[#F4F6F0]">
                            <div className="flex items-center gap-2 text-[#485550]/80">
                                <Mail className="h-4 w-4 shrink-0" /> {deptData.email}
                            </div>
                            <div className="flex items-center gap-2 text-[#485550]/80">
                                <Phone className="h-4 w-4 shrink-0" /> {deptData.phone}
                            </div>
                        </div>
                    </CardContent>
                </Card>

                {/* Main Tabs */}
                <div className="md:col-span-3 space-y-6">
                    <div className="grid grid-cols-4 gap-4">
                        <Card className="border-[#F4F6F0] p-4 flex items-center justify-between">
                            <div>
                                <p className="text-xs text-[#485550]/60">Students</p>
                                <p className="text-2xl font-bold text-[#485550]">{deptData.stats.students}</p>
                            </div>
                            <GraduationCap className="h-8 w-8 text-[#485550]/10" />
                        </Card>
                        <Card className="border-[#F4F6F0] p-4 flex items-center justify-between">
                            <div>
                                <p className="text-xs text-[#485550]/60">Staff</p>
                                <p className="text-2xl font-bold text-[#485550]">{deptData.stats.staff}</p>
                            </div>
                            <Users className="h-8 w-8 text-[#485550]/10" />
                        </Card>
                        <Card className="border-[#F4F6F0] p-4 flex items-center justify-between">
                            <div>
                                <p className="text-xs text-[#485550]/60">Courses</p>
                                <p className="text-2xl font-bold text-[#485550]">{deptData.stats.courses}</p>
                            </div>
                            <BookOpen className="h-8 w-8 text-[#485550]/10" />
                        </Card>
                        <Card className="border-[#F4F6F0] p-4 flex items-center justify-between bg-[#485550] text-white">
                            <div>
                                <p className="text-xs text-white/60">Avg GPA</p>
                                <p className="text-2xl font-bold text-[#C0EB6A]">{deptData.stats.avgGPA}</p>
                            </div>
                            <Building2 className="h-8 w-8 text-white/20" />
                        </Card>
                    </div>

                    <Tabs defaultValue="courses" className="w-full">
                        <TabsList className="bg-[#F4F6F0]">
                            <TabsTrigger value="courses" className="data-[state=active]:bg-white">Courses</TabsTrigger>
                            <TabsTrigger value="staff" className="data-[state=active]:bg-white">Staff List</TabsTrigger>
                        </TabsList>
                        <TabsContent value="courses">
                            <Card className="border-[#F4F6F0]">
                                <Table>
                                    <TableHeader>
                                        <TableRow>
                                            <TableHead>Code</TableHead>
                                            <TableHead>Title</TableHead>
                                            <TableHead>Unit</TableHead>
                                            <TableHead>Level</TableHead>
                                        </TableRow>
                                    </TableHeader>
                                    <TableBody>
                                        {deptData.courses.map((c) => (
                                            <TableRow key={c.code}>
                                                <TableCell className="font-bold text-[#485550]">{c.code}</TableCell>
                                                <TableCell>{c.title}</TableCell>
                                                <TableCell>{c.unit}</TableCell>
                                                <TableCell>{c.level}</TableCell>
                                            </TableRow>
                                        ))}
                                    </TableBody>
                                </Table>
                            </Card>
                        </TabsContent>
                        <TabsContent value="staff">
                            <Card className="border-[#F4F6F0]">
                                <Table>
                                    <TableHeader>
                                        <TableRow>
                                            <TableHead>Name</TableHead>
                                            <TableHead>Role</TableHead>
                                            <TableHead>Rank</TableHead>
                                        </TableRow>
                                    </TableHeader>
                                    <TableBody>
                                        {deptData.staff.map((s, i) => (
                                            <TableRow key={i}>
                                                <TableCell className="font-bold text-[#485550]">{s.name}</TableCell>
                                                <TableCell>{s.role}</TableCell>
                                                <TableCell>{s.rank}</TableCell>
                                            </TableRow>
                                        ))}
                                    </TableBody>
                                </Table>
                            </Card>
                        </TabsContent>

                    </Tabs>
                </div>
            </div>
        </div>
    );
}
