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
import { Textarea } from '@/components/ui/textarea';
import {
    Users,
    UserCheck,
    UserX,
    Clock,
    Search,
    Filter,
    Eye,
    CheckCircle,
    XCircle,
    Download,
    FileText,
    Loader2,
    AlertTriangle,
    GraduationCap,
    ClipboardList,
    Settings,
    RefreshCw,
    ListChecks,
    FileSpreadsheet,
    Printer,
    Edit2,
    ClipboardCheck,
    CalendarDays,
} from 'lucide-react';
import { toast } from 'sonner';

// Types
interface AdmissionApplication {
    id: string;
    sessionId: string;
    sessionName: string;
    firstName: string;
    lastName: string;
    middleName?: string;
    email: string;
    phone: string;
    dateOfBirth: string;
    gender: 'Male' | 'Female';
    stateOfOrigin: string;
    lga: string;
    jambRegNumber: string;
    jambScore: number;
    jambVerified: boolean;
    firstChoice: string;
    secondChoice?: string;
    admissionType: 'UTME' | 'DE' | 'IJMB' | 'PRE_DEGREE';
    postUtmeScore?: number;
    aggregateScore?: number;
    status: 'PENDING' | 'ADMITTED' | 'REJECTED' | 'WAITLISTED';
    admittedCourse?: string;
    rejectionReason?: string;
    acceptanceFeePaid: boolean;
    acceptanceFeeDate?: string;
    appliedAt: string;
    reviewedAt?: string;
    reviewedBy?: string;
}

interface AdmissionList {
    id: string;
    sessionId: string;
    sessionName: string;
    type: 'MERIT' | 'SUPPLEMENTARY' | 'DE';
    generatedAt: string;
    publishedAt?: string;
    count: number;
    status: 'DRAFT' | 'PUBLISHED';
}

// Mock Data
const mockApplications: AdmissionApplication[] = [
    { id: 'a1', sessionId: 's1', sessionName: '2024/2025', firstName: 'Adebayo', lastName: 'Ogundimu', email: 'adebayo@gmail.com', phone: '+2348012345678', dateOfBirth: '2002-05-15', gender: 'Male', stateOfOrigin: 'Lagos', lga: 'Ikeja', jambRegNumber: '12345678AB', jambScore: 285, jambVerified: true, firstChoice: 'Computer Science', secondChoice: 'Information Technology', admissionType: 'UTME', postUtmeScore: 72, aggregateScore: 78.5, status: 'PENDING', acceptanceFeePaid: false, appliedAt: '2024-08-20T10:30:00' },
    { id: 'a2', sessionId: 's1', sessionName: '2024/2025', firstName: 'Chidinma', lastName: 'Nwosu', email: 'chidinma@yahoo.com', phone: '+2348023456789', dateOfBirth: '2001-11-22', gender: 'Female', stateOfOrigin: 'Imo', lga: 'Owerri Municipal', jambRegNumber: '23456789CD', jambScore: 301, jambVerified: true, firstChoice: 'Medicine', secondChoice: 'Nursing', admissionType: 'UTME', postUtmeScore: 85, aggregateScore: 88.2, status: 'ADMITTED', admittedCourse: 'Medicine', acceptanceFeePaid: true, acceptanceFeeDate: '2024-09-05', appliedAt: '2024-08-18T14:20:00', reviewedAt: '2024-09-01T09:00:00', reviewedBy: 'Admin' },
    { id: 'a3', sessionId: 's1', sessionName: '2024/2025', firstName: 'Emeka', lastName: 'Chukwuma', email: 'emeka@gmail.com', phone: '+2348034567890', dateOfBirth: '2003-03-08', gender: 'Male', stateOfOrigin: 'Anambra', lga: 'Awka South', jambRegNumber: '34567890EF', jambScore: 198, jambVerified: false, firstChoice: 'Electrical Engineering', admissionType: 'UTME', status: 'PENDING', acceptanceFeePaid: false, appliedAt: '2024-08-25T08:45:00' },
    { id: 'a4', sessionId: 's1', sessionName: '2024/2025', firstName: 'Fatima', lastName: 'Ibrahim', email: 'fatima@hotmail.com', phone: '+2348045678901', dateOfBirth: '2000-07-30', gender: 'Female', stateOfOrigin: 'Kano', lga: 'Kano Municipal', jambRegNumber: '45678901GH', jambScore: 256, jambVerified: true, firstChoice: 'Accounting', secondChoice: 'Business Admin', admissionType: 'UTME', postUtmeScore: 65, aggregateScore: 70.1, status: 'WAITLISTED', acceptanceFeePaid: false, appliedAt: '2024-08-22T16:15:00', reviewedAt: '2024-09-03T11:30:00' },
    { id: 'a5', sessionId: 's1', sessionName: '2024/2025', firstName: 'Godwin', lastName: 'Eze', email: 'godwin@gmail.com', phone: '+2348056789012', dateOfBirth: '1999-12-01', gender: 'Male', stateOfOrigin: 'Enugu', lga: 'Enugu East', jambRegNumber: '56789012IJ', jambScore: 0, jambVerified: true, firstChoice: 'Law', admissionType: 'DE', aggregateScore: 4.25, status: 'ADMITTED', admittedCourse: 'Law', acceptanceFeePaid: true, acceptanceFeeDate: '2024-09-10', appliedAt: '2024-08-19T12:00:00', reviewedAt: '2024-09-02T14:00:00', reviewedBy: 'Admin' },
    { id: 'a6', sessionId: 's1', sessionName: '2024/2025', firstName: 'Halima', lastName: 'Yusuf', email: 'halima@gmail.com', phone: '+2348067890123', dateOfBirth: '2002-09-18', gender: 'Female', stateOfOrigin: 'Kaduna', lga: 'Kaduna North', jambRegNumber: '67890123KL', jambScore: 165, jambVerified: true, firstChoice: 'Mass Communication', admissionType: 'UTME', postUtmeScore: 45, aggregateScore: 52.3, status: 'REJECTED', rejectionReason: 'Below cut-off mark', acceptanceFeePaid: false, appliedAt: '2024-08-21T09:30:00', reviewedAt: '2024-09-04T10:00:00', reviewedBy: 'Admin' },
    { id: 'a7', sessionId: 's1', sessionName: '2024/2025', firstName: 'Isaac', lastName: 'Okoro', email: 'isaac@yahoo.com', phone: '+2348078901234', dateOfBirth: '2001-04-25', gender: 'Male', stateOfOrigin: 'Delta', lga: 'Warri South', jambRegNumber: '78901234MN', jambScore: 278, jambVerified: true, firstChoice: 'Petroleum Engineering', secondChoice: 'Chemical Engineering', admissionType: 'UTME', postUtmeScore: 78, aggregateScore: 82.0, status: 'PENDING', acceptanceFeePaid: false, appliedAt: '2024-08-23T11:45:00' },
    { id: 'a8', sessionId: 's1', sessionName: '2024/2025', firstName: 'Janet', lastName: 'Adeyemi', email: 'janet@gmail.com', phone: '+2348089012345', dateOfBirth: '2000-01-10', gender: 'Female', stateOfOrigin: 'Oyo', lga: 'Ibadan North', jambRegNumber: '89012345OP', jambScore: 0, jambVerified: true, firstChoice: 'Pharmacy', admissionType: 'IJMB', aggregateScore: 12.5, status: 'ADMITTED', admittedCourse: 'Pharmacy', acceptanceFeePaid: false, appliedAt: '2024-08-17T15:00:00', reviewedAt: '2024-09-01T16:00:00', reviewedBy: 'Admin' },
];

