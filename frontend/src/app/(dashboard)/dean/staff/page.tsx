'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Users, Mail, Phone, Building2, Calendar, Star } from 'lucide-react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';

const staff = [
    { id: 1, name: 'Dr. Adewale Johnson', role: 'HOD', dept: 'Computer Science', email: 'adewale@uni.edu.ng' },
    { id: 2, name: 'Prof. Sarah Okon', role: 'Professor', dept: 'Mathematics', email: 's.okon@uni.edu.ng' },
    { id: 3, name: 'Dr. Emeka Nnamdi', role: 'Senior Lecturer', dept: 'Physics', email: 'e.nnamdi@uni.edu.ng' },
];

export default function DeanStaff() {
    return (
        <div className="space-y-6">
            <div>
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                    <div>
                        <h1 className="text-3xl font-bold text-[#485550]">Faculty Staff Directory</h1>
                        <p className="text-[#485550]/70 mt-1">Academic and non-academic staff in your faculty</p>
                    </div>
                    <div className="flex gap-2">
                        <Link href="/dean/staff/leave">
                            <Button variant="outline" className="border-[#485550]/20 text-[#485550]">
                                <Calendar className="mr-2 h-4 w-4" /> Leave Requests
                            </Button>
                        </Link>
                    </div>
                </div>      </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {staff.map((s) => (
                    <Card key={s.id} className="border-[#F4F6F0]">
                        <CardHeader className="pb-2">
                            <div className="flex items-center gap-3">
                                <div className="h-10 w-10 rounded-full bg-[#485550] flex items-center justify-center text-white font-bold">
                                    {s.name[0]}
                                </div>
                                <div>
                                    <CardTitle className="text-base text-[#485550]">{s.name}</CardTitle>
                                    <p className="text-xs text-[#485550]/60">{s.role}</p>
                                </div>
                            </div>
                        </CardHeader>
                        <CardContent className="space-y-2 text-sm">
                            <div className="flex items-center gap-2 text-[#485550]/80">
                                <Building2 className="h-4 w-4 opacity-50" /> {s.dept}
                            </div>
                            <div className="flex items-center gap-2 text-[#485550]/80">
                                <Mail className="h-4 w-4 opacity-50" /> {s.email}
                            </div>
                        </CardContent>
                    </Card>
                ))}
            </div>
        </div>
    );
}
