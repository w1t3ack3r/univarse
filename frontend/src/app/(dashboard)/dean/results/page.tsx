'use client';

import { useState } from 'react';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { toast } from 'sonner';
import {
    Search,
    FileText,
    CheckCircle,
    XCircle,
    Clock,
    Eye,
    ArrowRight,
    Download,
    Users,
    AlertCircle,
    Loader2,
    FileSpreadsheet,
    Building2
} from 'lucide-react';
import {
    Accordion,
    AccordionContent,
    AccordionItem,
    AccordionTrigger,
} from "@/components/ui/accordion";
import Link from 'next/link';

// Mock Data for Result Batches
const initialBatches = [
    {
        id: 'RES-001',
        courseCode: 'CSC 401',
        courseTitle: 'Software Engineering II',
        level: '400L',
        session: '2024/2025',
        semester: 'Harmattan',
        department: 'Computer Science',
        submittedBy: 'Dr. Adewale Johnson',
        date: '2024-02-14',
        studentsCount: 124,
        passRate: '88%',
        status: 'PENDING'
    },
    {
        id: 'RES-002',
        courseCode: 'MTH 202',
        courseTitle: 'Linear Algebra',
        level: '200L',
        session: '2024/2025',
        semester: 'Harmattan',
        department: 'Mathematics',
        submittedBy: 'Prof. Sarah Okon',
        date: '2024-02-13',
        studentsCount: 250,
        passRate: '65%',
        status: 'PENDING'
    },
    {
        id: 'RES-003',
        courseCode: 'PHY 101',
        courseTitle: 'General Physics I',
        level: '100L',
        session: '2024/2025',
        semester: 'Harmattan',
        department: 'Physics',
        submittedBy: 'Dr. Emeka Nnamdi',
        date: '2024-02-12',
        studentsCount: 850,
        passRate: '72%',
        status: 'RETURNED'
    },
    {
        id: 'RES-004',
        courseCode: 'CSC 201',
        courseTitle: 'Intro to Programming',
        level: '200L',
        session: '2024/2025',
        semester: 'Harmattan',
        department: 'Computer Science',
        submittedBy: 'Dr. Adewale Johnson',
        date: '2024-02-10',
        studentsCount: 180,
        passRate: '92%',
        status: 'APPROVED'
    },
];