const mockAdmissionLists: AdmissionList[] = [
    { id: 'l1', sessionId: 's1', sessionName: '2024/2025', type: 'MERIT', generatedAt: '2024-09-05T10:00:00', publishedAt: '2024-09-06T08:00:00', count: 1250, status: 'PUBLISHED' },
    { id: 'l2', sessionId: 's1', sessionName: '2024/2025', type: 'SUPPLEMENTARY', generatedAt: '2024-09-15T10:00:00', count: 320, status: 'DRAFT' },
];

const nigerianStates = ['Abia', 'Adamawa', 'Akwa Ibom', 'Anambra', 'Bauchi', 'Bayelsa', 'Benue', 'Borno', 'Cross River', 'Delta', 'Ebonyi', 'Edo', 'Ekiti', 'Enugu', 'FCT', 'Gombe', 'Imo', 'Jigawa', 'Kaduna', 'Kano', 'Katsina', 'Kebbi', 'Kogi', 'Kwara', 'Lagos', 'Nasarawa', 'Niger', 'Ogun', 'Ondo', 'Osun', 'Oyo', 'Plateau', 'Rivers', 'Sokoto', 'Taraba', 'Yobe', 'Zamfara'];

export default function AdmissionManagement() {
    const [isLoading, setIsLoading] = useState(true);
    const [activeTab, setActiveTab] = useState('applications');
    const [applications, setApplications] = useState<AdmissionApplication[]>([]);
    const [admissionLists, setAdmissionLists] = useState<AdmissionList[]>([]);
    const [searchTerm, setSearchTerm] = useState('');
    const [statusFilter, setStatusFilter] = useState('all');
    const [typeFilter, setTypeFilter] = useState('all');

    // Dialog states
    const [selectedApplication, setSelectedApplication] = useState<AdmissionApplication | null>(null);
    const [detailDialogOpen, setDetailDialogOpen] = useState(false);
    const [actionDialogOpen, setActionDialogOpen] = useState(false);
    const [actionType, setActionType] = useState<'admit' | 'reject' | 'waitlist'>('admit');
    const [actionReason, setActionReason] = useState('');
    const [admittedCourse, setAdmittedCourse] = useState('');
    const [submitting, setSubmitting] = useState(false);

    // JAMB verification
    const [jambRegInput, setJambRegInput] = useState('');
    const [verificationResult, setVerificationResult] = useState<any>(null);
    const [verifying, setVerifying] = useState(false);

    // Settings
    const [cutOffMarks, setCutOffMarks] = useState({ utme: 180, postUtme: 50, aggregate: 60 });

    // Admission Letter
    const [letterDialogOpen, setLetterDialogOpen] = useState(false);
    const [letterApplication, setLetterApplication] = useState<AdmissionApplication | null>(null);

    // Post-UTME Screening
    const [screeningDialogOpen, setScreeningDialogOpen] = useState(false);
    const [screeningApp, setScreeningApp] = useState<AdmissionApplication | null>(null);
    const [screeningScore, setScreeningScore] = useState('');
    const [screeningDate, setScreeningDate] = useState('2024-09-10');
    const [screeningVenue, setScreeningVenue] = useState('Main Auditorium');

    useEffect(() => {
        // Simulate loading
        setTimeout(() => {
            setApplications(mockApplications);
            setAdmissionLists(mockAdmissionLists);
            setIsLoading(false);
        }, 500);
    }, []);

    // Filter applications
    const filteredApplications = applications.filter(app => {
        const matchesSearch =
            app.firstName.toLowerCase().includes(searchTerm.toLowerCase()) ||
            app.lastName.toLowerCase().includes(searchTerm.toLowerCase()) ||
            app.jambRegNumber.toLowerCase().includes(searchTerm.toLowerCase()) ||
            app.email.toLowerCase().includes(searchTerm.toLowerCase());
        const matchesStatus = statusFilter === 'all' || app.status === statusFilter;
        const matchesType = typeFilter === 'all' || app.admissionType === typeFilter;
        return matchesSearch && matchesStatus && matchesType;
    });

    // Stats
    const stats = {
        total: applications.length,
        admitted: applications.filter(a => a.status === 'ADMITTED').length,
        pending: applications.filter(a => a.status === 'PENDING').length,
        rejected: applications.filter(a => a.status === 'REJECTED').length,
        waitlisted: applications.filter(a => a.status === 'WAITLISTED').length,
        acceptanceFeePaid: applications.filter(a => a.acceptanceFeePaid).length,
    };

    // Handlers
    const handleViewApplication = (app: AdmissionApplication) => {
        setSelectedApplication(app);
        setDetailDialogOpen(true);
    };

    const handleOpenAction = (app: AdmissionApplication, type: 'admit' | 'reject' | 'waitlist') => {
        setSelectedApplication(app);
        setActionType(type);
        setActionReason('');
        setAdmittedCourse(app.firstChoice);
        setActionDialogOpen(true);
    };

    const handleSubmitAction = async () => {
        if (!selectedApplication) return;
        setSubmitting(true);

        // Simulate API call
        await new Promise(resolve => setTimeout(resolve, 1000));

        const newStatus = actionType === 'admit' ? 'ADMITTED' : actionType === 'reject' ? 'REJECTED' : 'WAITLISTED';
        setApplications(applications.map(app =>
            app.id === selectedApplication.id
                ? {
                    ...app,
                    status: newStatus,
                    admittedCourse: actionType === 'admit' ? admittedCourse : undefined,
                    rejectionReason: actionType === 'reject' ? actionReason : undefined,
                    reviewedAt: new Date().toISOString(),
                    reviewedBy: 'Admin'
                }
                : app
        ));

        toast.success(`Application ${actionType === 'admit' ? 'admitted' : actionType === 'reject' ? 'rejected' : 'waitlisted'} successfully!`);
        setActionDialogOpen(false);
        setSubmitting(false);
    };

    const handleVerifyJamb = async () => {
        if (!jambRegInput.trim()) {
            toast.error('Please enter a JAMB registration number');
            return;
        }
        setVerifying(true);
        setVerificationResult(null);

        // Simulate JAMB verification
        await new Promise(resolve => setTimeout(resolve, 1500));

        // Mock result
        const found = applications.find(a => a.jambRegNumber.toLowerCase() === jambRegInput.toLowerCase());
        if (found) {
            setVerificationResult({
                found: true,
                name: `${found.firstName} ${found.lastName}`,
                score: found.jambScore,
                regNumber: found.jambRegNumber,
                subjects: ['English', 'Mathematics', 'Physics', 'Chemistry'],
            });
        } else {
            // Generate random result for demo
            setVerificationResult({
                found: true,
                name: 'Demo Candidate',
                score: Math.floor(Math.random() * 150) + 150,
                regNumber: jambRegInput,
                subjects: ['English', 'Mathematics', 'Physics', 'Chemistry'],
            });
        }
        setVerifying(false);
    };

    const handleGenerateList = async (type: 'MERIT' | 'SUPPLEMENTARY' | 'DE') => {
        toast.info(`Generating ${type.toLowerCase()} list...`);
        await new Promise(resolve => setTimeout(resolve, 2000));

        const newList: AdmissionList = {
            id: `l${Date.now()}`,
            sessionId: 's1',
            sessionName: '2024/2025',
            type,
            generatedAt: new Date().toISOString(),
            count: Math.floor(Math.random() * 500) + 100,
            status: 'DRAFT'
        };
        setAdmissionLists([...admissionLists, newList]);
        toast.success(`${type} list generated with ${newList.count} candidates!`);
    };

    const handlePublishList = (listId: string) => {
        setAdmissionLists(admissionLists.map(l =>
            l.id === listId ? { ...l, status: 'PUBLISHED', publishedAt: new Date().toISOString() } : l
        ));
        toast.success('Admission list published successfully!');
    };

    const handleExportApplications = () => {
        const csvRows = ['Name,Email,JAMB Reg,JAMB Score,First Choice,Type,Status'];
        filteredApplications.forEach(a => {
            csvRows.push(`"${a.firstName} ${a.lastName}","${a.email}","${a.jambRegNumber}",${a.jambScore},"${a.firstChoice}","${a.admissionType}","${a.status}"`);
        });
        const blob = new Blob([csvRows.join('\n')], { type: 'text/csv' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = `admissions_${new Date().toISOString().split('T')[0]}.csv`;
        link.click();
        toast.success('Applications exported to CSV!');
    };

    // Admission Letter handlers
    const handleGenerateLetter = (app: AdmissionApplication) => {
        setLetterApplication(app);
        setLetterDialogOpen(true);
    };

    const handlePrintLetter = () => {
        const printContent = document.getElementById('admission-letter-content');
        if (!printContent) return;

        const printWindow = window.open('', '_blank');
        if (!printWindow) {
            toast.error('Please allow popups for printing');
            return;
        }

        printWindow.document.write(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Admission Letter - ${letterApplication?.firstName} ${letterApplication?.lastName}</title>
                <style>
                    body { font-family: 'Times New Roman', serif; max-width: 800px; margin: 40px auto; padding: 20px; }
                    .header { text-align: center; margin-bottom: 30px; }
                    .header h1 { color: #485550; margin: 0; font-size: 24px; }
                    .header h2 { color: #666; margin: 5px 0; font-size: 18px; }
                    .logo { width: 80px; margin-bottom: 10px; }
                    .ref { text-align: right; margin-bottom: 20px; }
                    .body { line-height: 1.8; text-align: justify; }
                    .highlight { background: #f0f9e0; padding: 15px; border-radius: 8px; margin: 20px 0; }
                    .footer { margin-top: 40px; }
                    .signature { margin-top: 60px; }
                    @media print { body { margin: 20px; } }
                </style>
            </head>
            <body>${printContent.innerHTML}</body>
            </html>
        `);
        printWindow.document.close();
        printWindow.print();
    };

    // Post-UTME Screening handlers
    const handleOpenScreening = (app: AdmissionApplication) => {
        setScreeningApp(app);
        setScreeningScore(app.postUtmeScore?.toString() || '');
        setScreeningDialogOpen(true);
    };

    const handleSaveScreeningScore = async () => {
        if (!screeningApp || !screeningScore) {
            toast.error('Please enter a valid score');
            return;
        }
        const score = parseInt(screeningScore);
        if (isNaN(score) || score < 0 || score > 100) {
            toast.error('Score must be between 0 and 100');
            return;
        }
        setSubmitting(true);
        await new Promise(resolve => setTimeout(resolve, 500));

        // Calculate aggregate (JAMB: 50%, Post-UTME: 50%)
        const aggregate = ((screeningApp.jambScore / 400) * 50) + (score / 2);

        setApplications(applications.map(app =>
            app.id === screeningApp.id
                ? { ...app, postUtmeScore: score, aggregateScore: parseFloat(aggregate.toFixed(1)) }
                : app
        ));

        toast.success(`Screening score saved! Aggregate: ${aggregate.toFixed(1)}%`);
        setScreeningDialogOpen(false);
        setSubmitting(false);
    };

    // Get screening stats
    const screeningStats = {
        eligible: applications.filter(a => a.admissionType === 'UTME' && a.jambScore >= cutOffMarks.utme).length,
        screened: applications.filter(a => a.admissionType === 'UTME' && a.postUtmeScore !== undefined).length,
        passed: applications.filter(a => a.admissionType === 'UTME' && (a.postUtmeScore || 0) >= cutOffMarks.postUtme).length,
        pending: applications.filter(a => a.admissionType === 'UTME' && a.jambScore >= cutOffMarks.utme && a.postUtmeScore === undefined).length,
    };

    const getStatusBadge = (status: string) => {
        switch (status) {
            case 'ADMITTED': return <Badge className="bg-[#C0EB6A]/20 text-[#485550] border-[#C0EB6A]">Admitted</Badge>;
            case 'PENDING': return <Badge className="bg-amber-50 text-amber-600 border-amber-200">Pending</Badge>;
            case 'REJECTED': return <Badge className="bg-red-50 text-red-600 border-red-200">Rejected</Badge>;
            case 'WAITLISTED': return <Badge className="bg-blue-50 text-blue-600 border-blue-200">Waitlisted</Badge>;
            default: return <Badge variant="outline">{status}</Badge>;
        }
    };

    const formatDate = (dateString: string) => {
        return new Date(dateString).toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric' });
    };

    if (isLoading) {
        return (
            <div className="flex items-center justify-center h-64">
                <Loader2 className="h-8 w-8 animate-spin text-[#485550]" />
            </div>
        );
    }

    return (
        <div className="space-y-6">
            {/* Header */}
            <div>
                <h1 className="text-3xl font-bold text-[#485550]">Admission Management</h1>
                <p className="text-[#485550]/60 mt-1">Process applications, generate admission lists, and manage student admissions</p>
            </div>

            {/* Stats Cards */}
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
                <Card className="border-[#F4F6F0]">
                    <CardContent className="p-4">
                        <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-lg bg-[#F4F6F0] flex items-center justify-center">
                                <Users className="w-5 h-5 text-[#485550]" />
                            </div>
                            <div>
                                <p className="text-2xl font-bold text-[#485550]">{stats.total}</p>
                                <p className="text-xs text-[#485550]/60">Total</p>
                            </div>
                        </div>
                    </CardContent>
                </Card>
                <Card className="border-[#F4F6F0]">
                    <CardContent className="p-4">
                        <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-lg bg-[#C0EB6A]/20 flex items-center justify-center">
                                <UserCheck className="w-5 h-5 text-green-600" />
                            </div>
                            <div>
                                <p className="text-2xl font-bold text-green-600">{stats.admitted}</p>
                                <p className="text-xs text-[#485550]/60">Admitted</p>
                            </div>
                        </div>
                    </CardContent>
                </Card>
                <Card className="border-[#F4F6F0]">
                    <CardContent className="p-4">
                        <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-lg bg-amber-50 flex items-center justify-center">
                                <Clock className="w-5 h-5 text-amber-600" />
                            </div>
                            <div>
                                <p className="text-2xl font-bold text-amber-600">{stats.pending}</p>
                                <p className="text-xs text-[#485550]/60">Pending</p>
                            </div>
                        </div>
                    </CardContent>
                </Card>
                <Card className="border-[#F4F6F0]">
                    <CardContent className="p-4">
                        <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-lg bg-red-50 flex items-center justify-center">
                                <UserX className="w-5 h-5 text-red-500" />
                            </div>
                            <div>
                                <p className="text-2xl font-bold text-red-500">{stats.rejected}</p>
                                <p className="text-xs text-[#485550]/60">Rejected</p>
                            </div>
                        </div>
                    </CardContent>
                </Card>
                <Card className="border-[#F4F6F0]">
                    <CardContent className="p-4">
                        <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-lg bg-blue-50 flex items-center justify-center">
                                <Clock className="w-5 h-5 text-blue-500" />
                            </div>
                            <div>
                                <p className="text-2xl font-bold text-blue-500">{stats.waitlisted}</p>
                                <p className="text-xs text-[#485550]/60">Waitlisted</p>
                            </div>
                        </div>
                    </CardContent>
                </Card>
                <Card className="border-[#F4F6F0]">
                    <CardContent className="p-4">
                        <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-lg bg-[#C0EB6A]/20 flex items-center justify-center">
                                <CheckCircle className="w-5 h-5 text-[#485550]" />
                            </div>
                            <div>
                                <p className="text-2xl font-bold text-[#485550]">{stats.acceptanceFeePaid}</p>
                                <p className="text-xs text-[#485550]/60">Fee Paid</p>
                            </div>
                        </div>
                    </CardContent>
                </Card>
            </div>

            {/* Tabs */}
            <Tabs value={activeTab} onValueChange={setActiveTab}>
                <TabsList className="grid w-full grid-cols-5 bg-[#485550]">
                    <TabsTrigger value="applications" className="text-white data-[state=active]:bg-[#C0EB6A] data-[state=active]:text-[#485550]">
                        <ClipboardList className="w-4 h-4 mr-1" /> Applications
                    </TabsTrigger>
                    <TabsTrigger value="screening" className="text-white data-[state=active]:bg-[#C0EB6A] data-[state=active]:text-[#485550]">
                        <ClipboardCheck className="w-4 h-4 mr-1" /> Screening
                    </TabsTrigger>
                    <TabsTrigger value="lists" className="text-white data-[state=active]:bg-[#C0EB6A] data-[state=active]:text-[#485550]">
                        <ListChecks className="w-4 h-4 mr-1" /> Lists
                    </TabsTrigger>
                    <TabsTrigger value="verification" className="text-white data-[state=active]:bg-[#C0EB6A] data-[state=active]:text-[#485550]">
                        <Search className="w-4 h-4 mr-1" /> JAMB
                    </TabsTrigger>
                    <TabsTrigger value="settings" className="text-white data-[state=active]:bg-[#C0EB6A] data-[state=active]:text-[#485550]">
                        <Settings className="w-4 h-4 mr-1" /> Settings
                    </TabsTrigger>
                </TabsList>

                {/* Applications Tab */}
                <TabsContent value="applications" className="space-y-4 mt-4">
                    {/* Filters */}
                    <Card className="border-[#F4F6F0]">
                        <CardContent className="p-4">
                            <div className="flex flex-wrap gap-4">
                                <div className="flex-1 min-w-[200px]">
                                    <div className="relative">
                                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#485550]/40" />
                                        <Input placeholder="Search by name, email, or JAMB number..." value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} className="pl-10 border-[#485550]/20" />
                                    </div>
                                </div>
                                <Select value={statusFilter} onValueChange={setStatusFilter}>
                                    <SelectTrigger className="w-[150px] border-[#485550]/20"><SelectValue placeholder="Status" /></SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="all">All Status</SelectItem>
                                        <SelectItem value="PENDING">Pending</SelectItem>
                                        <SelectItem value="ADMITTED">Admitted</SelectItem>
                                        <SelectItem value="REJECTED">Rejected</SelectItem>
                                        <SelectItem value="WAITLISTED">Waitlisted</SelectItem>
                                    </SelectContent>
                                </Select>
                                <Select value={typeFilter} onValueChange={setTypeFilter}>
                                    <SelectTrigger className="w-[150px] border-[#485550]/20"><SelectValue placeholder="Type" /></SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="all">All Types</SelectItem>
                                        <SelectItem value="UTME">UTME</SelectItem>
                                        <SelectItem value="DE">Direct Entry</SelectItem>
                                        <SelectItem value="IJMB">IJMB</SelectItem>
                                        <SelectItem value="PRE_DEGREE">Pre-Degree</SelectItem>
                                    </SelectContent>
                                </Select>
                                <Button variant="outline" onClick={handleExportApplications} className="border-[#485550] text-[#485550]">
                                    <Download className="w-4 h-4 mr-2" /> Export
                                </Button>
                            </div>
                        </CardContent>
                    </Card>

                    {/* Applications List */}
                    <Card className="border-[#F4F6F0]">
                        <CardHeader>
                            <CardTitle className="text-[#485550]">Applications ({filteredApplications.length})</CardTitle>
                            <CardDescription>Review and process admission applications</CardDescription>
                        </CardHeader>
                        <CardContent>
                            {filteredApplications.length === 0 ? (
                                <div className="p-8 text-center">
                                    <Users className="w-12 h-12 text-[#485550]/30 mx-auto mb-4" />
                                    <h3 className="text-lg font-medium text-[#485550] mb-2">No applications found</h3>
                                    <p className="text-[#485550]/60">Try adjusting your filters.</p>
                                </div>
                            ) : (
                                <div className="space-y-3">
                                    {filteredApplications.map((app) => (
                                        <div key={app.id} className="flex items-center justify-between p-4 border border-[#F4F6F0] rounded-lg hover:bg-[#F4F6F0]/50 transition-colors">
                                            <div className="flex items-center gap-4 flex-1">
                                                <div className="w-12 h-12 rounded-full bg-[#485550] flex items-center justify-center text-white font-bold">
                                                    {app.firstName[0]}{app.lastName[0]}
                                                </div>
                                                <div className="flex-1 min-w-0">
                                                    <div className="flex items-center gap-2 mb-1">
                                                        <span className="font-semibold text-[#485550]">{app.firstName} {app.lastName}</span>
                                                        <Badge variant="outline" className="text-xs">{app.admissionType}</Badge>
                                                        {app.jambVerified && <CheckCircle className="w-4 h-4 text-green-500" />}
                                                    </div>
                                                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-[#485550]/70">
                                                        <span>JAMB: {app.jambRegNumber}</span>
                                                        <span>Score: {app.jambScore || 'N/A'}</span>
                                                        <span>1st: {app.firstChoice}</span>
                                                    </div>
                                                </div>
                                            </div>
                                            <div className="flex items-center gap-3">
                                                {getStatusBadge(app.status)}
                                                <Button size="sm" variant="outline" onClick={() => handleViewApplication(app)} className="border-[#485550]/30">
                                                    <Eye className="w-4 h-4" />
                                                </Button>
                                                {app.status === 'PENDING' && (
                                                    <>
                                                        <Button size="sm" onClick={() => handleOpenAction(app, 'admit')} className="bg-green-600 hover:bg-green-700">
                                                            <UserCheck className="w-4 h-4" />
                                                        </Button>
                                                        <Button size="sm" variant="outline" onClick={() => handleOpenAction(app, 'reject')} className="border-red-300 text-red-500 hover:bg-red-50">
                                                            <UserX className="w-4 h-4" />
                                                        </Button>
                                                    </>
                                                )}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </CardContent>
                    </Card>
                </TabsContent>

                {/* Post-UTME Screening Tab */}
                <TabsContent value="screening" className="space-y-4 mt-4">
                    {/* Screening Stats */}
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                        <Card className="border-[#F4F6F0]">
                            <CardContent className="p-4">
                                <div className="flex items-center gap-3">
                                    <div className="w-10 h-10 rounded-lg bg-[#F4F6F0] flex items-center justify-center">
                                        <Users className="w-5 h-5 text-[#485550]" />
                                    </div>
                                    <div>
                                        <p className="text-2xl font-bold text-[#485550]">{screeningStats.eligible}</p>
                                        <p className="text-xs text-[#485550]/60">Eligible (≥{cutOffMarks.utme})</p>
                                    </div>
                                </div>
                            </CardContent>
                        </Card>
                        <Card className="border-[#F4F6F0]">
                            <CardContent className="p-4">
                                <div className="flex items-center gap-3">
                                    <div className="w-10 h-10 rounded-lg bg-[#C0EB6A]/20 flex items-center justify-center">
                                        <ClipboardCheck className="w-5 h-5 text-green-600" />
                                    </div>
                                    <div>
                                        <p className="text-2xl font-bold text-green-600">{screeningStats.screened}</p>
                                        <p className="text-xs text-[#485550]/60">Screened</p>
                                    </div>
                                </div>
                            </CardContent>
                        </Card>
                        <Card className="border-[#F4F6F0]">
                            <CardContent className="p-4">
                                <div className="flex items-center gap-3">
                                    <div className="w-10 h-10 rounded-lg bg-amber-50 flex items-center justify-center">
                                        <Clock className="w-5 h-5 text-amber-600" />
                                    </div>
                                    <div>
                                        <p className="text-2xl font-bold text-amber-600">{screeningStats.pending}</p>
                                        <p className="text-xs text-[#485550]/60">Pending</p>
                                    </div>
                                </div>
                            </CardContent>
                        </Card>
                        <Card className="border-[#F4F6F0]">
                            <CardContent className="p-4">
                                <div className="flex items-center gap-3">
                                    <div className="w-10 h-10 rounded-lg bg-green-50 flex items-center justify-center">
                                        <CheckCircle className="w-5 h-5 text-green-600" />
                                    </div>
                                    <div>
                                        <p className="text-2xl font-bold text-green-600">{screeningStats.passed}</p>
                                        <p className="text-xs text-[#485550]/60">Passed (≥{cutOffMarks.postUtme})</p>
                                    </div>
                                </div>
                            </CardContent>
                        </Card>
                    </div>

                    {/* Screening Schedule Info */}
                    <Card className="border-[#C0EB6A] bg-[#C0EB6A]/5">
                        <CardContent className="p-4">
                            <div className="flex flex-wrap items-center justify-between gap-4">
                                <div className="flex items-center gap-4">
                                    <div className="w-12 h-12 rounded-lg bg-[#485550] flex items-center justify-center">
                                        <CalendarDays className="w-6 h-6 text-white" />
                                    </div>
                                    <div>
                                        <h3 className="font-semibold text-[#485550]">Post-UTME Screening Schedule</h3>
                                        <p className="text-sm text-[#485550]/70">Date: <strong>{screeningDate}</strong> | Venue: <strong>{screeningVenue}</strong></p>
                                    </div>
                                </div>
                                <Badge className="bg-[#C0EB6A] text-[#485550]">Active</Badge>
                            </div>
                        </CardContent>
                    </Card>

                    {/* Candidates List */}
                    <Card className="border-[#F4F6F0]">
                        <CardHeader>
                            <CardTitle className="text-[#485550]">UTME Candidates for Screening</CardTitle>
                            <CardDescription>Enter screening scores for eligible candidates (JAMB ≥ {cutOffMarks.utme})</CardDescription>
                        </CardHeader>
                        <CardContent>
                            <div className="space-y-3">
                                {applications.filter(a => a.admissionType === 'UTME' && a.jambScore >= cutOffMarks.utme).length === 0 ? (
                                    <div className="p-8 text-center">
                                        <ClipboardCheck className="w-12 h-12 text-[#485550]/30 mx-auto mb-4" />
                                        <h3 className="text-lg font-medium text-[#485550] mb-2">No eligible candidates</h3>
                                        <p className="text-[#485550]/60">No UTME candidates have met the minimum JAMB score.</p>
                                    </div>
                                ) : (
                                    applications.filter(a => a.admissionType === 'UTME' && a.jambScore >= cutOffMarks.utme).map((app) => (
                                        <div key={app.id} className="flex items-center justify-between p-4 border border-[#F4F6F0] rounded-lg hover:bg-[#F4F6F0]/50 transition-colors">
                                            <div className="flex items-center gap-4">
                                                <div className="w-10 h-10 rounded-full bg-[#485550] flex items-center justify-center text-white font-bold">
                                                    {app.firstName[0]}{app.lastName[0]}
                                                </div>
                                                <div>
                                                    <p className="font-semibold text-[#485550]">{app.firstName} {app.lastName}</p>
                                                    <div className="flex gap-3 text-sm text-[#485550]/70">
                                                        <span>JAMB: {app.jambRegNumber}</span>
                                                        <span>Score: <strong>{app.jambScore}</strong></span>
                                                    </div>
                                                </div>
                                            </div>
                                            <div className="flex items-center gap-3">
                                                {app.postUtmeScore !== undefined ? (
                                                    <>
                                                        <div className="text-right">
                                                            <p className="text-sm text-[#485550]/60">Post-UTME</p>
                                                            <p className={`text-xl font-bold ${app.postUtmeScore >= cutOffMarks.postUtme ? 'text-green-600' : 'text-red-500'}`}>
                                                                {app.postUtmeScore}%
                                                            </p>
                                                        </div>
                                                        <div className="text-right">
                                                            <p className="text-sm text-[#485550]/60">Aggregate</p>
                                                            <p className="text-xl font-bold text-[#485550]">{app.aggregateScore}%</p>
                                                        </div>
                                                        <Badge className={app.postUtmeScore >= cutOffMarks.postUtme ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}>
                                                            {app.postUtmeScore >= cutOffMarks.postUtme ? 'Passed' : 'Failed'}
                                                        </Badge>
                                                    </>
                                                ) : (
                                                    <Badge className="bg-amber-100 text-amber-700">Not Screened</Badge>
                                                )}
                                                <Button size="sm" onClick={() => handleOpenScreening(app)} className="bg-[#485550] hover:bg-[#6b7c6f]">
                                                    <Edit2 className="w-4 h-4 mr-1" /> {app.postUtmeScore !== undefined ? 'Edit' : 'Enter'} Score
                                                </Button>
                                            </div>
                                        </div>
                                    ))
                                )}
                            </div>
                        </CardContent>
                    </Card>
                </TabsContent>

                {/* Admission Lists Tab */}
                <TabsContent value="lists" className="space-y-4 mt-4">
                    <div className="flex flex-wrap gap-3">
                        <Button onClick={() => handleGenerateList('MERIT')} className="bg-[#485550] hover:bg-[#6b7c6f]">
                            <FileText className="w-4 h-4 mr-2" /> Generate Merit List
                        </Button>
                        <Button variant="outline" onClick={() => handleGenerateList('SUPPLEMENTARY')} className="border-[#485550] text-[#485550]">
                            <FileText className="w-4 h-4 mr-2" /> Generate Supplementary
                        </Button>
                        <Button variant="outline" onClick={() => handleGenerateList('DE')} className="border-[#485550] text-[#485550]">
                            <GraduationCap className="w-4 h-4 mr-2" /> Generate DE List
                        </Button>
                    </div>

                    <Card className="border-[#F4F6F0]">
                        <CardHeader>
                            <CardTitle className="text-[#485550]">Generated Lists</CardTitle>
                            <CardDescription>Manage admission lists and publications</CardDescription>
                        </CardHeader>
                        <CardContent>
                            {admissionLists.length === 0 ? (
                                <div className="p-8 text-center">
                                    <FileSpreadsheet className="w-12 h-12 text-[#485550]/30 mx-auto mb-4" />
                                    <h3 className="text-lg font-medium text-[#485550] mb-2">No lists generated</h3>
                                    <p className="text-[#485550]/60">Generate a merit or supplementary list to get started.</p>
                                </div>
                            ) : (
                                <div className="space-y-3">
                                    {admissionLists.map((list) => (
                                        <div key={list.id} className="flex items-center justify-between p-4 border border-[#F4F6F0] rounded-lg">
                                            <div className="flex items-center gap-4">
                                                <div className="w-12 h-12 rounded-lg bg-[#C0EB6A]/20 flex items-center justify-center">
                                                    <ListChecks className="w-6 h-6 text-[#485550]" />
                                                </div>
                                                <div>
                                                    <h3 className="font-semibold text-[#485550]">{list.type} List - {list.sessionName}</h3>
                                                    <p className="text-sm text-[#485550]/70">{list.count} candidates • Generated {formatDate(list.generatedAt)}</p>
                                                </div>
                                            </div>
                                            <div className="flex items-center gap-3">
                                                <Badge className={list.status === 'PUBLISHED' ? 'bg-[#C0EB6A]/20 text-[#485550] border-[#C0EB6A]' : 'bg-gray-100 text-gray-600'}>
                                                    {list.status}
                                                </Badge>
                                                {list.status === 'DRAFT' && (
                                                    <Button size="sm" onClick={() => handlePublishList(list.id)} className="bg-[#485550] hover:bg-[#6b7c6f]">
                                                        Publish
                                                    </Button>
                                                )}
                                                <Button size="sm" variant="outline" className="border-[#485550]/30">
                                                    <Download className="w-4 h-4" />
                                                </Button>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </CardContent>
                    </Card>
                </TabsContent>

                {/* JAMB Verification Tab */}
                <TabsContent value="verification" className="space-y-4 mt-4">
                    <Card className="border-[#F4F6F0]">
                        <CardHeader>
                            <CardTitle className="text-[#485550]">JAMB/UTME Verification</CardTitle>
                            <CardDescription>Verify candidate JAMB registration numbers and scores</CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-6">
                            <div className="flex gap-4 max-w-md">
                                <div className="flex-1">
                                    <Input placeholder="Enter JAMB Registration Number" value={jambRegInput} onChange={(e) => setJambRegInput(e.target.value.toUpperCase())} className="border-[#485550]/20" />
                                </div>
                                <Button onClick={handleVerifyJamb} disabled={verifying} className="bg-[#485550] hover:bg-[#6b7c6f]">
                                    {verifying ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Search className="w-4 h-4 mr-2" />}
                                    Verify
                                </Button>
                            </div>

                            {verificationResult && (
                                <div className={`p-6 rounded-lg ${verificationResult.found ? 'bg-[#C0EB6A]/10 border border-[#C0EB6A]' : 'bg-red-50 border border-red-200'}`}>
                                    {verificationResult.found ? (
                                        <div className="space-y-4">
                                            <div className="flex items-center gap-3">
                                                <CheckCircle className="w-8 h-8 text-green-500" />
                                                <div>
                                                    <h3 className="font-bold text-[#485550] text-lg">Verification Successful</h3>
                                                    <p className="text-[#485550]/70">JAMB record found</p>
                                                </div>
                                            </div>
                                            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 pt-4 border-t border-[#C0EB6A]/30">
                                                <div>
                                                    <p className="text-sm text-[#485550]/60">Name</p>
                                                    <p className="font-semibold text-[#485550]">{verificationResult.name}</p>
                                                </div>
                                                <div>
                                                    <p className="text-sm text-[#485550]/60">Reg Number</p>
                                                    <p className="font-semibold text-[#485550]">{verificationResult.regNumber}</p>
                                                </div>
                                                <div>
                                                    <p className="text-sm text-[#485550]/60">UTME Score</p>
                                                    <p className="font-semibold text-[#485550] text-xl">{verificationResult.score}</p>
                                                </div>
                                                <div>
                                                    <p className="text-sm text-[#485550]/60">Subjects</p>
                                                    <p className="font-semibold text-[#485550]">{verificationResult.subjects?.length || 4}</p>
                                                </div>
                                            </div>
                                        </div>
                                    ) : (
                                        <div className="flex items-center gap-3">
                                            <XCircle className="w-8 h-8 text-red-500" />
                                            <div>
                                                <h3 className="font-bold text-red-700">Not Found</h3>
                                                <p className="text-red-600">No JAMB record matches this registration number</p>
                                            </div>
                                        </div>
                                    )}
                                </div>
                            )}
                        </CardContent>
                    </Card>
                </TabsContent>

                {/* Settings Tab */}
                <TabsContent value="settings" className="space-y-4 mt-4">
                    <Card className="border-[#F4F6F0]">
                        <CardHeader>
                            <CardTitle className="text-[#485550]">Admission Settings</CardTitle>
                            <CardDescription>Configure cut-off marks and admission criteria</CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-6">
                            <div>
                                <h3 className="text-sm font-semibold text-[#485550] mb-4">Cut-Off Marks</h3>
                                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                                    <div className="space-y-2">
                                        <Label>JAMB/UTME Cut-Off</Label>
                                        <Input type="number" value={cutOffMarks.utme} onChange={(e) => setCutOffMarks({ ...cutOffMarks, utme: parseInt(e.target.value) })} className="border-[#485550]/20" />
                                        <p className="text-xs text-[#485550]/60">Minimum JAMB score required</p>
                                    </div>
                                    <div className="space-y-2">
                                        <Label>Post-UTME Cut-Off</Label>
                                        <Input type="number" value={cutOffMarks.postUtme} onChange={(e) => setCutOffMarks({ ...cutOffMarks, postUtme: parseInt(e.target.value) })} className="border-[#485550]/20" />
                                        <p className="text-xs text-[#485550]/60">Minimum screening score</p>
                                    </div>
                                    <div className="space-y-2">
                                        <Label>Aggregate Cut-Off</Label>
                                        <Input type="number" value={cutOffMarks.aggregate} onChange={(e) => setCutOffMarks({ ...cutOffMarks, aggregate: parseInt(e.target.value) })} className="border-[#485550]/20" />
                                        <p className="text-xs text-[#485550]/60">Minimum aggregate score</p>
                                    </div>
                                </div>
                            </div>
                            <div className="pt-4 border-t">
                                <Button className="bg-[#485550] hover:bg-[#6b7c6f]">
                                    <Settings className="w-4 h-4 mr-2" /> Save Settings
                                </Button>
                            </div>
                        </CardContent>
                    </Card>
                </TabsContent>
            </Tabs>

            {/* Application Detail Dialog */}
            <Dialog open={detailDialogOpen} onOpenChange={setDetailDialogOpen}>
                <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
                    <DialogHeader>
                        <DialogTitle className="text-[#485550]">Application Details</DialogTitle>
                        <DialogDescription>View complete application information</DialogDescription>
                    </DialogHeader>
                    {selectedApplication && (
                        <div className="space-y-6 py-4">
                            <div className="flex items-center gap-4">
                                <div className="w-16 h-16 rounded-full bg-[#485550] flex items-center justify-center text-white text-xl font-bold">
                                    {selectedApplication.firstName[0]}{selectedApplication.lastName[0]}
                                </div>
                                <div>
                                    <h2 className="text-xl font-bold text-[#485550]">{selectedApplication.firstName} {selectedApplication.middleName || ''} {selectedApplication.lastName}</h2>
                                    <p className="text-[#485550]/70">{selectedApplication.email}</p>
                                    <div className="flex gap-2 mt-1">
                                        {getStatusBadge(selectedApplication.status)}
                                        <Badge variant="outline">{selectedApplication.admissionType}</Badge>
                                    </div>
                                </div>
                            </div>

                            <div className="grid grid-cols-2 gap-4 text-sm">
                                <div className="space-y-3">
                                    <h3 className="font-semibold text-[#485550]">Personal Information</h3>
                                    <div><span className="text-[#485550]/60">Phone:</span> {selectedApplication.phone}</div>
                                    <div><span className="text-[#485550]/60">DOB:</span> {formatDate(selectedApplication.dateOfBirth)}</div>
                                    <div><span className="text-[#485550]/60">Gender:</span> {selectedApplication.gender}</div>
                                    <div><span className="text-[#485550]/60">State:</span> {selectedApplication.stateOfOrigin}</div>
                                    <div><span className="text-[#485550]/60">LGA:</span> {selectedApplication.lga}</div>
                                </div>
                                <div className="space-y-3">
                                    <h3 className="font-semibold text-[#485550]">Academic Information</h3>
                                    <div><span className="text-[#485550]/60">JAMB Reg:</span> {selectedApplication.jambRegNumber}</div>
                                    <div><span className="text-[#485550]/60">JAMB Score:</span> {selectedApplication.jambScore || 'N/A'}</div>
                                    <div><span className="text-[#485550]/60">Post-UTME:</span> {selectedApplication.postUtmeScore || 'N/A'}</div>
                                    <div><span className="text-[#485550]/60">Aggregate:</span> {selectedApplication.aggregateScore || 'N/A'}</div>
                                    <div><span className="text-[#485550]/60">1st Choice:</span> {selectedApplication.firstChoice}</div>
                                    {selectedApplication.secondChoice && <div><span className="text-[#485550]/60">2nd Choice:</span> {selectedApplication.secondChoice}</div>}
                                </div>
                            </div>

                            {selectedApplication.status === 'ADMITTED' && selectedApplication.admittedCourse && (
                                <div className="p-4 bg-[#C0EB6A]/10 rounded-lg border border-[#C0EB6A]">
                                    <div className="flex justify-between items-start">
                                        <div>
                                            <p className="font-semibold text-[#485550]">Admitted to: {selectedApplication.admittedCourse}</p>
                                            <p className="text-sm text-[#485550]/70">Acceptance Fee: {selectedApplication.acceptanceFeePaid ? `Paid on ${formatDate(selectedApplication.acceptanceFeeDate!)}` : 'Not Paid'}</p>
                                        </div>
                                        <Button size="sm" onClick={() => { setDetailDialogOpen(false); handleGenerateLetter(selectedApplication); }} className="bg-[#485550] hover:bg-[#6b7c6f]">
                                            <FileText className="w-4 h-4 mr-2" /> Generate Letter
                                        </Button>
                                    </div>
                                </div>
                            )}

                            {selectedApplication.status === 'REJECTED' && selectedApplication.rejectionReason && (
                                <div className="p-4 bg-red-50 rounded-lg border border-red-200">
                                    <p className="font-semibold text-red-700">Rejection Reason</p>
                                    <p className="text-sm text-red-600">{selectedApplication.rejectionReason}</p>
                                </div>
                            )}
                        </div>
                    )}
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setDetailDialogOpen(false)}>Close</Button>
                        {selectedApplication?.status === 'PENDING' && (
                            <>
                                <Button onClick={() => { setDetailDialogOpen(false); handleOpenAction(selectedApplication, 'admit'); }} className="bg-green-600 hover:bg-green-700">
                                    <UserCheck className="w-4 h-4 mr-2" /> Admit
                                </Button>
                                <Button variant="outline" onClick={() => { setDetailDialogOpen(false); handleOpenAction(selectedApplication, 'reject'); }} className="border-red-300 text-red-500">
                                    <UserX className="w-4 h-4 mr-2" /> Reject
                                </Button>
                            </>
                        )}
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* Admit/Reject Action Dialog */}
            <Dialog open={actionDialogOpen} onOpenChange={setActionDialogOpen}>
                <DialogContent className="max-w-md">
                    <DialogHeader>
                        <DialogTitle className="text-[#485550] flex items-center gap-2">
                            {actionType === 'admit' && <><UserCheck className="w-5 h-5 text-green-600" /> Admit Applicant</>}
                            {actionType === 'reject' && <><UserX className="w-5 h-5 text-red-500" /> Reject Application</>}
                            {actionType === 'waitlist' && <><Clock className="w-5 h-5 text-blue-500" /> Add to Waitlist</>}
                        </DialogTitle>
                        <DialogDescription>
                            {selectedApplication?.firstName} {selectedApplication?.lastName} - {selectedApplication?.jambRegNumber}
                        </DialogDescription>
                    </DialogHeader>
                    <div className="space-y-4 py-4">
                        {actionType === 'admit' && (
                            <div className="space-y-2">
                                <Label>Admitted Course <span className="text-red-500">*</span></Label>
                                <Select value={admittedCourse} onValueChange={setAdmittedCourse}>
                                    <SelectTrigger className="border-[#485550]/20"><SelectValue /></SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value={selectedApplication?.firstChoice || ''}>{selectedApplication?.firstChoice} (1st Choice)</SelectItem>
                                        {selectedApplication?.secondChoice && <SelectItem value={selectedApplication.secondChoice}>{selectedApplication.secondChoice} (2nd Choice)</SelectItem>}
                                    </SelectContent>
                                </Select>
                            </div>
                        )}
                        {actionType === 'reject' && (
                            <div className="space-y-2">
                                <Label>Rejection Reason <span className="text-red-500">*</span></Label>
                                <Textarea placeholder="Enter reason for rejection..." value={actionReason} onChange={(e) => setActionReason(e.target.value)} className="border-[#485550]/20" rows={3} />
                            </div>
                        )}
                        <div className={`p-4 rounded-lg ${actionType === 'admit' ? 'bg-green-50' : actionType === 'reject' ? 'bg-red-50' : 'bg-blue-50'}`}>
                            <p className="text-sm">
                                {actionType === 'admit' && 'This will mark the application as ADMITTED and the course will be assigned to the student.'}
                                {actionType === 'reject' && 'This will mark the application as REJECTED. The applicant will be notified with the reason.'}
                                {actionType === 'waitlist' && 'This will add the applicant to the waitlist for future consideration.'}
                            </p>
                        </div>
                    </div>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setActionDialogOpen(false)}>Cancel</Button>
                        <Button onClick={handleSubmitAction} disabled={submitting || (actionType === 'reject' && !actionReason)}
                            className={actionType === 'admit' ? 'bg-green-600 hover:bg-green-700' : actionType === 'reject' ? 'bg-red-500 hover:bg-red-600' : 'bg-blue-500 hover:bg-blue-600'}>
                            {submitting && <Loader2 className="w-4 h-4 animate-spin mr-2" />}
                            Confirm
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* Admission Letter Dialog */}
            <Dialog open={letterDialogOpen} onOpenChange={setLetterDialogOpen}>
                <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
                    <DialogHeader>
                        <DialogTitle className="text-[#485550] flex items-center gap-2">
                            <FileText className="w-5 h-5" /> Admission Letter
                        </DialogTitle>
                        <DialogDescription>
                            Preview and print admission letter for {letterApplication?.firstName} {letterApplication?.lastName}
                        </DialogDescription>
                    </DialogHeader>

                    {letterApplication && (
                        <div id="admission-letter-content" className="bg-white p-8 border rounded-lg">
                            {/* Letter Header */}
                            <div className="text-center mb-8 border-b-2 border-[#485550] pb-6">
                                <div className="w-20 h-20 bg-[#485550] rounded-full mx-auto mb-3 flex items-center justify-center">
                                    <GraduationCap className="w-10 h-10 text-white" />
                                </div>
                                <h1 className="text-2xl font-bold text-[#485550] uppercase tracking-wide">UniVarse University</h1>
                                <p className="text-[#485550]/70">Established 2024 | Excellence in Education</p>
                                <p className="text-sm text-[#485550]/60">PMB 001, University Road, Lagos, Nigeria</p>
                            </div>

                            {/* Reference */}
                            <div className="text-right mb-6 text-sm">
                                <p><strong>Ref:</strong> UV/ADM/{letterApplication.sessionName.replace('/', '')}/{letterApplication.id.toUpperCase()}</p>
                                <p><strong>Date:</strong> {new Date().toLocaleDateString('en-NG', { day: 'numeric', month: 'long', year: 'numeric' })}</p>
                            </div>

                            {/* Recipient */}
                            <div className="mb-6">
                                <p className="font-semibold">{letterApplication.firstName} {letterApplication.middleName || ''} {letterApplication.lastName}</p>
                                <p className="text-[#485550]/70">{letterApplication.email}</p>
                                <p className="text-[#485550]/70">{letterApplication.stateOfOrigin} State, Nigeria</p>
                            </div>

                            {/* Salutation */}
                            <p className="mb-4">Dear <strong>{letterApplication.firstName}</strong>,</p>

                            {/* Body */}
                            <div className="space-y-4 text-justify leading-relaxed">
                                <p className="font-bold text-lg text-[#485550] text-center uppercase underline mb-6">
                                    OFFER OF PROVISIONAL ADMISSION - {letterApplication.sessionName} ACADEMIC SESSION
                                </p>

                                <p>
                                    I am pleased to inform you that, following the review of your application and credentials
                                    for admission into the UniVarse University for the <strong>{letterApplication.sessionName}</strong> academic session,
                                    you have been offered <strong>Provisional Admission</strong> into the University.
                                </p>

                                <div className="bg-[#F4F6F0] p-4 rounded-lg my-4">
                                    <p className="font-semibold text-[#485550] mb-2">Admission Details:</p>
                                    <table className="w-full text-sm">
                                        <tbody>
                                            <tr><td className="py-1 text-[#485550]/70 w-40">JAMB Reg. Number:</td><td className="font-medium">{letterApplication.jambRegNumber}</td></tr>
                                            <tr><td className="py-1 text-[#485550]/70">Admission Mode:</td><td className="font-medium">{letterApplication.admissionType}</td></tr>
                                            <tr><td className="py-1 text-[#485550]/70">Programme:</td><td className="font-medium">{letterApplication.admittedCourse}</td></tr>
                                            <tr><td className="py-1 text-[#485550]/70">Entry Level:</td><td className="font-medium">{letterApplication.admissionType === 'DE' || letterApplication.admissionType === 'IJMB' ? '200 Level' : '100 Level'}</td></tr>
                                        </tbody>
                                    </table>
                                </div>

                                <p>
                                    This offer is subject to the following conditions:
                                </p>

                                <ol className="list-decimal list-inside space-y-2 ml-4">
                                    <li>Payment of the Acceptance Fee within two (2) weeks of the date of this letter.</li>
                                    <li>Verification of your O&apos;Level results and JAMB admission status.</li>
                                    <li>Submission of all original credentials for verification during registration.</li>
                                    <li>Successful completion of the medical examination.</li>
                                    <li>Good conduct and adherence to University regulations.</li>
                                </ol>

                                <p className="mt-4">
                                    Please note that this admission offer will be withdrawn if any of the documents submitted are found to be falsified
                                    or if you fail to meet any of the conditions stated above.
                                </p>

                                <p>
                                    Congratulations on your admission, and we look forward to welcoming you to UniVarse University.
                                </p>
                            </div>

                            {/* Signature */}
                            <div className="mt-12">
                                <p>Yours faithfully,</p>
                                <div className="mt-8 mb-2 w-40 border-b border-[#485550]"></div>
                                <p className="font-semibold">Dr. Adewale Johnson</p>
                                <p className="text-sm text-[#485550]/70">Registrar</p>
                                <p className="text-sm text-[#485550]/70">UniVarse University</p>
                            </div>

                            {/* Footer */}
                            <div className="mt-8 pt-4 border-t text-center text-xs text-[#485550]/60">
                                <p>This is a computer-generated document. For verification, please contact the Admissions Office.</p>
                                <p>Email: admissions@univarse.edu.ng | Phone: +234 801 234 5678</p>
                            </div>
                        </div>
                    )}

                    <DialogFooter className="flex gap-2">
                        <Button variant="outline" onClick={() => setLetterDialogOpen(false)}>Close</Button>
                        <Button onClick={handlePrintLetter} className="bg-[#485550] hover:bg-[#6b7c6f]">
                            <Printer className="w-4 h-4 mr-2" /> Print / Download PDF
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* Post-UTME Screening Score Entry Dialog */}
            <Dialog open={screeningDialogOpen} onOpenChange={setScreeningDialogOpen}>
                <DialogContent className="max-w-md">
                    <DialogHeader>
                        <DialogTitle className="text-[#485550] flex items-center gap-2">
                            <ClipboardCheck className="w-5 h-5" /> Enter Screening Score
                        </DialogTitle>
                        <DialogDescription>
                            Post-UTME screening score for {screeningApp?.firstName} {screeningApp?.lastName}
                        </DialogDescription>
                    </DialogHeader>

                    {screeningApp && (
                        <div className="space-y-4 py-4">
                            {/* Candidate Info */}
                            <div className="p-4 bg-[#F4F6F0] rounded-lg">
                                <div className="flex items-center gap-3 mb-3">
                                    <div className="w-12 h-12 rounded-full bg-[#485550] flex items-center justify-center text-white font-bold">
                                        {screeningApp.firstName[0]}{screeningApp.lastName[0]}
                                    </div>
                                    <div>
                                        <p className="font-semibold text-[#485550]">{screeningApp.firstName} {screeningApp.lastName}</p>
                                        <p className="text-sm text-[#485550]/70">{screeningApp.jambRegNumber}</p>
                                    </div>
                                </div>
                                <div className="grid grid-cols-2 gap-2 text-sm">
                                    <div>
                                        <span className="text-[#485550]/60">JAMB Score:</span>
                                        <span className="ml-2 font-bold text-[#485550]">{screeningApp.jambScore}</span>
                                    </div>
                                    <div>
                                        <span className="text-[#485550]/60">1st Choice:</span>
                                        <span className="ml-2 font-medium text-[#485550]">{screeningApp.firstChoice}</span>
                                    </div>
                                </div>
                            </div>

                            {/* Score Input */}
                            <div className="space-y-2">
                                <Label>Screening Score (0-100) <span className="text-red-500">*</span></Label>
                                <Input
                                    type="number"
                                    min="0"
                                    max="100"
                                    placeholder="Enter score..."
                                    value={screeningScore}
                                    onChange={(e) => setScreeningScore(e.target.value)}
                                    className="border-[#485550]/20 text-lg font-bold text-center"
                                />
                                <p className="text-xs text-[#485550]/60">Minimum pass mark: {cutOffMarks.postUtme}%</p>
                            </div>

                            {/* Aggregate Preview */}
                            {screeningScore && !isNaN(parseInt(screeningScore)) && (
                                <div className={`p-4 rounded-lg ${parseInt(screeningScore) >= cutOffMarks.postUtme ? 'bg-green-50 border border-green-200' : 'bg-red-50 border border-red-200'}`}>
                                    <p className="text-sm font-semibold mb-2">Aggregate Score Preview</p>
                                    <div className="flex justify-between items-center">
                                        <div className="text-sm">
                                            <p>JAMB (50%): {((screeningApp.jambScore / 400) * 50).toFixed(1)}%</p>
                                            <p>Post-UTME (50%): {(parseInt(screeningScore) / 2).toFixed(1)}%</p>
                                        </div>
                                        <div className="text-right">
                                            <p className="text-2xl font-bold">
                                                {(((screeningApp.jambScore / 400) * 50) + (parseInt(screeningScore) / 2)).toFixed(1)}%
                                            </p>
                                            <Badge className={parseInt(screeningScore) >= cutOffMarks.postUtme ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}>
                                                {parseInt(screeningScore) >= cutOffMarks.postUtme ? 'PASS' : 'FAIL'}
                                            </Badge>
                                        </div>
                                    </div>
                                </div>
                            )}
                        </div>
                    )}

                    <DialogFooter>
                        <Button variant="outline" onClick={() => setScreeningDialogOpen(false)}>Cancel</Button>
                        <Button onClick={handleSaveScreeningScore} disabled={submitting || !screeningScore} className="bg-[#485550] hover:bg-[#6b7c6f]">
                            {submitting && <Loader2 className="w-4 h-4 animate-spin mr-2" />}
                            Save Score
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}
