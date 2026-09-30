'use client';

import { useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
    BookOpen,
    FileText,
    CheckCircle,
    Clock,
    AlertCircle,
    Plus,
    ArrowRight,
    ChevronRight,
    MoreHorizontal
} from 'lucide-react';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { toast } from 'sonner';

// Mock Proposals
const proposals = [
    {
        id: 'PROP-001',
        type: 'NEW_COURSE',
        title: 'Introduction to Artificial Intelligence',
        code: 'CSC 308',
        dept: 'Computer Science',
        units: 3,
        submittedBy: 'Dr. Adewale Johnson',
        date: '2024-02-15',
        status: 'PENDING_BOARD',
        description: 'A foundational course covering ML basics, Neural Networks, and Ethics in AI.'
    },
    {
        id: 'PROP-002',
        type: 'UNIT_CHANGE',
        title: 'Advanced Calculus',
        code: 'MTH 301',
        dept: 'Mathematics',
        units: '3 -> 4',
        submittedBy: 'Prof. Sarah Okon',
        date: '2024-02-12',
        status: 'APPROVED_FACULTY',
        description: 'Increasing unit load to accommodate new syllabus requirements on vector fields.'
    },
    {
        id: 'PROP-003',
        type: 'CONTENT_REVISION',
        title: 'Physics Lab I',
        code: 'PHY 107',
        dept: 'Physics',
        units: 1,
        submittedBy: 'Dr. Emeka Nnamdi',
        date: '2024-02-10',
        status: 'RETURNED',
        description: 'Updating practical manual to include digital oscillation experiments.'
    }
];

