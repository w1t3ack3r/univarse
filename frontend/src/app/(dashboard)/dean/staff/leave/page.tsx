'use client';

import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
    Calendar,
    CheckCircle,
    XCircle,
    Clock,
    FileText,
    User,
    ArrowLeft
} from 'lucide-react';
import { toast } from 'sonner';
import Link from 'next/link';

const leaveRequests = [
    {
        id: 'LV-001',
        staff: 'Dr. Adewale Johnson',
        role: 'HOD, Computer Science',
        type: 'Annual Leave',
        duration: '14 Days',
        dates: 'Mar 15 - Mar 29, 2024',
        reason: 'Annual vacation time.',
        status: 'PENDING_DEAN',
        reliever: 'Dr. Kemi Adeyemi'
    },
    {
        id: 'LV-002',
        staff: 'Mr. James Okon',
        role: 'Technologist, Physics Dept',
        type: 'Sick Leave',
        duration: '3 Days',
        dates: 'Feb 10 - Feb 13, 2024',
        reason: 'Malaria treatment.',
        status: 'APPROVED',
        reliever: 'N/A'
    },
    {
        id: 'LV-003',
        staff: 'Prof. Sarah Okon',
        role: 'HOD, Mathematics',
        type: 'Sabbatical',
        duration: '1 Year',
        dates: 'Sept 1, 2024 - Aug 31, 2025',
        reason: 'Research Fellowship at MIT.',
        status: 'PENDING_DEAN',
        reliever: 'Dr. Musa Ibrahim'
    }
];

export default function LeaveRequests() {
    const [activeTab, setActiveTab] = useState('pending');

    const handleApprove = (id: string, name: string) => {
        toast.success(`Leave Approved`, {
            description: `Leave request for ${name} has been approved.`
        });
    };

    return (
        <div className="space-y-6">
            <div className="flex items-center gap-4">
                <Link href="/dean/staff">
                    <Button variant="ghost" size="icon">
                        <ArrowLeft className="h-5 w-5" />
                    </Button>
                </Link>
                <div>
                    <h1 className="text-3xl font-bold text-[#485550]">Leave Requests</h1>
                    <p className="text-[#485550]/70 mt-1">
                        Manage leave applications for HODs and Faculty Staff
                    </p>
                </div>
            </div>

            <div className="flex justify-between items-center">
                <Tabs value={activeTab} onValueChange={setActiveTab} className="w-[400px]">
                    <TabsList className="bg-[#F4F6F0]">
                        <TabsTrigger value="pending" className="data-[state=active]:bg-white">Pending Approval</TabsTrigger>
                        <TabsTrigger value="history" className="data-[state=active]:bg-white">History</TabsTrigger>
                    </TabsList>
                </Tabs>
            </div>

            <div className="grid gap-4">
                {leaveRequests.filter(req => activeTab === 'pending' ? req.status === 'PENDING_DEAN' : req.status !== 'PENDING_DEAN').map((req) => (
                    <Card key={req.id} className="border-[#F4F6F0]">
                        <CardContent className="p-6">
                            <div className="flex flex-col md:flex-row justify-between gap-6">
                                <div className="flex gap-4">
                                    <div className="h-12 w-12 rounded-full bg-[#F4F6F0] flex items-center justify-center shrink-0">
                                        <User className="h-6 w-6 text-[#485550]/60" />
                                    </div>
                                    <div>
                                        <h3 className="font-bold text-[#485550] text-lg">{req.staff}</h3>
                                        <p className="text-sm text-[#485550]/60 mb-2">{req.role}</p>
                                        <div className="flex flex-wrap gap-2 text-sm">
                                            <Badge variant="outline" className="bg-[#F4F6F0] border-0 text-[#485550]">
                                                {req.type}
                                            </Badge>
                                            <span className="flex items-center text-[#485550]/70 bg-white border border-[#F4F6F0] px-2 py-0.5 rounded-full text-xs">
                                                <Calendar className="w-3 h-3 mr-1" /> {req.dates}
                                            </span>
                                            <span className="flex items-center text-[#485550]/70 bg-white border border-[#F4F6F0] px-2 py-0.5 rounded-full text-xs">
                                                <Clock className="w-3 h-3 mr-1" /> {req.duration}
                                            </span>
                                        </div>
                                        <div className="mt-3 text-sm border-l-2 border-[#C0EB6A] pl-3 py-1 bg-[#F4F6F0]/30 rounded-r-md">
                                            <span className="font-semibold text-[#485550]/80">Reason:</span> {req.reason}
                                        </div>
                                        {req.reliever !== 'N/A' && (
                                            <p className="text-xs text-[#485550]/60 mt-2">
                                                Covered by: <span className="font-medium">{req.reliever}</span>
                                            </p>
                                        )}
                                    </div>
                                </div>

                                <div className="flex flex-col items-end gap-3 justify-center">
                                    {req.status === 'PENDING_DEAN' ? (
                                        <div className="flex gap-2">
                                            <Button variant="outline" className="border-red-200 text-red-600 hover:bg-red-50">
                                                Reject
                                            </Button>
                                            <Button
                                                className="bg-[#485550] hover:bg-[#3a4543]"
                                                onClick={() => handleApprove(req.id, req.staff)}
                                            >
                                                Approve Request
                                            </Button>
                                        </div>
                                    ) : (
                                        <Badge className="bg-green-100 text-green-700 border-green-200 flex items-center gap-1">
                                            <CheckCircle className="w-3 h-3" /> Approved
                                        </Badge>
                                    )}
                                </div>
                            </div>
                        </CardContent>
                    </Card>
                ))}
            </div>
        </div>
    );
}
