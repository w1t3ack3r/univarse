'use client';

import { useState, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import {
    Award,
    FileText,
    GraduationCap,
    Users,
    CheckCircle2,
    XCircle,
    Clock,
    Search,
    Check,
    X,
    Loader2,
    Download,
    Printer,
    Eye,
    Building2,
    BookOpen,
    Wallet,
    Home,
    Dumbbell,
    Shield,
    ChevronRight,
    AlertTriangle,
    Send,
} from 'lucide-react';
import { toast } from 'sonner';

// Types
interface ClearanceStage {
    name: string;
    icon: string;
    status: 'PENDING' | 'APPROVED' | 'REJECTED';
    approvedBy?: string;
    approvedDate?: string;
    comment?: string;
}

interface ClearanceRequest {
    id: string;
    studentId: string;
    matricNo: string;
    studentName: string;
    department: string;
    level: string;
    cgpa: number;
    stages: ClearanceStage[];
    status: 'PENDING' | 'IN_PROGRESS' | 'CLEARED' | 'REJECTED';
    requestDate: string;
}

interface TranscriptRequest {
    id: string;
    studentId: string;
    matricNo: string;
    studentName: string;
    department: string;
    copies: number;
    purpose: string;
    destination?: string;
    status: 'PENDING' | 'PROCESSING' | 'READY' | 'COLLECTED';
    requestDate: string;
    fee: number;
    paid: boolean;
}

interface GraduatingStudent {
    id: string;
    matricNo: string;
    name: string;
    department: string;
    programme: string;
    cgpa: number;
    classification: string;
    clearanceStatus: 'CLEARED' | 'PENDING';
    nyscEligible: boolean;
}

// Mock Data
const clearanceStages = [
    { name: 'Library', icon: 'BookOpen' },
    { name: 'Bursary', icon: 'Wallet' },
    { name: 'Department', icon: 'Building2' },
    { name: 'Hostel', icon: 'Home' },
    { name: 'Sports', icon: 'Dumbbell' },
    { name: 'Student Affairs', icon: 'Shield' },
];

const mockClearanceRequests: ClearanceRequest[] = [
    {
        id: 'clr1',
        studentId: 's1',
        matricNo: 'CSC/2020/001',
        studentName: 'Adeyemi Johnson',
        department: 'Computer Science',
        level: '400',
        cgpa: 4.52,
        stages: [
            { name: 'Library', icon: 'BookOpen', status: 'APPROVED', approvedBy: 'Mr. Okafor', approvedDate: '2025-01-10' },
            { name: 'Bursary', icon: 'Wallet', status: 'APPROVED', approvedBy: 'Mrs. Bello', approvedDate: '2025-01-11' },
            { name: 'Department', icon: 'Building2', status: 'PENDING' },
            { name: 'Hostel', icon: 'Home', status: 'PENDING' },
            { name: 'Sports', icon: 'Dumbbell', status: 'PENDING' },
            { name: 'Student Affairs', icon: 'Shield', status: 'PENDING' },
        ],
        status: 'IN_PROGRESS',
        requestDate: '2025-01-08',
    },
    {
        id: 'clr2',
        studentId: 's2',
        matricNo: 'CSC/2020/002',
        studentName: 'Bello Fatima',
        department: 'Computer Science',
        level: '400',
        cgpa: 3.85,
        stages: [
            { name: 'Library', icon: 'BookOpen', status: 'APPROVED', approvedBy: 'Mr. Okafor', approvedDate: '2025-01-09' },
            { name: 'Bursary', icon: 'Wallet', status: 'REJECTED', comment: 'Outstanding fee balance of ₦25,000' },
            { name: 'Department', icon: 'Building2', status: 'PENDING' },
            { name: 'Hostel', icon: 'Home', status: 'PENDING' },
            { name: 'Sports', icon: 'Dumbbell', status: 'PENDING' },
            { name: 'Student Affairs', icon: 'Shield', status: 'PENDING' },
        ],
        status: 'IN_PROGRESS',
        requestDate: '2025-01-07',
    },
    {
        id: 'clr3',
        studentId: 's3',
        matricNo: 'PHY/2020/015',
        studentName: 'Chukwu Emeka',
        department: 'Physics',
        level: '400',
        cgpa: 4.15,
        stages: clearanceStages.map(s => ({ ...s, status: 'APPROVED' as const, approvedBy: 'System', approvedDate: '2025-01-05' })),
        status: 'CLEARED',
        requestDate: '2025-01-02',
    },
];

const mockTranscriptRequests: TranscriptRequest[] = [
    { id: 'tr1', studentId: 's1', matricNo: 'CSC/2018/045', studentName: 'Ibrahim Hassan', department: 'Computer Science', copies: 2, purpose: 'Postgraduate Studies', destination: 'University of Lagos', status: 'PENDING', requestDate: '2025-01-12', fee: 10000, paid: true },
    { id: 'tr2', studentId: 's2', matricNo: 'ACC/2019/032', studentName: 'Nwosu Grace', department: 'Accounting', copies: 3, purpose: 'Employment', destination: 'KPMG Nigeria', status: 'PROCESSING', requestDate: '2025-01-10', fee: 15000, paid: true },
    { id: 'tr3', studentId: 's3', matricNo: 'ENG/2017/018', studentName: 'Okonkwo David', department: 'Engineering', copies: 1, purpose: 'Foreign Studies', destination: 'MIT USA', status: 'READY', requestDate: '2025-01-05', fee: 10000, paid: true },
    { id: 'tr4', studentId: 's4', matricNo: 'LAW/2018/022', studentName: 'Aliyu Maryam', department: 'Law', copies: 2, purpose: 'Bar Exam', status: 'PENDING', requestDate: '2025-01-14', fee: 10000, paid: false },
];

const mockGraduatingStudents: GraduatingStudent[] = [
    { id: 'g1', matricNo: 'CSC/2020/001', name: 'Adeyemi Johnson', department: 'Computer Science', programme: 'B.Sc Computer Science', cgpa: 4.52, classification: 'First Class', clearanceStatus: 'PENDING', nyscEligible: true },
    { id: 'g2', matricNo: 'CSC/2020/002', name: 'Bello Fatima', department: 'Computer Science', programme: 'B.Sc Computer Science', cgpa: 3.85, classification: 'Second Class Upper', clearanceStatus: 'PENDING', nyscEligible: true },
    { id: 'g3', matricNo: 'PHY/2020/015', name: 'Chukwu Emeka', department: 'Physics', programme: 'B.Sc Physics', cgpa: 4.15, classification: 'Second Class Upper', clearanceStatus: 'CLEARED', nyscEligible: true },
    { id: 'g4', matricNo: 'MTH/2020/008', name: 'Danjuma Amina', department: 'Mathematics', programme: 'B.Sc Mathematics', cgpa: 3.25, classification: 'Second Class Lower', clearanceStatus: 'CLEARED', nyscEligible: true },
    { id: 'g5', matricNo: 'CHM/2020/023', name: 'Eze Michael', department: 'Chemistry', programme: 'B.Sc Chemistry', cgpa: 2.85, classification: 'Second Class Lower', clearanceStatus: 'CLEARED', nyscEligible: true },
    { id: 'g6', matricNo: 'BIO/2020/011', name: 'Femi Williams', department: 'Biology', programme: 'B.Sc Biology', cgpa: 1.95, classification: 'Third Class', clearanceStatus: 'CLEARED', nyscEligible: true },
    { id: 'g7', matricNo: 'MED/2019/005', name: 'Garba Hassan', department: 'Medicine', programme: 'MBBS', cgpa: 4.78, classification: 'First Class', clearanceStatus: 'CLEARED', nyscEligible: false },
];

export default function Clearance() {
    const [isLoading, setIsLoading] = useState(true);
    const [activeTab, setActiveTab] = useState('clearance');
    const [clearanceRequests, setClearanceRequests] = useState<ClearanceRequest[]>([]);
    const [transcriptRequests, setTranscriptRequests] = useState<TranscriptRequest[]>([]);
    const [graduatingStudents] = useState<GraduatingStudent[]>(mockGraduatingStudents);

    // Filters
    const [searchTerm, setSearchTerm] = useState('');
    const [departmentFilter, setDepartmentFilter] = useState('all');
    const [classificationFilter, setClassificationFilter] = useState('all');

    // Dialog State
    const [stageDialogOpen, setStageDialogOpen] = useState(false);
    const [selectedRequest, setSelectedRequest] = useState<ClearanceRequest | null>(null);
    const [selectedStage, setSelectedStage] = useState<ClearanceStage | null>(null);
    const [stageComment, setStageComment] = useState('');
    const [transcriptDialogOpen, setTranscriptDialogOpen] = useState(false);
    const [selectedTranscript, setSelectedTranscript] = useState<TranscriptRequest | null>(null);
    const [submitting, setSubmitting] = useState(false);

    useEffect(() => {
        setTimeout(() => {
            setClearanceRequests(mockClearanceRequests);
            setTranscriptRequests(mockTranscriptRequests);
            setIsLoading(false);
        }, 500);
    }, []);

    // Stats
    const stats = {
        pendingClearance: clearanceRequests.filter(r => r.status === 'PENDING' || r.status === 'IN_PROGRESS').length,
        clearedStudents: clearanceRequests.filter(r => r.status === 'CLEARED').length,
        pendingTranscripts: transcriptRequests.filter(t => t.status === 'PENDING' || t.status === 'PROCESSING').length,
        graduatingStudents: graduatingStudents.length,
    };

    const departments = [...new Set(graduatingStudents.map(s => s.department))];

    // Handle clearance stage action
    const handleStageAction = (request: ClearanceRequest, stage: ClearanceStage) => {
        setSelectedRequest(request);
        setSelectedStage(stage);
        setStageComment('');
        setStageDialogOpen(true);
    };

    const handleApproveStage = async (action: 'approve' | 'reject') => {
        if (!selectedRequest || !selectedStage) return;
        setSubmitting(true);
        await new Promise(r => setTimeout(r, 500));

        const updatedRequests = clearanceRequests.map(req => {
            if (req.id === selectedRequest.id) {
                const updatedStages = req.stages.map(s =>
                    s.name === selectedStage.name
                        ? { ...s, status: action === 'approve' ? 'APPROVED' as const : 'REJECTED' as const, approvedBy: 'IT Admin', approvedDate: new Date().toISOString().split('T')[0], comment: stageComment || undefined }
                        : s
                );
                const allApproved = updatedStages.every(s => s.status === 'APPROVED');
                const hasRejected = updatedStages.some(s => s.status === 'REJECTED');
                return {
                    ...req,
                    stages: updatedStages,
                    status: allApproved ? 'CLEARED' as const : hasRejected ? 'REJECTED' as const : 'IN_PROGRESS' as const
                };
            }
            return req;
        });

        setClearanceRequests(updatedRequests);
        toast.success(`Stage ${action === 'approve' ? 'approved' : 'rejected'}!`);
        setStageDialogOpen(false);
        setSubmitting(false);
    };

    // Handle transcript action
    const handleTranscriptAction = (transcript: TranscriptRequest) => {
        setSelectedTranscript(transcript);
        setTranscriptDialogOpen(true);
    };

    const handleUpdateTranscriptStatus = async (newStatus: 'PROCESSING' | 'READY' | 'COLLECTED') => {
        if (!selectedTranscript) return;
        setSubmitting(true);
        await new Promise(r => setTimeout(r, 500));

        setTranscriptRequests(transcriptRequests.map(t =>
            t.id === selectedTranscript.id ? { ...t, status: newStatus } : t
        ));

        toast.success(`Transcript status updated to ${newStatus}!`);
        setTranscriptDialogOpen(false);
        setSubmitting(false);
    };

    // Get stage icon component
    const getStageIcon = (iconName: string) => {
        const icons: Record<string, React.ReactNode> = {
            BookOpen: <BookOpen className="w-4 h-4" />,
            Wallet: <Wallet className="w-4 h-4" />,
            Building2: <Building2 className="w-4 h-4" />,
            Home: <Home className="w-4 h-4" />,
            Dumbbell: <Dumbbell className="w-4 h-4" />,
            Shield: <Shield className="w-4 h-4" />,
        };
        return icons[iconName] || <CheckCircle2 className="w-4 h-4" />;
    };

    // Filter graduating students
    const filteredGraduating = graduatingStudents.filter(s => {
        const matchesSearch = s.name.toLowerCase().includes(searchTerm.toLowerCase()) || s.matricNo.toLowerCase().includes(searchTerm.toLowerCase());
        const matchesDept = departmentFilter === 'all' || s.department === departmentFilter;
        const matchesClass = classificationFilter === 'all' || s.classification === classificationFilter;
        return matchesSearch && matchesDept && matchesClass;
    });

    // Filter for NYSC eligible
    const nyscEligible = graduatingStudents.filter(s => s.nyscEligible && s.clearanceStatus === 'CLEARED');

    const getStatusColor = (status: string) => {
        switch (status) {
            case 'CLEARED':
            case 'APPROVED':
            case 'COLLECTED':
                return 'bg-green-100 text-green-700';
            case 'PENDING':
                return 'bg-amber-100 text-amber-700';
            case 'IN_PROGRESS':
            case 'PROCESSING':
                return 'bg-blue-100 text-blue-700';
            case 'READY':
                return 'bg-purple-100 text-purple-700';
            case 'REJECTED':
                return 'bg-red-100 text-red-700';
            default:
                return 'bg-gray-100 text-gray-700';
        }
    };

    const getClassColor = (classification: string) => {
        switch (classification) {
            case 'First Class': return 'bg-green-500';
            case 'Second Class Upper': return 'bg-blue-500';
            case 'Second Class Lower': return 'bg-yellow-500';
            case 'Third Class': return 'bg-orange-500';
            case 'Pass': return 'bg-gray-500';
            default: return 'bg-gray-400';
        }
    };

    if (isLoading) {
        return <div className="flex items-center justify-center h-64"><Loader2 className="h-8 w-8 animate-spin text-[#485550]" /></div>;
    }

    return (
        <div className="space-y-6">
            {/* Header */}
            <div>
                <h1 className="text-3xl font-bold text-[#485550]">Clearance & Graduation</h1>
                <p className="text-[#485550]/60 mt-1">Manage student clearance, transcripts, and graduation</p>
            </div>

            {/* Stats Cards */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <Card className="border-[#F4F6F0]">
                    <CardContent className="p-4">
                        <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-lg bg-amber-100 flex items-center justify-center">
                                <Clock className="w-5 h-5 text-amber-600" />
                            </div>
                            <div>
                                <p className="text-2xl font-bold text-amber-600">{stats.pendingClearance}</p>
                                <p className="text-xs text-[#485550]/60">Pending Clearance</p>
                            </div>
                        </div>
                    </CardContent>
                </Card>
                <Card className="border-[#F4F6F0]">
                    <CardContent className="p-4">
                        <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-lg bg-green-100 flex items-center justify-center">
                                <CheckCircle2 className="w-5 h-5 text-green-600" />
                            </div>
                            <div>
                                <p className="text-2xl font-bold text-green-600">{stats.clearedStudents}</p>
                                <p className="text-xs text-[#485550]/60">Cleared</p>
                            </div>
                        </div>
                    </CardContent>
                </Card>
                <Card className="border-[#F4F6F0]">
                    <CardContent className="p-4">
                        <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-lg bg-blue-100 flex items-center justify-center">
                                <FileText className="w-5 h-5 text-blue-600" />
                            </div>
                            <div>
                                <p className="text-2xl font-bold text-blue-600">{stats.pendingTranscripts}</p>
                                <p className="text-xs text-[#485550]/60">Transcripts</p>
                            </div>
                        </div>
                    </CardContent>
                </Card>
                <Card className="border-[#F4F6F0]">
                    <CardContent className="p-4">
                        <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-lg bg-purple-100 flex items-center justify-center">
                                <GraduationCap className="w-5 h-5 text-purple-600" />
                            </div>
                            <div>
                                <p className="text-2xl font-bold text-purple-600">{stats.graduatingStudents}</p>
                                <p className="text-xs text-[#485550]/60">Graduating</p>
                            </div>
                        </div>
                    </CardContent>
                </Card>
            </div>

            {/* Tabs */}
            <Tabs value={activeTab} onValueChange={setActiveTab}>
                <TabsList className="grid w-full grid-cols-4 bg-[#485550]">
                    <TabsTrigger value="clearance" className="text-white data-[state=active]:bg-[#C0EB6A] data-[state=active]:text-[#485550]">
                        <CheckCircle2 className="w-4 h-4 mr-1" /> Clearance
                    </TabsTrigger>
                    <TabsTrigger value="transcripts" className="text-white data-[state=active]:bg-[#C0EB6A] data-[state=active]:text-[#485550]">
                        <FileText className="w-4 h-4 mr-1" /> Transcripts
                    </TabsTrigger>
                    <TabsTrigger value="graduation" className="text-white data-[state=active]:bg-[#C0EB6A] data-[state=active]:text-[#485550]">
                        <GraduationCap className="w-4 h-4 mr-1" /> Graduation
                    </TabsTrigger>
                    <TabsTrigger value="nysc" className="text-white data-[state=active]:bg-[#C0EB6A] data-[state=active]:text-[#485550]">
                        <Award className="w-4 h-4 mr-1" /> NYSC
                    </TabsTrigger>
                </TabsList>

                {/* Clearance Tab */}
                <TabsContent value="clearance" className="mt-4 space-y-4">
                    <Card className="border-[#F4F6F0]">
                        <CardHeader>
                            <CardTitle className="text-[#485550]">Student Clearance Requests</CardTitle>
                            <CardDescription>Review and approve clearance stages for graduating students</CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-4">
                            {clearanceRequests.map(request => (
                                <div key={request.id} className={`p-4 rounded-lg border ${request.status === 'CLEARED' ? 'border-green-200 bg-green-50/50' : request.status === 'REJECTED' ? 'border-red-200 bg-red-50/50' : 'border-[#F4F6F0] bg-[#F4F6F0]/30'}`}>
                                    {/* Student Info */}
                                    <div className="flex items-center justify-between mb-4">
                                        <div className="flex items-center gap-3">
                                            <div className="w-12 h-12 rounded-full bg-[#485550] flex items-center justify-center text-white font-bold">
                                                {request.studentName.split(' ').map(n => n[0]).join('')}
                                            </div>
                                            <div>
                                                <p className="font-bold text-[#485550]">{request.studentName}</p>
                                                <p className="text-sm text-[#485550]/60">{request.matricNo} • {request.department}</p>
                                            </div>
                                        </div>
                                        <div className="text-right">
                                            <Badge className={getStatusColor(request.status)}>{request.status.replace('_', ' ')}</Badge>
                                            <p className="text-xs text-[#485550]/50 mt-1">CGPA: {request.cgpa.toFixed(2)}</p>
                                        </div>
                                    </div>

                                    {/* Clearance Stages */}
                                    <div className="flex items-center gap-2 overflow-x-auto pb-2">
                                        {request.stages.map((stage, idx) => (
                                            <div key={stage.name} className="flex items-center">
                                                <button
                                                    onClick={() => stage.status === 'PENDING' && handleStageAction(request, stage)}
                                                    disabled={stage.status !== 'PENDING'}
                                                    className={`flex items-center gap-2 px-3 py-2 rounded-lg transition-all ${stage.status === 'APPROVED' ? 'bg-green-100 text-green-700' :
                                                        stage.status === 'REJECTED' ? 'bg-red-100 text-red-700' :
                                                            'bg-gray-100 text-gray-600 hover:bg-[#C0EB6A]/30 cursor-pointer'
                                                        }`}
                                                >
                                                    {stage.status === 'APPROVED' ? <Check className="w-4 h-4" /> :
                                                        stage.status === 'REJECTED' ? <X className="w-4 h-4" /> :
                                                            getStageIcon(stage.icon)}
                                                    <span className="text-xs font-medium whitespace-nowrap">{stage.name}</span>
                                                </button>
                                                {idx < request.stages.length - 1 && (
                                                    <ChevronRight className="w-4 h-4 text-[#485550]/30 mx-1" />
                                                )}
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            ))}

                            {clearanceRequests.length === 0 && (
                                <div className="text-center py-12 text-[#485550]/60">
                                    <CheckCircle2 className="w-12 h-12 mx-auto mb-2 opacity-30" />
                                    <p>No clearance requests</p>
                                </div>
                            )}
                        </CardContent>
                    </Card>
                </TabsContent>

                {/* Transcripts Tab */}
                <TabsContent value="transcripts" className="mt-4 space-y-4">
                    <Card className="border-[#F4F6F0]">
                        <CardHeader>
                            <CardTitle className="text-[#485550]">Transcript Requests</CardTitle>
                            <CardDescription>Process student transcript requests</CardDescription>
                        </CardHeader>
                        <CardContent>
                            <div className="overflow-x-auto">
                                <table className="w-full">
                                    <thead>
                                        <tr className="border-b border-[#F4F6F0]">
                                            <th className="text-left py-3 px-2 text-sm font-medium text-[#485550]/60">Student</th>
                                            <th className="text-left py-3 px-2 text-sm font-medium text-[#485550]/60">Details</th>
                                            <th className="text-center py-3 px-2 text-sm font-medium text-[#485550]/60">Copies</th>
                                            <th className="text-center py-3 px-2 text-sm font-medium text-[#485550]/60">Fee</th>
                                            <th className="text-center py-3 px-2 text-sm font-medium text-[#485550]/60">Status</th>
                                            <th className="text-center py-3 px-2 text-sm font-medium text-[#485550]/60">Actions</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {transcriptRequests.map(transcript => (
                                            <tr key={transcript.id} className="border-b border-[#F4F6F0]/50 hover:bg-[#F4F6F0]/30">
                                                <td className="py-3 px-2">
                                                    <p className="font-medium text-[#485550]">{transcript.studentName}</p>
                                                    <p className="text-xs text-[#485550]/60">{transcript.matricNo}</p>
                                                </td>
                                                <td className="py-3 px-2">
                                                    <p className="text-sm text-[#485550]">{transcript.purpose}</p>
                                                    {transcript.destination && (
                                                        <p className="text-xs text-[#485550]/60">To: {transcript.destination}</p>
                                                    )}
                                                </td>
                                                <td className="py-3 px-2 text-center text-sm text-[#485550]">{transcript.copies}</td>
                                                <td className="py-3 px-2 text-center">
                                                    <div className="flex items-center justify-center gap-1">
                                                        <span className="text-sm text-[#485550]">₦{transcript.fee.toLocaleString()}</span>
                                                        {transcript.paid ? (
                                                            <Check className="w-4 h-4 text-green-600" />
                                                        ) : (
                                                            <AlertTriangle className="w-4 h-4 text-amber-600" />
                                                        )}
                                                    </div>
                                                </td>
                                                <td className="py-3 px-2 text-center">
                                                    <Badge className={getStatusColor(transcript.status)}>{transcript.status}</Badge>
                                                </td>
                                                <td className="py-3 px-2 text-center">
                                                    <Button size="sm" variant="outline" onClick={() => handleTranscriptAction(transcript)} className="border-[#485550]/20">
                                                        <Eye className="w-4 h-4" />
                                                    </Button>
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        </CardContent>
                    </Card>
                </TabsContent>

                {/* Graduation Tab */}
                <TabsContent value="graduation" className="mt-4 space-y-4">
                    <Card className="border-[#F4F6F0]">
                        <CardHeader>
                            <div className="flex items-center justify-between">
                                <div>
                                    <CardTitle className="text-[#485550]">Senate List / Graduation</CardTitle>
                                    <CardDescription>Students eligible for graduation convocation</CardDescription>
                                </div>
                                <div className="flex gap-2">
                                    <Button variant="outline" className="border-[#485550]/20">
                                        <Download className="w-4 h-4 mr-2" /> Export Excel
                                    </Button>
                                    <Button className="bg-[#485550] hover:bg-[#6b7c6f]">
                                        <Printer className="w-4 h-4 mr-2" /> Print List
                                    </Button>
                                </div>
                            </div>
                        </CardHeader>
                        <CardContent>
                            {/* Filters */}
                            <div className="flex flex-wrap items-center gap-4 mb-4">
                                <div className="relative flex-1 min-w-[200px]">
                                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#485550]/40" />
                                    <Input
                                        placeholder="Search by name or matric..."
                                        value={searchTerm}
                                        onChange={(e) => setSearchTerm(e.target.value)}
                                        className="pl-10 border-[#485550]/20"
                                    />
                                </div>
                                <Select value={departmentFilter} onValueChange={setDepartmentFilter}>
                                    <SelectTrigger className="w-[180px] border-[#485550]/20">
                                        <SelectValue placeholder="Department" />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="all">All Departments</SelectItem>
                                        {departments.map(d => (
                                            <SelectItem key={d} value={d}>{d}</SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                                <Select value={classificationFilter} onValueChange={setClassificationFilter}>
                                    <SelectTrigger className="w-[180px] border-[#485550]/20">
                                        <SelectValue placeholder="Classification" />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="all">All Classes</SelectItem>
                                        <SelectItem value="First Class">First Class</SelectItem>
                                        <SelectItem value="Second Class Upper">Second Class Upper</SelectItem>
                                        <SelectItem value="Second Class Lower">Second Class Lower</SelectItem>
                                        <SelectItem value="Third Class">Third Class</SelectItem>
                                    </SelectContent>
                                </Select>
                            </div>

                            {/* Graduation List */}
                            <div className="overflow-x-auto">
                                <table className="w-full">
                                    <thead>
                                        <tr className="border-b-2 border-[#485550]">
                                            <th className="text-left py-3 px-2 text-sm font-bold text-[#485550]">S/N</th>
                                            <th className="text-left py-3 px-2 text-sm font-bold text-[#485550]">Matric No</th>
                                            <th className="text-left py-3 px-2 text-sm font-bold text-[#485550]">Name</th>
                                            <th className="text-left py-3 px-2 text-sm font-bold text-[#485550]">Programme</th>
                                            <th className="text-center py-3 px-2 text-sm font-bold text-[#485550]">CGPA</th>
                                            <th className="text-center py-3 px-2 text-sm font-bold text-[#485550]">Class</th>
                                            <th className="text-center py-3 px-2 text-sm font-bold text-[#485550]">Clearance</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {filteredGraduating.map((student, idx) => (
                                            <tr key={student.id} className="border-b border-[#F4F6F0]">
                                                <td className="py-3 px-2 text-sm text-[#485550]">{idx + 1}</td>
                                                <td className="py-3 px-2 text-sm font-mono text-[#485550]">{student.matricNo}</td>
                                                <td className="py-3 px-2 text-sm font-medium text-[#485550]">{student.name}</td>
                                                <td className="py-3 px-2 text-sm text-[#485550]">{student.programme}</td>
                                                <td className="py-3 px-2 text-center font-bold text-[#485550]">{student.cgpa.toFixed(2)}</td>
                                                <td className="py-3 px-2 text-center">
                                                    <Badge className={getClassColor(student.classification)}>{student.classification}</Badge>
                                                </td>
                                                <td className="py-3 px-2 text-center">
                                                    {student.clearanceStatus === 'CLEARED' ? (
                                                        <Check className="w-5 h-5 text-green-600 mx-auto" />
                                                    ) : (
                                                        <Clock className="w-5 h-5 text-amber-600 mx-auto" />
                                                    )}
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>

                            {/* Summary */}
                            <div className="mt-4 p-4 bg-[#485550] text-white rounded-lg flex items-center justify-between">
                                <div className="flex gap-8">
                                    <div>
                                        <p className="text-xs opacity-70">Total Graduating</p>
                                        <p className="text-2xl font-bold">{filteredGraduating.length}</p>
                                    </div>
                                    <div>
                                        <p className="text-xs opacity-70">First Class</p>
                                        <p className="text-xl font-bold">{filteredGraduating.filter(s => s.classification === 'First Class').length}</p>
                                    </div>
                                    <div>
                                        <p className="text-xs opacity-70">2:1</p>
                                        <p className="text-xl font-bold">{filteredGraduating.filter(s => s.classification === 'Second Class Upper').length}</p>
                                    </div>
                                    <div>
                                        <p className="text-xs opacity-70">Cleared</p>
                                        <p className="text-xl font-bold">{filteredGraduating.filter(s => s.clearanceStatus === 'CLEARED').length}</p>
                                    </div>
                                </div>
                                <Button variant="outline" className="border-white text-white hover:bg-white/10">
                                    <Send className="w-4 h-4 mr-2" /> Submit to Senate
                                </Button>
                            </div>
                        </CardContent>
                    </Card>
                </TabsContent>

                {/* NYSC Tab */}
                <TabsContent value="nysc" className="mt-4 space-y-4">
                    <Card className="border-[#F4F6F0]">
                        <CardHeader>
                            <div className="flex items-center justify-between">
                                <div>
                                    <CardTitle className="text-[#485550]">NYSC Mobilization</CardTitle>
                                    <CardDescription>Students eligible for National Youth Service Corps</CardDescription>
                                </div>
                                <Button className="bg-[#485550] hover:bg-[#6b7c6f]">
                                    <Download className="w-4 h-4 mr-2" /> Export for NYSC Portal
                                </Button>
                            </div>
                        </CardHeader>
                        <CardContent>
                            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                                {nyscEligible.map(student => (
                                    <div key={student.id} className="p-4 bg-[#F4F6F0]/50 rounded-lg border border-[#F4F6F0]">
                                        <div className="flex items-center gap-3 mb-3">
                                            <div className="w-12 h-12 rounded-full bg-green-100 flex items-center justify-center">
                                                <Award className="w-6 h-6 text-green-600" />
                                            </div>
                                            <div>
                                                <p className="font-medium text-[#485550]">{student.name}</p>
                                                <p className="text-xs text-[#485550]/60">{student.matricNo}</p>
                                            </div>
                                        </div>
                                        <div className="space-y-1 text-sm">
                                            <div className="flex justify-between">
                                                <span className="text-[#485550]/60">Programme</span>
                                                <span className="text-[#485550]">{student.programme}</span>
                                            </div>
                                            <div className="flex justify-between">
                                                <span className="text-[#485550]/60">CGPA</span>
                                                <span className="font-bold text-[#485550]">{student.cgpa.toFixed(2)}</span>
                                            </div>
                                            <div className="flex justify-between">
                                                <span className="text-[#485550]/60">Class</span>
                                                <Badge className={getClassColor(student.classification)}>{student.classification}</Badge>
                                            </div>
                                        </div>
                                        <div className="mt-3 pt-3 border-t border-[#F4F6F0] flex items-center justify-between">
                                            <Badge className="bg-green-100 text-green-700">
                                                <Check className="w-3 h-3 mr-1" /> NYSC Eligible
                                            </Badge>
                                            <Button size="sm" variant="ghost" className="text-[#485550]">
                                                <Eye className="w-4 h-4" />
                                            </Button>
                                        </div>
                                    </div>
                                ))}
                            </div>

                            {nyscEligible.length === 0 && (
                                <div className="text-center py-12 text-[#485550]/60">
                                    <Award className="w-12 h-12 mx-auto mb-2 opacity-30" />
                                    <p>No students currently eligible for NYSC</p>
                                    <p className="text-sm">Students must be cleared before NYSC mobilization</p>
                                </div>
                            )}

                            {/* NYSC Summary */}
                            {nyscEligible.length > 0 && (
                                <div className="mt-6 p-4 bg-green-50 border border-green-200 rounded-lg">
                                    <div className="flex items-center gap-4">
                                        <Award className="w-10 h-10 text-green-600" />
                                        <div>
                                            <p className="font-bold text-green-700">NYSC Mobilization Summary</p>
                                            <p className="text-sm text-green-600">{nyscEligible.length} students eligible • Under 30 years old • Cleared for graduation</p>
                                        </div>
                                    </div>
                                </div>
                            )}
                        </CardContent>
                    </Card>
                </TabsContent>
            </Tabs>

            {/* Clearance Stage Dialog */}
            <Dialog open={stageDialogOpen} onOpenChange={setStageDialogOpen}>
                <DialogContent className="max-w-md">
                    <DialogHeader>
                        <DialogTitle className="text-[#485550]">{selectedStage?.name} Clearance</DialogTitle>
                        <DialogDescription>
                            {selectedRequest?.studentName} ({selectedRequest?.matricNo})
                        </DialogDescription>
                    </DialogHeader>
                    <div className="space-y-4 py-4">
                        <div className="p-4 bg-[#F4F6F0] rounded-lg space-y-2">
                            <div className="flex justify-between text-sm">
                                <span className="text-[#485550]/60">Department</span>
                                <span className="text-[#485550]">{selectedRequest?.department}</span>
                            </div>
                            <div className="flex justify-between text-sm">
                                <span className="text-[#485550]/60">Level</span>
                                <span className="text-[#485550]">{selectedRequest?.level}</span>
                            </div>
                            <div className="flex justify-between text-sm">
                                <span className="text-[#485550]/60">CGPA</span>
                                <span className="font-bold text-[#485550]">{selectedRequest?.cgpa.toFixed(2)}</span>
                            </div>
                        </div>
                        <div className="space-y-2">
                            <Label>Comment (Required for rejection)</Label>
                            <Input
                                value={stageComment}
                                onChange={(e) => setStageComment(e.target.value)}
                                placeholder="e.g., Outstanding library books..."
                                className="border-[#485550]/20"
                            />
                        </div>
                    </div>
                    <DialogFooter className="gap-2">
                        <Button variant="outline" onClick={() => handleApproveStage('reject')} disabled={submitting} className="border-red-500 text-red-600 hover:bg-red-50">
                            <XCircle className="w-4 h-4 mr-1" /> Reject
                        </Button>
                        <Button onClick={() => handleApproveStage('approve')} disabled={submitting} className="bg-green-600 hover:bg-green-700">
                            {submitting ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : <CheckCircle2 className="w-4 h-4 mr-1" />}
                            Approve
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* Transcript Dialog */}
            <Dialog open={transcriptDialogOpen} onOpenChange={setTranscriptDialogOpen}>
                <DialogContent className="max-w-md">
                    <DialogHeader>
                        <DialogTitle className="text-[#485550]">Transcript Request</DialogTitle>
                        <DialogDescription>
                            {selectedTranscript?.studentName} ({selectedTranscript?.matricNo})
                        </DialogDescription>
                    </DialogHeader>
                    <div className="space-y-4 py-4">
                        <div className="p-4 bg-[#F4F6F0] rounded-lg space-y-2">
                            <div className="flex justify-between text-sm">
                                <span className="text-[#485550]/60">Purpose</span>
                                <span className="text-[#485550]">{selectedTranscript?.purpose}</span>
                            </div>
                            {selectedTranscript?.destination && (
                                <div className="flex justify-between text-sm">
                                    <span className="text-[#485550]/60">Destination</span>
                                    <span className="text-[#485550]">{selectedTranscript.destination}</span>
                                </div>
                            )}
                            <div className="flex justify-between text-sm">
                                <span className="text-[#485550]/60">Copies</span>
                                <span className="text-[#485550]">{selectedTranscript?.copies}</span>
                            </div>
                            <div className="flex justify-between text-sm">
                                <span className="text-[#485550]/60">Fee</span>
                                <span className="text-[#485550]">₦{selectedTranscript?.fee.toLocaleString()}</span>
                            </div>
                            <div className="flex justify-between text-sm">
                                <span className="text-[#485550]/60">Payment</span>
                                {selectedTranscript?.paid ? (
                                    <Badge className="bg-green-100 text-green-700">Paid</Badge>
                                ) : (
                                    <Badge className="bg-red-100 text-red-700">Unpaid</Badge>
                                )}
                            </div>
                            <div className="flex justify-between text-sm">
                                <span className="text-[#485550]/60">Current Status</span>
                                <Badge className={getStatusColor(selectedTranscript?.status || 'PENDING')}>{selectedTranscript?.status}</Badge>
                            </div>
                        </div>
                    </div>
                    <DialogFooter className="flex-wrap gap-2">
                        {selectedTranscript?.status === 'PENDING' && selectedTranscript?.paid && (
                            <Button onClick={() => handleUpdateTranscriptStatus('PROCESSING')} disabled={submitting} className="bg-blue-600 hover:bg-blue-700">
                                Start Processing
                            </Button>
                        )}
                        {selectedTranscript?.status === 'PROCESSING' && (
                            <Button onClick={() => handleUpdateTranscriptStatus('READY')} disabled={submitting} className="bg-purple-600 hover:bg-purple-700">
                                Mark as Ready
                            </Button>
                        )}
                        {selectedTranscript?.status === 'READY' && (
                            <Button onClick={() => handleUpdateTranscriptStatus('COLLECTED')} disabled={submitting} className="bg-green-600 hover:bg-green-700">
                                Mark as Collected
                            </Button>
                        )}
                        <Button variant="outline" onClick={() => setTranscriptDialogOpen(false)}>Close</Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}
