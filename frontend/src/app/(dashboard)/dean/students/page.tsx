'use client';

import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Search, GraduationCap, Gavel, ArrowRightLeft } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import Link from 'next/link';
import { Button } from '@/components/ui/button';

const students = [
    { id: 1, name: 'Oluwaseun Adebayo', matric: 'UNI/2020/CSC/045', dept: 'Computer Science', level: '400L' },
    { id: 2, name: 'Chioma Nwosu', matric: 'UNI/2021/MTH/022', dept: 'Mathematics', level: '300L' },
    { id: 3, name: 'Ibrahim Musa', matric: 'UNI/2022/PHY/105', dept: 'Physics', level: '200L' },
    { id: 4, name: 'Sarah Idahosa', matric: 'UNI/2023/CHM/009', dept: 'Chemistry', level: '100L' },
];

export default function DeanStudents() {
    return (
        <div className="space-y-6">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div>
                    <h1 className="text-3xl font-bold text-[#485550]">Faculty Student Registry</h1>
                    <p className="text-[#485550]/70 mt-1">All registered students in the faculty</p>
                </div>
                <div className="flex gap-2">
                    <Link href="/dean/students/disciplinary">
                        <Button variant="outline" className="border-red-200 text-red-600 hover:bg-red-50">
                            <Gavel className="mr-2 h-4 w-4" /> Disciplinary
                        </Button>
                    </Link>
                    <Link href="/dean/students/transfer">
                        <Button className="bg-[#485550] hover:bg-[#3a4543]">
                            <ArrowRightLeft className="mr-2 h-4 w-4" /> Transfers
                        </Button>
                    </Link>
                </div>
            </div>

            <div className="relative w-full md:w-96">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-[#485550]/40" />
                <Input placeholder="Search students..." className="pl-9 border-[#485550]/20" />
            </div>

            <div className="grid gap-4">
                {students.map((s) => (
                    <Card key={s.id} className="border-[#F4F6F0] hover:bg-[#F4F6F0]/30 transition-colors">
                        <CardContent className="p-4 flex items-center justify-between">
                            <div className="flex items-center gap-4">
                                <div className="h-10 w-10 rounded-full bg-[#C0EB6A]/20 flex items-center justify-center text-[#485550]">
                                    <GraduationCap className="h-5 w-5" />
                                </div>
                                <div>
                                    <p className="font-semibold text-[#485550]">{s.name}</p>
                                    <p className="text-xs text-[#485550]/60 font-mono">{s.matric}</p>
                                </div>
                            </div>
                            <div className="text-right hidden sm:block">
                                <p className="text-sm text-[#485550]">{s.dept}</p>
                                <Badge variant="outline" className="mt-1 border-[#485550]/20 text-[#485550]">{s.level}</Badge>
                            </div>
                        </CardContent>
                    </Card>
                ))}
            </div>
        </div>
    );
}
