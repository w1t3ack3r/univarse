'use client';

import { useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
    ArrowRightLeft,
    Clock,
    CheckCircle,
    XCircle,
    ArrowLeft,
    FileText,
    PauseCircle
} from 'lucide-react';
import { toast } from 'sonner';
import Link from 'next/link';

// Mock Transfers
const requests = [
    {
        id: 'TR-001',
        student: 'Chinedu Okeke',
        matric: 'UNI/22/ENG/045',
        type: 'INTER_FACULTY_TRANSFER',
        from: 'Engineering (Civil)',
        to: 'Physical Sciences (Computer Science)',
        cgpa: '3.85',
        reason: 'Stronger aptitude for programming than structural mechanics.',
        date: '2024-02-18',
        status: 'PENDING_DEAN_RECEIVING'
    },
    {
        id: 'TR-002',
        student: 'Amina Yusuf',
        matric: 'UNI/21/CSC/022',
        type: 'DEFERMENT',
        from: 'Computer Science',
        to: 'N/A',
        cgpa: '4.10',
        reason: 'Medical reasons requiring long-term treatment.',
        date: '2024-02-15',
        status: 'PENDING_DEAN_APPROVAL'
    },
    {
        id: 'TR-003',
        student: 'John Smith',
        matric: 'UNI/23/MTH/011',
        type: 'CHANGE_OF_COURSE',
        from: 'Mathematics',
        to: 'Statistics',
        cgpa: '2.50',
        reason: 'Academic difficulty in pure mathematics.',
        date: '2024-01-30',
        status: 'APPROVED'
    }
];

export default function Transfers() {
    const [activeTab, setActiveTab] = useState('pending');

    const handleAction = (request: any, action: 'approve' | 'reject') => {
        if (action === 'approve') {
            toast.success('Request Approved', {
                description: `${request.type} for ${request.student} has been authorized.`
            });
        } else {
            toast.info('Request Returned', {
                description: 'The student has been notified of the rejection.'
            });
        }
    };

    return (
        <div className="space-y-6">
            <div className="flex items-center gap-4">
                <Link href="/dean/students">
                    <Button variant="ghost" size="icon">
                        <ArrowLeft className="h-5 w-5" />
                    </Button>
                </Link>
                <div>
                    <h1 className="text-3xl font-bold text-[#485550]">Transfers & Deferments</h1>
                    <p className="text-[#485550]/70 mt-1">
                        Approve student movements and study suspensions
                    </p>
                </div>
            </div>

            <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
                <TabsList className="bg-[#F4F6F0]">
                    <TabsTrigger value="pending" className="data-[state=active]:bg-white">Pending Requests</TabsTrigger>
                    <TabsTrigger value="history" className="data-[state=active]:bg-white">History</TabsTrigger>
                </TabsList>
            </Tabs>

            <div className="grid gap-4">
                {requests.filter(r => activeTab === 'pending' ? r.status.includes('PENDING') : !r.status.includes('PENDING')).map((req) => (
                    <Card key={req.id} className="border-[#F4F6F0] overflow-hidden">
                        <CardContent className="p-0">
                            <div className="flex flex-col md:flex-row">
                                <div className={`w-2 md:w-2 shrink-0 ${req.type === 'DEFERMENT' ? 'bg-amber-400' : 'bg-blue-400'
                                    }`} />
                                <div className="flex-1 p-6">
                                    <div className="flex flex-col md:flex-row justify-between gap-6">
                                        <div>
                                            <div className="flex items-center gap-2 mb-1">
                                                <Badge variant="outline" className={`border-0 font-normal ${req.type === 'DEFERMENT' ? 'bg-amber-100 text-amber-700' : 'bg-blue-100 text-blue-700'
                                                    }`}>
                                                    {req.type === 'DEFERMENT' ? <PauseCircle className="w-3 h-3 mr-1" /> : <ArrowRightLeft className="w-3 h-3 mr-1" />}
                                                    {req.type.replace(/_/g, ' ')}
                                                </Badge>
                                                <span className="text-xs text-[#485550]/50">{req.date}</span>
                                            </div>
                                            <h3 className="font-bold text-[#485550] text-lg">{req.student}</h3>
                                            <p className="text-sm font-mono text-[#485550]/60 mb-3">{req.matric}</p>

                                            <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-2 text-sm">
                                                <div>
                                                    <span className="text-[#485550]/50">Current Info:</span>
                                                    <p className="font-medium text-[#485550]">{req.from} (CGPA: {req.cgpa})</p>
                                                </div>
                                                {req.to !== 'N/A' && (
                                                    <div>
                                                        <span className="text-[#485550]/50">Target Dept:</span>
                                                        <p className="font-medium text-[#485550]">{req.to}</p>
                                                    </div>
                                                )}
                                            </div>
                                            <div className="mt-3 text-sm bg-[#F4F6F0]/50 p-3 rounded-lg text-[#485550]/80">
                                                <span className="font-semibold">Reason:</span> {req.reason}
                                            </div>
                                        </div>

                                        <div className="flex flex-col justify-center gap-3 min-w-[150px]">
                                            {req.status.includes('PENDING') ? (
                                                <>
                                                    <Button className="bg-[#485550] hover:bg-[#3a4543]" onClick={() => handleAction(req, 'approve')}>
                                                        <CheckCircle className="mr-2 h-4 w-4" /> Approve
                                                    </Button>
                                                    <Button variant="outline" className="border-red-200 text-red-600 hover:bg-red-50" onClick={() => handleAction(req, 'reject')}>
                                                        <XCircle className="mr-2 h-4 w-4" /> Reject
                                                    </Button>
                                                </>
                                            ) : (
                                                <Badge className="bg-green-100 text-green-700 border-green-200 justify-center py-2">
                                                    Processed
                                                </Badge>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </CardContent>
                    </Card>
                ))}
            </div>
        </div>
    );
}