export default function ResultApprovals() {
    const [activeTab, setActiveTab] = useState('pending');
    const [searchTerm, setSearchTerm] = useState('');
    const [batches, setBatches] = useState(initialBatches);

    // Action States
    const [processingId, setProcessingId] = useState<string | null>(null);
    const [rejectDialogOpen, setRejectDialogOpen] = useState(false);
    const [selectedBatch, setSelectedBatch] = useState<any>(null);
    const [rejectReason, setRejectReason] = useState('');

    const handleApprove = async (batch: any) => {
        if (!confirm(`Are you sure you want to approve results for ${batch.courseCode}? This action cannot be undone.`)) return;

        setProcessingId(batch.id);
        // Simulate API call
        await new Promise(resolve => setTimeout(resolve, 1500));

        setBatches(current =>
            current.map(b => b.id === batch.id ? { ...b, status: 'APPROVED' } : b)
        );

        toast.success(`Results for ${batch.courseCode} approved successfully`, {
            description: 'The results have been forwarded to the Senate.'
        });
        setProcessingId(null);
    };

    const openRejectDialog = (batch: any) => {
        setSelectedBatch(batch);
        setRejectReason('');
        setRejectDialogOpen(true);
    };

    const handleReject = async () => {
        if (!selectedBatch || !rejectReason) {
            toast.error('Please provide a reason for rejection');
            return;
        }

        setProcessingId(selectedBatch.id);
        // Simulate API call
        await new Promise(resolve => setTimeout(resolve, 1000));

        setBatches(current =>
            current.map(b => b.id === selectedBatch.id ? { ...b, status: 'RETURNED' } : b)
        );

        toast.warning(`Results for ${selectedBatch.courseCode} returned`, {
            description: 'Notification sent to HOD with your comments.'
        });

        setRejectDialogOpen(false);
        setSelectedBatch(null);
        setProcessingId(null);
    };

    const getStatusBadge = (status: string) => {
        switch (status) {
            case 'PENDING':
                return <Badge className="bg-amber-100 text-amber-700 border-amber-200 hover:bg-amber-200"><Clock className="w-3 h-3 mr-1" /> Pending Review</Badge>;
            case 'APPROVED':
                return <Badge className="bg-green-100 text-green-700 border-green-200 hover:bg-green-200"><CheckCircle className="w-3 h-3 mr-1" /> Senate Ready</Badge>;
            case 'RETURNED':
                return <Badge className="bg-red-100 text-red-700 border-red-200 hover:bg-red-200"><XCircle className="w-3 h-3 mr-1" /> Returned to HOD</Badge>;
            default:
                return <Badge variant="outline">{status}</Badge>;
        }
    };

    const filteredBatches = batches.filter(batch => {
        const matchesSearch = batch.courseCode.toLowerCase().includes(searchTerm.toLowerCase()) ||
            batch.courseTitle.toLowerCase().includes(searchTerm.toLowerCase());
        const matchesTab = activeTab === 'all' ? true : batch.status === activeTab.toUpperCase();
        return matchesSearch && matchesTab;
    });

    return (
        <div className="space-y-6">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div>
                    <h1 className="text-3xl font-bold text-[#485550]">Result Approvals</h1>
                    <p className="text-[#485550]/70 mt-1">
                        Review and approve departmental results before Senate submission
                    </p>
                </div>
                <div className="flex gap-2">
                    <Link href="/dean/results/broadsheet">
                        <Button variant="outline" className="border-[#485550]/20 text-[#485550]">
                            <FileSpreadsheet className="mr-2 h-4 w-4" /> View Master Broadsheet
                        </Button>
                    </Link>
                </div>
            </div>

            {/* Filters Section */}
            <Card className="border-[#F4F6F0]">
                <CardContent className="p-4">
                    <div className="flex flex-col md:flex-row justify-between gap-4">
                        <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full md:w-auto">
                            <TabsList className="bg-[#F4F6F0]">
                                <TabsTrigger value="pending" className="data-[state=active]:bg-white data-[state=active]:text-[#485550]">Pending Review</TabsTrigger>
                                <TabsTrigger value="returned" className="data-[state=active]:bg-white data-[state=active]:text-[#485550]">Returned</TabsTrigger>
                                <TabsTrigger value="approved" className="data-[state=active]:bg-white data-[state=active]:text-[#485550]">Approved History</TabsTrigger>
                                <TabsTrigger value="all" className="data-[state=active]:bg-white data-[state=active]:text-[#485550]">All Results</TabsTrigger>
                            </TabsList>
                        </Tabs>
                        <div className="relative w-full md:w-64">
                            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-[#485550]/40" />
                            <Input
                                placeholder="Search course or dept..."
                                className="pl-9 border-[#485550]/20"
                                value={searchTerm}
                                onChange={(e) => setSearchTerm(e.target.value)}
                            />
                        </div>
                    </div>
                </CardContent>
            </Card>

            <Accordion type="multiple" className="space-y-4" defaultValue={['Computer Science', 'Mathematics', 'Physics']}>
                {Object.entries(filteredBatches.reduce((acc, batch) => {
                    if (!acc[batch.department]) acc[batch.department] = [];
                    acc[batch.department].push(batch);
                    return acc;
                }, {} as Record<string, typeof batches>)).map(([dept, deptBatches]) => (
                    <AccordionItem value={dept} key={dept} className="border border-[#F4F6F0] rounded-xl bg-white overflow-hidden">
                        <AccordionTrigger className="px-6 py-4 hover:bg-[#F4F6F0]/30 transition-all hover:no-underline">
                            <div className="flex items-center gap-3">
                                <div className="h-8 w-8 rounded-lg bg-[#C0EB6A]/20 flex items-center justify-center">
                                    <Building2 className="h-4 w-4 text-[#485550]" />
                                </div>
                                <div className="text-left">
                                    <h3 className="font-bold text-[#485550] text-lg">{dept}</h3>
                                    <p className="text-xs text-[#485550]/60 font-normal">
                                        {deptBatches.length} Course Results Submitted
                                    </p>
                                </div>
                            </div>
                        </AccordionTrigger>
                        <AccordionContent className="p-0 border-t border-[#F4F6F0]">
                            <div className="overflow-x-auto">
                                <table className="w-full text-sm text-left">
                                    <thead className="bg-[#F4F6F0]/50 text-[#485550] font-medium">
                                        <tr>
                                            <th className="px-6 py-3">Course Info</th>
                                            <th className="px-6 py-3 hidden sm:table-cell">Students</th>
                                            <th className="px-6 py-3 hidden lg:table-cell">Submitted By</th>
                                            <th className="px-6 py-3">Status</th>
                                            <th className="px-6 py-3 text-right">Actions</th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-[#F4F6F0]">
                                        {deptBatches.map((batch) => (
                                            <tr key={batch.id} className="hover:bg-[#F4F6F0]/30 transition-colors">
                                                <td className="px-6 py-4">
                                                    <div className="font-semibold text-[#485550]">{batch.courseCode}</div>
                                                    <div className="text-xs text-[#485550]/60">{batch.courseTitle}</div>
                                                    <div className="text-xs text-[#485550]/50 sm:hidden">
                                                        {batch.session} • {batch.semester}
                                                    </div>
                                                </td>
                                                <td className="px-6 py-4 hidden sm:table-cell">
                                                    <div className="flex items-center gap-2">
                                                        <Users className="w-4 h-4 text-[#485550]/40" />
                                                        <span className="text-[#485550]">{batch.studentsCount}</span>
                                                    </div>
                                                    <div className="text-xs text-[#485550]/50 mt-1">Pass Rate: <span className={parseInt(batch.passRate) > 70 ? 'text-green-600' : 'text-amber-600'}>{batch.passRate}</span></div>
                                                </td>
                                                <td className="px-6 py-4 hidden lg:table-cell">
                                                    <div className="text-[#485550]">{batch.submittedBy}</div>
                                                    <div className="text-xs text-[#485550]/50">{batch.date}</div>
                                                </td>
                                                <td className="px-6 py-4">
                                                    {getStatusBadge(batch.status)}
                                                </td>
                                                <td className="px-6 py-4 text-right">
                                                    <div className="flex justify-end gap-2">
                                                        {batch.status === 'PENDING' ? (
                                                            <>
                                                                <Button
                                                                    size="sm"
                                                                    variant="outline"
                                                                    className="border-red-200 text-red-600 hover:bg-red-50 hover:text-red-700 hover:border-red-300"
                                                                    onClick={() => openRejectDialog(batch)}
                                                                    disabled={!!processingId}
                                                                >
                                                                    Reject
                                                                </Button>
                                                                <Button
                                                                    size="sm"
                                                                    className="bg-[#485550] hover:bg-[#3a4543]"
                                                                    onClick={() => handleApprove(batch)}
                                                                    disabled={!!processingId}
                                                                >
                                                                    {processingId === batch.id ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Approve'}
                                                                </Button>
                                                            </>
                                                        ) : (
                                                            <Button size="sm" variant="outline" className="border-[#485550]/20 text-[#485550] hover:bg-[#F4F6F0]">
                                                                <Eye className="w-4 h-4 sm:mr-2" />
                                                                <span className="hidden sm:inline">Details</span>
                                                            </Button>
                                                        )}
                                                    </div>
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        </AccordionContent>
                    </AccordionItem>
                ))}
                {filteredBatches.length === 0 && (
                    <div className="text-center py-12 border border-dashed border-[#485550]/20 rounded-xl bg-[#F4F6F0]/20">
                        <FileText className="w-12 h-12 mx-auto mb-3 text-[#485550]/20" />
                        <p className="text-[#485550]/50">No results found matching your filters</p>
                    </div>
                )}
            </Accordion>

            {/* Reject Dialog */}
            <Dialog open={rejectDialogOpen} onOpenChange={setRejectDialogOpen}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle className="text-[#485550] flex items-center gap-2">
                            <AlertCircle className="h-5 w-5 text-red-500" />
                            Return Results for Correction
                        </DialogTitle>
                        <DialogDescription>
                            You are returning the results for <span className="font-semibold text-[#485550]">{selectedBatch?.courseCode}</span> to the HOD.
                        </DialogDescription>
                    </DialogHeader>
                    <div className="py-4 space-y-4">
                        <div className="space-y-2">
                            <Label htmlFor="reason">Reason for Rejection <span className="text-red-500">*</span></Label>
                            <Textarea
                                id="reason"
                                placeholder="e.g. Several students have missing CA scores, please verify."
                                value={rejectReason}
                                onChange={(e) => setRejectReason(e.target.value)}
                                className="bg-[#F4F6F0]/50 border-[#485550]/20 min-h-[100px]"
                            />
                        </div>
                    </div>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setRejectDialogOpen(false)}>Cancel</Button>
                        <Button
                            variant="destructive"
                            onClick={handleReject}
                            disabled={!rejectReason || !!processingId}
                        >
                            {processingId ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
                            Return to HOD
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}
