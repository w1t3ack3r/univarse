'use client';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Search, Mail, Phone, Users, BookOpen, GraduationCap, ArrowRight } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';

// Mock Data
const departments = [
    {
        id: 'CSC',
        name: 'Computer Science',
        hod: 'Dr. Adewale Johnson',
        email: 'hod.cs@uni.edu.ng',
        phone: '+234 801 222 3333',
        students: 450,
        courses: 24,
        staff: 12
    },
    {
        id: 'MTH',
        name: 'Mathematics',
        hod: 'Prof. Sarah Okon',
        email: 'hod.math@uni.edu.ng',
        phone: '+234 802 333 4444',
        students: 320,
        courses: 18,
        staff: 9
    },
    {
        id: 'PHY',
        name: 'Physics',
        hod: 'Dr. Emeka Nnamdi',
        email: 'hod.phy@uni.edu.ng',
        phone: '+234 803 444 5555',
        students: 280,
        courses: 20,
        staff: 10
    },
    {
        id: 'CHM',
        name: 'Chemistry',
        hod: 'Prof. Musa Ibrahim',
        email: 'hod.chm@uni.edu.ng',
        phone: '+234 804 555 6666',
        students: 310,
        courses: 22,
        staff: 11
    },
    {
        id: 'BIO',
        name: 'Biology',
        hod: 'Dr. Grace Okafor',
        email: 'hod.bio@uni.edu.ng',
        phone: '+234 805 666 7777',
        students: 500,
        courses: 26,
        staff: 15
    }
];

export default function DeanDepartments() {
    const [searchTerm, setSearchTerm] = useState('');

    const filteredDepts = departments.filter(dept =>
        dept.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        dept.hod.toLowerCase().includes(searchTerm.toLowerCase())
    );

    return (
        <div className="space-y-6">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div>
                    <h1 className="text-3xl font-bold text-[#485550]">Faculty Departments</h1>
                    <p className="text-[#485550]/70 mt-1">
                        Overview of all departments under your supervision
                    </p>
                </div>
                <div className="relative w-full sm:w-64">
                    <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-[#485550]/40" />
                    <Input
                        placeholder="Search departments..."
                        className="pl-9 border-[#485550]/20 bg-[#F4F6F0]/50"
                        value={searchTerm}
                        onChange={(e) => setSearchTerm(e.target.value)}
                    />
                </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
                {filteredDepts.map((dept) => (
                    <Link key={dept.id} href={`/dean/departments/${dept.id}`}>
                        <Card className="border-[#F4F6F0] hover:shadow-xl transition-all duration-300 group">
                            <CardHeader className="pb-4">
                                <div className="flex justify-between items-start">
                                    <div className="h-10 w-10 rounded-lg bg-[#C0EB6A]/20 flex items-center justify-center text-[#485550] font-bold text-lg">
                                        {dept.id}
                                    </div>
                                    <Badge variant="outline" className="border-[#485550]/20 text-[#485550]">
                                        Active
                                    </Badge>
                                </div>
                                <CardTitle className="text-xl text-[#485550] mt-4">Department of {dept.name}</CardTitle>
                                <CardDescription className="flex items-center gap-2 mt-1">
                                    <span className="font-medium text-[#485550]">HOD:</span> {dept.hod}
                                </CardDescription>
                            </CardHeader>
                            <CardContent className="space-y-4">
                                <div className="grid grid-cols-3 gap-2 py-3 border-y border-[#F4F6F0]">
                                    <div className="text-center">
                                        <div className="text-lg font-bold text-[#485550]">{dept.students}</div>
                                        <div className="text-xs text-[#485550]/60">Students</div>
                                    </div>
                                    <div className="text-center border-x border-[#F4F6F0]">
                                        <div className="text-lg font-bold text-[#485550]">{dept.courses}</div>
                                        <div className="text-xs text-[#485550]/60">Courses</div>
                                    </div>
                                    <div className="text-center">
                                        <div className="text-lg font-bold text-[#485550]">{dept.staff}</div>
                                        <div className="text-xs text-[#485550]/60">Staff</div>
                                    </div>
                                </div>

                                <div className="space-y-2">
                                    <div className="flex items-center gap-3 text-sm text-[#485550]/80">
                                        <Mail className="h-4 w-4 text-[#485550]/50" />
                                        {dept.email}
                                    </div>
                                    <div className="flex items-center gap-3 text-sm text-[#485550]/80">
                                        <Phone className="h-4 w-4 text-[#485550]/50" />
                                        {dept.phone}
                                    </div>
                                </div>
                            </CardContent>
                        </Card>
                    </Link>
                ))}
            </div>
        </div >
    );
}