export default function CurriculumManagement() {
    const [activeTab, setActiveTab] = useState('pending');

    const getStatusBadge = (status: string) => {
        switch (status) {
            case 'PENDING_BOARD':
                return <Badge className="bg-amber-100 text-amber-700 border-amber-200"><Clock className="w-3 h-3 mr-1" /> Board Review</Badge>;
            case 'APPROVED_FACULTY':
                return <Badge className="bg-blue-100 text-blue-700 border-blue-200"><CheckCircle className="w-3 h-3 mr-1" /> Approved (Faculty)</Badge>;
            case 'SENT_SENATE':
                return <Badge className="bg-[#C0EB6A]/20 text-[#485550] border-[#C0EB6A]"><FileText className="w-3 h-3 mr-1" /> Senate Ratification</Badge>;
            case 'RETURNED':
                return <Badge className="bg-red-100 text-red-700 border-red-200"><AlertCircle className="w-3 h-3 mr-1" /> Returned</Badge>;
            default:
                return <Badge variant="outline">{status}</Badge>;
        }
    };

    const handleApprove = (id: string) => {
        toast.success('Proposal Approved', {
            description: 'The curriculum change has been approved by the Faculty Board.'
        });
    };

    return (
        <div className="space-y-6">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div>
                    <h1 className="text-3xl font-bold text-[#485550]">Board of Studies</h1>
                    <p className="text-[#485550]/70 mt-1">
                        Curriculum reviews and course allocation approvals
                    </p>
                </div>
                <Button className="bg-[#485550] hover:bg-[#3a4543]">
                    <Plus className="mr-2 h-4 w-4" /> New Proposal
                </Button>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                {/* Stats */}
                <Card className="border-[#F4F6F0] lg:col-span-2">
                    <CardHeader>
                        <CardTitle className="text-[#485550]">Overview</CardTitle>
                    </CardHeader>
                    <CardContent className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                        <div className="p-4 rounded-lg bg-[#F4F6F0] border border-[#485550]/10">
                            <p className="text-sm font-medium text-[#485550]/70">Pending Review</p>
                            <p className="text-2xl font-bold text-[#485550] mt-1">4</p>
                        </div>
                        <div className="p-4 rounded-lg bg-[#F4F6F0] border border-[#485550]/10">
                            <p className="text-sm font-medium text-[#485550]/70">Senate Ready</p>
                            <p className="text-2xl font-bold text-[#C0EB6A] mt-1">12</p>
                        </div>
                        <div className="p-4 rounded-lg bg-[#F4F6F0] border border-[#485550]/10">
                            <p className="text-sm font-medium text-[#485550]/70">Active Curriculums</p>
                            <p className="text-2xl font-bold text-[#485550] mt-1">8</p>
                        </div>
                    </CardContent>
                </Card>

                <Card className="border-[#F4F6F0] bg-[#485550] text-white">
                    <CardHeader>
                        <CardTitle className="text-white">Next Board Meeting</CardTitle>
                        <CardDescription className="text-white/70">Scheduled Review Session</CardDescription>
                    </CardHeader>
                    <CardContent>
                        <div className="flex items-center gap-4 mb-4">
                            <div className="h-12 w-12 rounded-lg bg-[#C0EB6A] flex flex-col items-center justify-center text-[#485550] font-bold">
                                <span className="text-xs uppercase">Feb</span>
                                <span className="text-xl">28</span>
                            </div>
                            <div>
                                <p className="font-medium">Faculty Board Room</p>
                                <p className="text-sm text-white/60">10:00 AM WAT</p>
                            </div>
                        </div>
                        <Button variant="outline" className="w-full border-white/20 text-white hover:bg-white/10 hover:text-white">
                            View Agenda
                        </Button>
                    </CardContent>
                </Card>
            </div>

            {/* Proposals List */}
            <Card className="border-[#F4F6F0]">
                <CardHeader>
                    <div className="flex justify-between items-center">
                        <CardTitle className="text-[#485550]">Active Proposals</CardTitle>
                        <Tabs value={activeTab} onValueChange={setActiveTab} className="w-[400px]">
                            <TabsList className="bg-[#F4F6F0]">
                                <TabsTrigger value="pending" className="data-[state=active]:bg-white">Pending</TabsTrigger>
                                <TabsTrigger value="history" className="data-[state=active]:bg-white">History</TabsTrigger>
                            </TabsList>
                        </Tabs>
                    </div>
                </CardHeader>
                <CardContent>
                    <div className="space-y-4">
                        {proposals.filter(p => activeTab === 'pending' ? p.status === 'PENDING_BOARD' : p.status !== 'PENDING_BOARD').map((prop) => (
                            <div key={prop.id} className="group flex items-start justify-between p-4 rounded-xl border border-[#F4F6F0] hover:border-[#C0EB6A]/50 hover:bg-[#F4F6F0]/30 transition-all">
                                <div className="flex gap-4">
                                    <div className={`mt-1 h-10 w-10 shrink-0 rounded-full flex items-center justify-center ${prop.type === 'NEW_COURSE' ? 'bg-blue-100 text-blue-600' :
                                        prop.type === 'UNIT_CHANGE' ? 'bg-amber-100 text-amber-600' :
                                            'bg-purple-100 text-purple-600'
                                        }`}>
                                        <BookOpen className="h-5 w-5" />
                                    </div>
                                    <div>
                                        <div className="flex items-center gap-2">
                                            <h3 className="font-semibold text-[#485550]">{prop.title}</h3>
                                            <Badge variant="outline" className="text-xs font-normal border-[#485550]/20 text-[#485550]/70">
                                                {prop.code}
                                            </Badge>
                                        </div>
                                        <p className="text-sm text-[#485550]/70 mt-1 line-clamp-1">{prop.description}</p>
                                        <div className="flex items-center gap-4 mt-2 text-xs text-[#485550]/50">
                                            <span>{prop.dept}</span>
                                            <span>•</span>
                                            <span>Submitted by {prop.submittedBy}</span>
                                            <span>•</span>
                                            <span>{prop.date}</span>
                                        </div>
                                    </div>
                                </div>
                                <div className="flex flex-col items-end gap-3">
                                    {getStatusBadge(prop.status)}
                                    <div className="flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                                        <Button size="sm" variant="ghost" className="h-8 w-8 p-0">
                                            <MoreHorizontal className="h-4 w-4" />
                                        </Button>
                                        <Button size="sm" variant="outline" className="h-8 text-xs border-[#485550]/20">
                                            Review
                                        </Button>
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
