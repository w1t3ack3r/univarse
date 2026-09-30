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
    Wallet,
    CreditCard,
    Receipt,
    FileText,
    BarChart3,
    Search,
    Plus,
    Edit,
    Trash2,
    Eye,
    CheckCircle,
    XCircle,
    Clock,
    Download,
    Printer,
    Users,
    GraduationCap,
    AlertTriangle,
    Building2,
    Loader2,
    Check,
    X,
    DollarSign,
    TrendingUp,
    Filter,
} from 'lucide-react';
import { toast } from 'sonner';

// Types
interface FeeCategory {
    id: string;
    name: string;
    description: string;
    amount: number;
    level: string;          // 100, 200, 300, 400, 500 or 'ALL'
    programme?: string;     // BSc CSC, MBBS, BEng, etc. or 'ALL'
    category?: string;      // Tuition Fees, Mandatory Fees, Lab & Practicals, One-Time Fees
    session: string;
    isActive: boolean;
}

interface Payment {
    id: string;
    studentId: string;
    studentName: string;
    matricNumber: string;
    programme: string;
    feeCategory: string;
    amount: number;
    amountPaid: number;
    balance: number;
    paymentRef: string;
    paymentDate: string;
    paymentMethod: 'BANK' | 'CARD' | 'REMITA' | 'CASH';
    status: 'PENDING' | 'VERIFIED' | 'FAILED' | 'PARTIAL';
    verifiedBy?: string;
    verifiedAt?: string;
}

interface FeeWaiver {
    id: string;
    studentId: string;
    studentName: string;
    matricNumber: string;
    reason: 'SCHOLARSHIP' | 'STAFF_WARD' | 'INDIGENT' | 'SPORTS' | 'OTHER';
    description: string;
    percentage: number;
    amount: number;
    status: 'PENDING' | 'APPROVED' | 'REJECTED';
    approvedBy?: string;
    session: string;
}

// Mock Data - Programme/Level specific fees with categories
const feeCategories_list = ['Tuition Fees', 'Mandatory Fees', 'Lab & Practicals', 'One-Time Fees'] as const;

const mockFeeCategories: FeeCategory[] = [
    // === TUITION FEES (Programme-specific) ===
    { id: 'f1', name: 'General Tuition', description: 'Default tuition for programmes without specific rates', amount: 150000, level: 'ALL', programme: 'ALL', session: '2024/2025', isActive: true, category: 'Tuition Fees' },
    // Medicine (MBBS)
    { id: 'f2', name: 'MBBS Tuition (100L)', description: 'Medicine & Surgery 100 Level', amount: 250000, level: '100', programme: 'MBBS', session: '2024/2025', isActive: true, category: 'Tuition Fees' },
    { id: 'f3', name: 'MBBS Tuition (200L)', description: 'Medicine & Surgery 200 Level', amount: 350000, level: '200', programme: 'MBBS', session: '2024/2025', isActive: true, category: 'Tuition Fees' },
    { id: 'f4', name: 'MBBS Tuition (300L+)', description: 'Medicine & Surgery 300+ Level', amount: 400000, level: 'ALL', programme: 'MBBS', session: '2024/2025', isActive: true, category: 'Tuition Fees' },
    // Computer Science
    { id: 'f5', name: 'BSc CSC Tuition (100L)', description: 'Computer Science 100 Level', amount: 180000, level: '100', programme: 'BSc CSC', session: '2024/2025', isActive: true, category: 'Tuition Fees' },
    { id: 'f6', name: 'BSc CSC Tuition', description: 'Computer Science 200-400 Level', amount: 200000, level: 'ALL', programme: 'BSc CSC', session: '2024/2025', isActive: true, category: 'Tuition Fees' },
    // Cyber Security
    { id: 'f7', name: 'BSc CYB Tuition', description: 'Cyber Security all levels', amount: 220000, level: 'ALL', programme: 'BSc CYB', session: '2024/2025', isActive: true, category: 'Tuition Fees' },
    // Engineering
    { id: 'f8', name: 'BEng Tuition', description: 'Engineering all levels', amount: 220000, level: 'ALL', programme: 'BEng', session: '2024/2025', isActive: true, category: 'Tuition Fees' },
    // Law
    { id: 'f9', name: 'LLB Tuition', description: 'Law all levels', amount: 280000, level: 'ALL', programme: 'LLB', session: '2024/2025', isActive: true, category: 'Tuition Fees' },

    // === MANDATORY FEES (All students) ===
    { id: 'f10', name: 'Medical Fee', description: 'Health center access', amount: 10000, level: 'ALL', programme: 'ALL', session: '2024/2025', isActive: true, category: 'Mandatory Fees' },
    { id: 'f11', name: 'Library Fee', description: 'Library access and resources', amount: 5000, level: 'ALL', programme: 'ALL', session: '2024/2025', isActive: true, category: 'Mandatory Fees' },
    { id: 'f12', name: 'ICT Fee', description: 'ICT facilities and internet', amount: 15000, level: 'ALL', programme: 'ALL', session: '2024/2025', isActive: true, category: 'Mandatory Fees' },
    { id: 'f13', name: 'Examination Fee', description: 'Semester examination', amount: 10000, level: 'ALL', programme: 'ALL', session: '2024/2025', isActive: true, category: 'Mandatory Fees' },
    { id: 'f14', name: 'Sports Fee', description: 'Sports facilities', amount: 5000, level: 'ALL', programme: 'ALL', session: '2024/2025', isActive: true, category: 'Mandatory Fees' },

    // === LAB & PRACTICALS ===
    { id: 'f15', name: 'BEng Lab Fee', description: 'Engineering lab equipment (200L only)', amount: 30000, level: '200', programme: 'BEng', session: '2024/2025', isActive: true, category: 'Lab & Practicals' },
    { id: 'f16', name: 'BSc CSC Lab Fee', description: 'Computer lab fee', amount: 20000, level: 'ALL', programme: 'BSc CSC', session: '2024/2025', isActive: true, category: 'Lab & Practicals' },
    { id: 'f17', name: 'MBBS Clinical Fee', description: 'Clinical practicals (300L+)', amount: 50000, level: '300', programme: 'MBBS', session: '2024/2025', isActive: true, category: 'Lab & Practicals' },

    // === ONE-TIME FEES ===
    { id: 'f18', name: 'Acceptance Fee', description: 'New students only', amount: 50000, level: '100', programme: 'ALL', session: '2024/2025', isActive: true, category: 'One-Time Fees' },
    { id: 'f19', name: 'Matriculation Fee', description: 'Matriculation gown and ceremony', amount: 15000, level: '100', programme: 'ALL', session: '2024/2025', isActive: true, category: 'One-Time Fees' },
];

const mockPayments: Payment[] = [
    { id: 'p1', studentId: 's1', studentName: 'John Doe', matricNumber: 'STU/2023/001', programme: 'BSc CSC', feeCategory: 'Tuition Fee', amount: 150000, amountPaid: 150000, balance: 0, paymentRef: 'RRR123456789', paymentDate: '2024-09-15T10:30:00', paymentMethod: 'REMITA', status: 'VERIFIED', verifiedBy: 'Admin', verifiedAt: '2024-09-15T14:00:00' },
    { id: 'p2', studentId: 's2', studentName: 'Jane Smith', matricNumber: 'STU/2022/045', programme: 'BSc MTH', feeCategory: 'Tuition Fee', amount: 150000, amountPaid: 100000, balance: 50000, paymentRef: 'RRR234567890', paymentDate: '2024-09-18T09:15:00', paymentMethod: 'BANK', status: 'PARTIAL' },
    { id: 'p3', studentId: 's3', studentName: 'Adebayo Ogundimu', matricNumber: 'STU/2024/001', programme: 'BSc CYB', feeCategory: 'Acceptance Fee', amount: 50000, amountPaid: 50000, balance: 0, paymentRef: 'RRR345678901', paymentDate: '2024-08-25T11:00:00', paymentMethod: 'CARD', status: 'PENDING' },
    { id: 'p4', studentId: 's4', studentName: 'Chidinma Nwosu', matricNumber: 'STU/2024/002', programme: 'MBBS', feeCategory: 'Tuition Fee', amount: 250000, amountPaid: 250000, balance: 0, paymentRef: 'RRR456789012', paymentDate: '2024-09-10T08:45:00', paymentMethod: 'REMITA', status: 'VERIFIED', verifiedBy: 'Bursary', verifiedAt: '2024-09-11T10:00:00' },
    { id: 'p5', studentId: 's5', studentName: 'Emeka Chukwuma', matricNumber: 'STU/2023/078', programme: 'BEng', feeCategory: 'Lab Fee', amount: 30000, amountPaid: 30000, balance: 0, paymentRef: 'RRR567890123', paymentDate: '2024-09-20T14:20:00', paymentMethod: 'BANK', status: 'PENDING' },
    { id: 'p6', studentId: 's6', studentName: 'Fatima Ibrahim', matricNumber: 'STU/2022/112', programme: 'BSc ACC', feeCategory: 'Tuition Fee', amount: 150000, amountPaid: 0, balance: 150000, paymentRef: '', paymentDate: '', paymentMethod: 'BANK', status: 'PENDING' },
];

const mockWaivers: FeeWaiver[] = [
    { id: 'w1', studentId: 's7', studentName: 'Grace Adeyemi', matricNumber: 'STU/2023/050', reason: 'SCHOLARSHIP', description: 'University scholarship recipient', percentage: 100, amount: 150000, status: 'APPROVED', approvedBy: 'Dean', session: '2024/2025' },
    { id: 'w2', studentId: 's8', studentName: 'Mohammed Yusuf', matricNumber: 'STU/2024/015', reason: 'STAFF_WARD', description: 'Child of Prof. Yusuf (Faculty)', percentage: 50, amount: 75000, status: 'PENDING', session: '2024/2025' },
    { id: 'w3', studentId: 's9', studentName: 'Blessing Okoro', matricNumber: 'STU/2023/089', reason: 'SPORTS', description: 'University athlete - Football team', percentage: 25, amount: 37500, status: 'APPROVED', approvedBy: 'Sports Director', session: '2024/2025' },
    { id: 'w4', studentId: 's10', studentName: 'Ahmed Bello', matricNumber: 'STU/2024/022', reason: 'INDIGENT', description: 'Financial hardship - documented', percentage: 50, amount: 75000, status: 'PENDING', session: '2024/2025' },
];

export default function FeeManagement() {
    const [isLoading, setIsLoading] = useState(true);
    const [activeTab, setActiveTab] = useState('structure');
    const [feeCategories, setFeeCategories] = useState<FeeCategory[]>([]);
    const [payments, setPayments] = useState<Payment[]>([]);
    const [waivers, setWaivers] = useState<FeeWaiver[]>([]);
    const [searchTerm, setSearchTerm] = useState('');
    const [statusFilter, setStatusFilter] = useState('all');
    const [submitting, setSubmitting] = useState(false);

    // Dialog states
    const [feeDialogOpen, setFeeDialogOpen] = useState(false);
    const [paymentDetailOpen, setPaymentDetailOpen] = useState(false);
    const [receiptDialogOpen, setReceiptDialogOpen] = useState(false);
    const [waiverDialogOpen, setWaiverDialogOpen] = useState(false);
    const [selectedPayment, setSelectedPayment] = useState<Payment | null>(null);
    const [selectedWaiver, setSelectedWaiver] = useState<FeeWaiver | null>(null);
    const [editingFee, setEditingFee] = useState<FeeCategory | null>(null);

    // Form states
    const [feeForm, setFeeForm] = useState({ name: '', description: '', amount: '', level: 'ALL', programme: 'ALL', category: 'Tuition Fees', isActive: true });

    useEffect(() => {
        setTimeout(() => {
            setFeeCategories(mockFeeCategories);
            setPayments(mockPayments);
            setWaivers(mockWaivers);
            setIsLoading(false);
        }, 500);
    }, []);

    // Stats
    const stats = {
        totalRevenue: payments.filter(p => p.status === 'VERIFIED').reduce((sum, p) => sum + p.amountPaid, 0),
        pendingPayments: payments.filter(p => p.status === 'PENDING').length,
        verifiedPayments: payments.filter(p => p.status === 'VERIFIED').length,
        outstandingFees: payments.reduce((sum, p) => sum + p.balance, 0),
        waiversGranted: waivers.filter(w => w.status === 'APPROVED').reduce((sum, w) => sum + w.amount, 0),
        totalCollection: payments.reduce((sum, p) => sum + p.amountPaid, 0),
    };

    // Filtered payments
    const filteredPayments = payments.filter(p => {
        const matchesSearch = p.studentName.toLowerCase().includes(searchTerm.toLowerCase()) ||
            p.matricNumber.toLowerCase().includes(searchTerm.toLowerCase()) ||
            p.paymentRef.toLowerCase().includes(searchTerm.toLowerCase());
        const matchesStatus = statusFilter === 'all' || p.status === statusFilter;
        return matchesSearch && matchesStatus;
    });

    // Handlers
    const handleCreateFee = () => {
        setEditingFee(null);
        setFeeForm({ name: '', description: '', amount: '', level: 'ALL', programme: 'ALL', category: 'Tuition Fees', isActive: true });
        setFeeDialogOpen(true);
    };

    const handleEditFee = (fee: FeeCategory) => {
        setEditingFee(fee);
        setFeeForm({ name: fee.name, description: fee.description, amount: fee.amount.toString(), level: fee.level, programme: fee.programme || 'ALL', category: fee.category || 'Tuition Fees', isActive: fee.isActive });
        setFeeDialogOpen(true);
    };

    const handleSaveFee = async () => {
        if (!feeForm.name || !feeForm.amount) {
            toast.error('Please fill in required fields');
            return;
        }
        setSubmitting(true);
        await new Promise(r => setTimeout(r, 500));

        if (editingFee) {
            setFeeCategories(feeCategories.map(f => f.id === editingFee.id ? { ...f, ...feeForm, amount: parseFloat(feeForm.amount) } : f));
            toast.success('Fee category updated!');
        } else {
            const newFee: FeeCategory = { id: `f${Date.now()}`, ...feeForm, amount: parseFloat(feeForm.amount), session: '2024/2025' };
            setFeeCategories([...feeCategories, newFee]);
            toast.success('Fee category created!');
        }
        setFeeDialogOpen(false);
        setSubmitting(false);
    };

    const handleDeleteFee = (feeId: string) => {
        if (!confirm('Delete this fee category?')) return;
        setFeeCategories(feeCategories.filter(f => f.id !== feeId));
        toast.success('Fee category deleted');
    };

    const handleViewPayment = (payment: Payment) => {
        setSelectedPayment(payment);
        setPaymentDetailOpen(true);
    };

    const handleVerifyPayment = async (paymentId: string) => {
        setSubmitting(true);
        await new Promise(r => setTimeout(r, 1000));
        setPayments(payments.map(p => p.id === paymentId ? { ...p, status: 'VERIFIED', verifiedBy: 'Admin', verifiedAt: new Date().toISOString() } : p));
        toast.success('Payment verified successfully!');
        setPaymentDetailOpen(false);
        setSubmitting(false);
    };

    const handleGenerateReceipt = (payment: Payment) => {
        setSelectedPayment(payment);
        setReceiptDialogOpen(true);
    };

    const handlePrintReceipt = () => {
        const content = document.getElementById('receipt-content');
        if (!content) return;
        const win = window.open('', '_blank');
        if (!win) { toast.error('Allow popups for printing'); return; }
        win.document.write(`<!DOCTYPE html><html><head><title>Payment Receipt</title><style>body{font-family:Arial,sans-serif;max-width:600px;margin:40px auto;padding:20px}.header{text-align:center;border-bottom:2px solid #485550;padding-bottom:20px;margin-bottom:20px}.header h1{color:#485550;margin:0}.table{width:100%;border-collapse:collapse;margin:20px 0}.table td{padding:10px;border-bottom:1px solid #ddd}.label{color:#666;width:40%}.value{font-weight:bold}.footer{text-align:center;margin-top:40px;color:#666;font-size:12px}@media print{body{margin:0}}</style></head><body>${content.innerHTML}</body></html>`);
        win.document.close();
        win.print();
    };

    const handleApproveWaiver = async (waiverId: string, approve: boolean) => {
        setSubmitting(true);
        await new Promise(r => setTimeout(r, 500));
        setWaivers(waivers.map(w => w.id === waiverId ? { ...w, status: approve ? 'APPROVED' : 'REJECTED', approvedBy: 'Admin' } : w));
        toast.success(`Waiver ${approve ? 'approved' : 'rejected'}!`);
        setWaiverDialogOpen(false);
        setSubmitting(false);
    };

    const handleExportPayments = () => {
        const csv = ['Student,Matric,Amount,Paid,Balance,Ref,Status'];
        filteredPayments.forEach(p => csv.push(`"${p.studentName}","${p.matricNumber}",${p.amount},${p.amountPaid},${p.balance},"${p.paymentRef}","${p.status}"`));
        const blob = new Blob([csv.join('\n')], { type: 'text/csv' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = `payments_${new Date().toISOString().split('T')[0]}.csv`;
        link.click();
        toast.success('Payments exported!');
    };

    const formatCurrency = (amount: number) => new Intl.NumberFormat('en-NG', { style: 'currency', currency: 'NGN' }).format(amount);
    const formatDate = (dateString: string) => dateString ? new Date(dateString).toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric' }) : '-';

    const getStatusBadge = (status: string) => {
        switch (status) {
            case 'VERIFIED': return <Badge className="bg-green-100 text-green-700">Verified</Badge>;
            case 'PENDING': return <Badge className="bg-amber-100 text-amber-700">Pending</Badge>;
            case 'PARTIAL': return <Badge className="bg-blue-100 text-blue-700">Partial</Badge>;
            case 'FAILED': return <Badge className="bg-red-100 text-red-700">Failed</Badge>;
            case 'APPROVED': return <Badge className="bg-green-100 text-green-700">Approved</Badge>;
            case 'REJECTED': return <Badge className="bg-red-100 text-red-700">Rejected</Badge>;
            default: return <Badge variant="outline">{status}</Badge>;
        }
    };

    const getWaiverReasonBadge = (reason: string) => {
        const colors: Record<string, string> = { SCHOLARSHIP: 'bg-purple-100 text-purple-700', STAFF_WARD: 'bg-blue-100 text-blue-700', INDIGENT: 'bg-amber-100 text-amber-700', SPORTS: 'bg-green-100 text-green-700', OTHER: 'bg-gray-100 text-gray-700' };
        return <Badge className={colors[reason] || 'bg-gray-100'}>{reason.replace('_', ' ')}</Badge>;
    };

    if (isLoading) {
        return <div className="flex items-center justify-center h-64"><Loader2 className="h-8 w-8 animate-spin text-[#485550]" /></div>;
    }

    return (
        <div className="space-y-6">
            {/* Header */}
            <div>
                <h1 className="text-3xl font-bold text-[#485550]">Fee Management</h1>
                <p className="text-[#485550]/60 mt-1">Manage fee structures, track payments, and process waivers</p>
            </div>

            {/* Stats Cards */}
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
                <Card className="border-[#F4F6F0]">
                    <CardContent className="p-4">
                        <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-lg bg-green-100 flex items-center justify-center">
                                <TrendingUp className="w-5 h-5 text-green-600" />
                            </div>
                            <div>
                                <p className="text-lg font-bold text-green-600">{formatCurrency(stats.totalRevenue)}</p>
                                <p className="text-xs text-[#485550]/60">Verified Revenue</p>
                            </div>
                        </div>
                    </CardContent>
                </Card>
                <Card className="border-[#F4F6F0]">
                    <CardContent className="p-4">
                        <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-lg bg-amber-100 flex items-center justify-center">
                                <Clock className="w-5 h-5 text-amber-600" />
                            </div>
                            <div>
                                <p className="text-2xl font-bold text-amber-600">{stats.pendingPayments}</p>
                                <p className="text-xs text-[#485550]/60">Pending</p>
                            </div>
                        </div>
                    </CardContent>
                </Card>
                <Card className="border-[#F4F6F0]">
                    <CardContent className="p-4">
                        <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-lg bg-[#C0EB6A]/20 flex items-center justify-center">
                                <CheckCircle className="w-5 h-5 text-green-600" />
                            </div>
                            <div>
                                <p className="text-2xl font-bold text-green-600">{stats.verifiedPayments}</p>
                                <p className="text-xs text-[#485550]/60">Verified</p>
                            </div>
                        </div>
                    </CardContent>
                </Card>
                <Card className="border-[#F4F6F0]">
                    <CardContent className="p-4">
                        <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-lg bg-red-100 flex items-center justify-center">
                                <AlertTriangle className="w-5 h-5 text-red-500" />
                            </div>
                            <div>
                                <p className="text-lg font-bold text-red-500">{formatCurrency(stats.outstandingFees)}</p>
                                <p className="text-xs text-[#485550]/60">Outstanding</p>
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
                                <p className="text-lg font-bold text-purple-600">{formatCurrency(stats.waiversGranted)}</p>
                                <p className="text-xs text-[#485550]/60">Waivers</p>
                            </div>
                        </div>
                    </CardContent>
                </Card>
                <Card className="border-[#F4F6F0]">
                    <CardContent className="p-4">
                        <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-lg bg-[#485550] flex items-center justify-center">
                                <Wallet className="w-5 h-5 text-white" />
                            </div>
                            <div>
                                <p className="text-lg font-bold text-[#485550]">{formatCurrency(stats.totalCollection)}</p>
                                <p className="text-xs text-[#485550]/60">Total Collection</p>
                            </div>
                        </div>
                    </CardContent>
                </Card>
            </div>

            {/* Tabs */}
            <Tabs value={activeTab} onValueChange={setActiveTab}>
                <TabsList className="grid w-full grid-cols-5 bg-[#485550]">
                    <TabsTrigger value="structure" className="text-white data-[state=active]:bg-[#C0EB6A] data-[state=active]:text-[#485550]">
                        <FileText className="w-4 h-4 mr-1" /> Structure
                    </TabsTrigger>
                    <TabsTrigger value="payments" className="text-white data-[state=active]:bg-[#C0EB6A] data-[state=active]:text-[#485550]">
                        <CreditCard className="w-4 h-4 mr-1" /> Payments
                    </TabsTrigger>
                    <TabsTrigger value="receipts" className="text-white data-[state=active]:bg-[#C0EB6A] data-[state=active]:text-[#485550]">
                        <Receipt className="w-4 h-4 mr-1" /> Receipts
                    </TabsTrigger>
                    <TabsTrigger value="waivers" className="text-white data-[state=active]:bg-[#C0EB6A] data-[state=active]:text-[#485550]">
                        <GraduationCap className="w-4 h-4 mr-1" /> Waivers
                    </TabsTrigger>
                    <TabsTrigger value="reports" className="text-white data-[state=active]:bg-[#C0EB6A] data-[state=active]:text-[#485550]">
                        <BarChart3 className="w-4 h-4 mr-1" /> Reports
                    </TabsTrigger>
                </TabsList>

                <TabsContent value="structure" className="space-y-4 mt-4">
                    <div className="flex justify-between items-center">
                        <h2 className="text-lg font-semibold text-[#485550]">Fee Structure - 2024/2025 Session</h2>
                        <Button onClick={handleCreateFee} className="bg-[#485550] hover:bg-[#6b7c6f]">
                            <Plus className="w-4 h-4 mr-2" /> Add Fee
                        </Button>
                    </div>

                    {/* Grouped by Category */}
                    {['Tuition Fees', 'Mandatory Fees', 'Lab & Practicals', 'One-Time Fees'].map((category) => {
                        const categoryFees = feeCategories.filter(f => f.category === category);
                        if (categoryFees.length === 0) return null;

                        const categoryColors: Record<string, string> = {
                            'Tuition Fees': 'bg-blue-500',
                            'Mandatory Fees': 'bg-amber-500',
                            'Lab & Practicals': 'bg-purple-500',
                            'One-Time Fees': 'bg-green-500',
                        };

                        return (
                            <Card key={category} className="border-[#F4F6F0]">
                                <CardHeader className="py-3">
                                    <div className="flex items-center gap-3">
                                        <div className={`w-3 h-3 rounded-full ${categoryColors[category]}`}></div>
                                        <CardTitle className="text-[#485550] text-base">{category}</CardTitle>
                                        <Badge variant="outline" className="ml-auto">{categoryFees.length} items</Badge>
                                    </div>
                                </CardHeader>
                                <CardContent className="pt-0">
                                    <div className="space-y-2">
                                        {categoryFees.map((fee) => (
                                            <div key={fee.id} className="flex items-center justify-between p-3 bg-[#F4F6F0]/50 rounded-lg hover:bg-[#F4F6F0] transition-colors">
                                                <div className="flex items-center gap-4 flex-1">
                                                    <div className="min-w-[200px]">
                                                        <p className="font-medium text-[#485550]">{fee.name}</p>
                                                        <p className="text-xs text-[#485550]/60">{fee.description}</p>
                                                    </div>
                                                    <div className="font-bold text-[#485550] min-w-[100px]">{formatCurrency(fee.amount)}</div>
                                                    <Badge className={fee.programme === 'ALL' ? 'bg-gray-100 text-gray-600' : 'bg-blue-100 text-blue-700'}>
                                                        {fee.programme || 'ALL'}
                                                    </Badge>
                                                    <Badge className={fee.level === 'ALL' ? 'bg-gray-100 text-gray-600' : 'bg-purple-100 text-purple-700'}>
                                                        {fee.level === 'ALL' ? 'All' : `${fee.level}L`}
                                                    </Badge>
                                                </div>
                                                <div className="flex items-center gap-2">
                                                    <Badge className={fee.isActive ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}>
                                                        {fee.isActive ? 'Active' : 'Inactive'}
                                                    </Badge>
                                                    <Button size="sm" variant="ghost" onClick={() => handleEditFee(fee)}><Edit className="w-4 h-4 text-[#485550]" /></Button>
                                                    <Button size="sm" variant="ghost" onClick={() => handleDeleteFee(fee.id)}><Trash2 className="w-4 h-4 text-red-500" /></Button>
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                </CardContent>
                            </Card>
                        );
                    })}
                </TabsContent>

                {/* Payments Tab */}
                <TabsContent value="payments" className="space-y-4 mt-4">
                    <Card className="border-[#F4F6F0]">
                        <CardContent className="p-4">
                            <div className="flex flex-wrap gap-4">
                                <div className="flex-1 min-w-[200px]">
                                    <div className="relative">
                                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#485550]/40" />
                                        <Input placeholder="Search by name, matric, or reference..." value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} className="pl-10 border-[#485550]/20" />
                                    </div>
                                </div>
                                <Select value={statusFilter} onValueChange={setStatusFilter}>
                                    <SelectTrigger className="w-[150px] border-[#485550]/20"><SelectValue placeholder="Status" /></SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="all">All Status</SelectItem>
                                        <SelectItem value="PENDING">Pending</SelectItem>
                                        <SelectItem value="VERIFIED">Verified</SelectItem>
                                        <SelectItem value="PARTIAL">Partial</SelectItem>
                                    </SelectContent>
                                </Select>
                                <Button variant="outline" onClick={handleExportPayments} className="border-[#485550] text-[#485550]">
                                    <Download className="w-4 h-4 mr-2" /> Export
                                </Button>
                            </div>
                        </CardContent>
                    </Card>

                    <Card className="border-[#F4F6F0]">
                        <CardHeader>
                            <CardTitle className="text-[#485550]">Payment Records ({filteredPayments.length})</CardTitle>
                        </CardHeader>
                        <CardContent>
                            <div className="space-y-3">
                                {filteredPayments.map((payment) => (
                                    <div key={payment.id} className="flex items-center justify-between p-4 border border-[#F4F6F0] rounded-lg hover:bg-[#F4F6F0]/50">
                                        <div className="flex items-center gap-4">
                                            <div className="w-10 h-10 rounded-full bg-[#485550] flex items-center justify-center text-white font-bold">
                                                {payment.studentName.split(' ').map(n => n[0]).join('')}
                                            </div>
                                            <div>
                                                <p className="font-semibold text-[#485550]">{payment.studentName}</p>
                                                <p className="text-sm text-[#485550]/70">{payment.matricNumber} â€¢ {payment.feeCategory}</p>
                                            </div>
                                        </div>
                                        <div className="flex items-center gap-4">
                                            <div className="text-right">
                                                <p className="font-bold text-[#485550]">{formatCurrency(payment.amountPaid)}</p>
                                                {payment.balance > 0 && <p className="text-xs text-red-500">Balance: {formatCurrency(payment.balance)}</p>}
                                            </div>
                                            {getStatusBadge(payment.status)}
                                            <Button size="sm" variant="outline" onClick={() => handleViewPayment(payment)} className="border-[#485550]/30">
                                                <Eye className="w-4 h-4" />
                                            </Button>
                                            {payment.status === 'PENDING' && (
                                                <Button size="sm" onClick={() => handleVerifyPayment(payment.id)} className="bg-green-600 hover:bg-green-700">
                                                    <Check className="w-4 h-4" />
                                                </Button>
                                            )}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </CardContent>
                    </Card>
                </TabsContent>

                {/* Receipts Tab */}
                <TabsContent value="receipts" className="space-y-4 mt-4">
                    <Card className="border-[#F4F6F0]">
                        <CardHeader>
                            <CardTitle className="text-[#485550]">Verified Payments - Generate Receipts</CardTitle>
                            <CardDescription>Generate and print receipts for verified payments</CardDescription>
                        </CardHeader>
                        <CardContent>
                            <div className="space-y-3">
                                {payments.filter(p => p.status === 'VERIFIED').map((payment) => (
                                    <div key={payment.id} className="flex items-center justify-between p-4 border border-[#F4F6F0] rounded-lg">
                                        <div className="flex items-center gap-4">
                                            <div className="w-10 h-10 rounded-lg bg-green-100 flex items-center justify-center">
                                                <Receipt className="w-5 h-5 text-green-600" />
                                            </div>
                                            <div>
                                                <p className="font-semibold text-[#485550]">{payment.studentName}</p>
                                                <p className="text-sm text-[#485550]/70">{payment.matricNumber} â€¢ {payment.feeCategory}</p>
                                            </div>
                                        </div>
                                        <div className="flex items-center gap-4">
                                            <div className="text-right">
                                                <p className="font-bold text-[#485550]">{formatCurrency(payment.amountPaid)}</p>
                                                <p className="text-xs text-[#485550]/60">{formatDate(payment.paymentDate)}</p>
                                            </div>
                                            <Button onClick={() => handleGenerateReceipt(payment)} className="bg-[#485550] hover:bg-[#6b7c6f]">
                                                <Printer className="w-4 h-4 mr-2" /> Receipt
                                            </Button>
                                        </div>
                                    </div>
                                ))}
                                {payments.filter(p => p.status === 'VERIFIED').length === 0 && (
                                    <div className="p-8 text-center">
                                        <Receipt className="w-12 h-12 text-[#485550]/30 mx-auto mb-4" />
                                        <p className="text-[#485550]/60">No verified payments to generate receipts</p>
                                    </div>
                                )}
                            </div>
                        </CardContent>
                    </Card>
                </TabsContent>

                {/* Waivers Tab */}
                <TabsContent value="waivers" className="space-y-4 mt-4">
                    <Card className="border-[#F4F6F0]">
                        <CardHeader>
                            <CardTitle className="text-[#485550]">Fee Waiver Requests</CardTitle>
                            <CardDescription>Manage scholarship and fee reduction requests</CardDescription>
                        </CardHeader>
                        <CardContent>
                            <div className="space-y-3">
                                {waivers.map((waiver) => (
                                    <div key={waiver.id} className="flex items-center justify-between p-4 border border-[#F4F6F0] rounded-lg hover:bg-[#F4F6F0]/50">
                                        <div className="flex items-center gap-4">
                                            <div className="w-10 h-10 rounded-full bg-purple-100 flex items-center justify-center">
                                                <GraduationCap className="w-5 h-5 text-purple-600" />
                                            </div>
                                            <div>
                                                <p className="font-semibold text-[#485550]">{waiver.studentName}</p>
                                                <p className="text-sm text-[#485550]/70">{waiver.matricNumber}</p>
                                            </div>
                                        </div>
                                        <div className="flex items-center gap-3">
                                            {getWaiverReasonBadge(waiver.reason)}
                                            <div className="text-right">
                                                <p className="font-bold text-[#485550]">{waiver.percentage}% off</p>
                                                <p className="text-xs text-[#485550]/60">{formatCurrency(waiver.amount)}</p>
                                            </div>
                                            {getStatusBadge(waiver.status)}
                                            {waiver.status === 'PENDING' && (
                                                <>
                                                    <Button size="sm" onClick={() => handleApproveWaiver(waiver.id, true)} className="bg-green-600 hover:bg-green-700"><Check className="w-4 h-4" /></Button>
                                                    <Button size="sm" variant="outline" onClick={() => handleApproveWaiver(waiver.id, false)} className="border-red-300 text-red-500"><X className="w-4 h-4" /></Button>
                                                </>
                                            )}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </CardContent>
                    </Card>
                </TabsContent>

                {/* Reports Tab */}
                <TabsContent value="reports" className="space-y-4 mt-4">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <Card className="border-[#F4F6F0]">
                            <CardHeader>
                                <CardTitle className="text-[#485550]">Outstanding Fees by Programme</CardTitle>
                            </CardHeader>
                            <CardContent>
                                <div className="space-y-3">
                                    {['Computer Science', 'Medicine', 'Engineering', 'Accounting'].map((dept, i) => (
                                        <div key={dept} className="flex justify-between items-center p-3 bg-[#F4F6F0] rounded-lg">
                                            <span className="font-medium text-[#485550]">{dept}</span>
                                            <span className="font-bold text-red-500">{formatCurrency([200000, 150000, 100000, 50000][i])}</span>
                                        </div>
                                    ))}
                                </div>
                            </CardContent>
                        </Card>
                        <Card className="border-[#F4F6F0]">
                            <CardHeader>
                                <CardTitle className="text-[#485550]">Collection Summary</CardTitle>
                            </CardHeader>
                            <CardContent>
                                <div className="space-y-3">
                                    <div className="flex justify-between p-3 bg-[#F4F6F0] rounded-lg">
                                        <span className="text-[#485550]">Total Billed</span>
                                        <span className="font-bold text-[#485550]">{formatCurrency(payments.reduce((s, p) => s + p.amount, 0))}</span>
                                    </div>
                                    <div className="flex justify-between p-3 bg-green-50 rounded-lg">
                                        <span className="text-green-700">Total Collected</span>
                                        <span className="font-bold text-green-700">{formatCurrency(stats.totalCollection)}</span>
                                    </div>
                                    <div className="flex justify-between p-3 bg-red-50 rounded-lg">
                                        <span className="text-red-700">Outstanding</span>
                                        <span className="font-bold text-red-700">{formatCurrency(stats.outstandingFees)}</span>
                                    </div>
                                    <div className="flex justify-between p-3 bg-purple-50 rounded-lg">
                                        <span className="text-purple-700">Waivers Granted</span>
                                        <span className="font-bold text-purple-700">{formatCurrency(stats.waiversGranted)}</span>
                                    </div>
                                </div>
                            </CardContent>
                        </Card>
                    </div>

                    <Card className="border-[#F4F6F0]">
                        <CardHeader>
                            <CardTitle className="text-[#485550]">Bursary Clearance Status</CardTitle>
                            <CardDescription>Students who have fully paid their fees</CardDescription>
                        </CardHeader>
                        <CardContent>
                            <div className="space-y-2">
                                {payments.filter(p => p.status === 'VERIFIED' && p.balance === 0).map((p) => (
                                    <div key={p.id} className="flex items-center justify-between p-3 border border-[#F4F6F0] rounded-lg">
                                        <div className="flex items-center gap-3">
                                            <CheckCircle className="w-5 h-5 text-green-600" />
                                            <div>
                                                <p className="font-medium text-[#485550]">{p.studentName}</p>
                                                <p className="text-xs text-[#485550]/60">{p.matricNumber} • {p.programme}</p>
                                            </div>
                                        </div>
                                        <Badge className="bg-green-100 text-green-700">Cleared</Badge>
                                    </div>
                                ))}
                            </div>
                        </CardContent>
                    </Card>
                </TabsContent>
            </Tabs>

            {/* Fee Category Dialog */}
            <Dialog open={feeDialogOpen} onOpenChange={setFeeDialogOpen}>
                <DialogContent className="max-w-md">
                    <DialogHeader>
                        <DialogTitle className="text-[#485550]">{editingFee ? 'Edit' : 'Create'} Fee Category</DialogTitle>
                    </DialogHeader>
                    <div className="space-y-4 py-4">
                        <div className="space-y-2">
                            <Label>Fee Name <span className="text-red-500">*</span></Label>
                            <Input value={feeForm.name} onChange={(e) => setFeeForm({ ...feeForm, name: e.target.value })} placeholder="e.g. BSc CSC Tuition" className="border-[#485550]/20" />
                        </div>
                        <div className="space-y-2">
                            <Label>Description</Label>
                            <Textarea value={feeForm.description} onChange={(e) => setFeeForm({ ...feeForm, description: e.target.value })} placeholder="Brief description..." className="border-[#485550]/20" rows={2} />
                        </div>
                        <div className="grid grid-cols-2 gap-4">
                            <div className="space-y-2">
                                <Label>Amount (₦) <span className="text-red-500">*</span></Label>
                                <Input type="number" value={feeForm.amount} onChange={(e) => setFeeForm({ ...feeForm, amount: e.target.value })} className="border-[#485550]/20" placeholder="150000" />
                            </div>
                            <div className="space-y-2">
                                <Label>Category <span className="text-red-500">*</span></Label>
                                <Select value={feeForm.category} onValueChange={(v) => setFeeForm({ ...feeForm, category: v })}>
                                    <SelectTrigger className="border-[#485550]/20"><SelectValue placeholder="Select..." /></SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="Tuition Fees">Tuition Fees</SelectItem>
                                        <SelectItem value="Mandatory Fees">Mandatory Fees</SelectItem>
                                        <SelectItem value="Lab & Practicals">Lab & Practicals</SelectItem>
                                        <SelectItem value="One-Time Fees">One-Time Fees</SelectItem>
                                    </SelectContent>
                                </Select>
                            </div>
                        </div>
                        <div className="grid grid-cols-2 gap-4">
                            <div className="space-y-2">
                                <Label>Programme</Label>
                                <Select value={feeForm.programme} onValueChange={(v) => setFeeForm({ ...feeForm, programme: v })}>
                                    <SelectTrigger className="border-[#485550]/20"><SelectValue /></SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="ALL">All Programmes</SelectItem>
                                        <SelectItem value="MBBS">MBBS (Medicine)</SelectItem>
                                        <SelectItem value="BSc CSC">BSc CSC (Computer Science)</SelectItem>
                                        <SelectItem value="BSc CYB">BSc CYB (Cyber Security)</SelectItem>
                                        <SelectItem value="BEng">BEng (Engineering)</SelectItem>
                                        <SelectItem value="LLB">LLB (Law)</SelectItem>
                                        <SelectItem value="BSc ACC">BSc ACC (Accounting)</SelectItem>
                                        <SelectItem value="BSc MTH">BSc MTH (Mathematics)</SelectItem>
                                        <SelectItem value="BSc PHY">BSc PHY (Physics)</SelectItem>
                                        <SelectItem value="BSc CHM">BSc CHM (Chemistry)</SelectItem>
                                    </SelectContent>
                                </Select>
                            </div>
                            <div className="space-y-2">
                                <Label>Level</Label>
                                <Select value={feeForm.level} onValueChange={(v) => setFeeForm({ ...feeForm, level: v })}>
                                    <SelectTrigger className="border-[#485550]/20"><SelectValue /></SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="ALL">All Levels</SelectItem>
                                        <SelectItem value="100">100 Level</SelectItem>
                                        <SelectItem value="200">200 Level</SelectItem>
                                        <SelectItem value="300">300 Level</SelectItem>
                                        <SelectItem value="400">400 Level</SelectItem>
                                        <SelectItem value="500">500 Level</SelectItem>
                                    </SelectContent>
                                </Select>
                            </div>
                        </div>
                        <p className="text-xs text-[#485550]/60 bg-[#F4F6F0] p-2 rounded">
                            💡 Select specific programme and level to create targeted fees (e.g., MBBS 100L = ₦250,000)
                        </p>
                    </div>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setFeeDialogOpen(false)}>Cancel</Button>
                        <Button onClick={handleSaveFee} disabled={submitting} className="bg-[#485550] hover:bg-[#6b7c6f]">
                            {submitting && <Loader2 className="w-4 h-4 animate-spin mr-2" />}Save
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* Payment Detail Dialog */}
            <Dialog open={paymentDetailOpen} onOpenChange={setPaymentDetailOpen}>
                <DialogContent className="max-w-md">
                    <DialogHeader>
                        <DialogTitle className="text-[#485550]">Payment Details</DialogTitle>
                    </DialogHeader>
                    {selectedPayment && (
                        <div className="space-y-4 py-4">
                            <div className="flex items-center gap-4 pb-4 border-b">
                                <div className="w-14 h-14 rounded-full bg-[#485550] flex items-center justify-center text-white text-xl font-bold">
                                    {selectedPayment.studentName.split(' ').map(n => n[0]).join('')}
                                </div>
                                <div>
                                    <p className="font-bold text-[#485550]">{selectedPayment.studentName}</p>
                                    <p className="text-sm text-[#485550]/70">{selectedPayment.matricNumber}</p>
                                </div>
                            </div>
                            <div className="grid grid-cols-2 gap-3 text-sm">
                                <div><span className="text-[#485550]/60">Fee Type:</span><br /><span className="font-medium">{selectedPayment.feeCategory}</span></div>
                                <div><span className="text-[#485550]/60">Amount:</span><br /><span className="font-bold">{formatCurrency(selectedPayment.amount)}</span></div>
                                <div><span className="text-[#485550]/60">Paid:</span><br /><span className="font-bold text-green-600">{formatCurrency(selectedPayment.amountPaid)}</span></div>
                                <div><span className="text-[#485550]/60">Balance:</span><br /><span className="font-bold text-red-500">{formatCurrency(selectedPayment.balance)}</span></div>
                                <div><span className="text-[#485550]/60">Reference:</span><br /><span className="font-mono">{selectedPayment.paymentRef || '-'}</span></div>
                                <div><span className="text-[#485550]/60">Method:</span><br /><span>{selectedPayment.paymentMethod}</span></div>
                                <div className="col-span-2"><span className="text-[#485550]/60">Date:</span> {formatDate(selectedPayment.paymentDate)}</div>
                            </div>
                            <div className="flex items-center gap-2 pt-2">{getStatusBadge(selectedPayment.status)}{selectedPayment.verifiedBy && <span className="text-xs text-[#485550]/60">by {selectedPayment.verifiedBy}</span>}</div>
                        </div>
                    )}
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setPaymentDetailOpen(false)}>Close</Button>
                        {selectedPayment?.status === 'PENDING' && (
                            <Button onClick={() => handleVerifyPayment(selectedPayment.id)} disabled={submitting} className="bg-green-600 hover:bg-green-700">
                                {submitting && <Loader2 className="w-4 h-4 animate-spin mr-2" />}<Check className="w-4 h-4 mr-2" /> Verify
                            </Button>
                        )}
                        {selectedPayment?.status === 'VERIFIED' && (
                            <Button onClick={() => { setPaymentDetailOpen(false); handleGenerateReceipt(selectedPayment); }} className="bg-[#485550] hover:bg-[#6b7c6f]">
                                <Printer className="w-4 h-4 mr-2" /> Receipt
                            </Button>
                        )}
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* Receipt Dialog */}
            <Dialog open={receiptDialogOpen} onOpenChange={setReceiptDialogOpen}>
                <DialogContent className="max-w-lg">
                    <DialogHeader>
                        <DialogTitle className="text-[#485550] flex items-center gap-2"><Receipt className="w-5 h-5" /> Payment Receipt</DialogTitle>
                    </DialogHeader>
                    {selectedPayment && (
                        <div id="receipt-content" className="bg-white p-6 border rounded-lg">
                            <div className="text-center border-b-2 border-[#485550] pb-4 mb-4">
                                <div className="w-16 h-16 bg-[#485550] rounded-full mx-auto mb-2 flex items-center justify-center">
                                    <GraduationCap className="w-8 h-8 text-white" />
                                </div>
                                <h1 className="text-xl font-bold text-[#485550]">UNIVARSE UNIVERSITY</h1>
                                <p className="text-sm text-[#485550]/60">Payment Receipt</p>
                            </div>
                            <table className="w-full text-sm">
                                <tbody>
                                    <tr><td className="py-2 text-[#485550]/60 w-1/3">Receipt No:</td><td className="font-mono">RCT-{selectedPayment.id.toUpperCase()}</td></tr>
                                    <tr><td className="py-2 text-[#485550]/60">Date:</td><td>{formatDate(selectedPayment.paymentDate)}</td></tr>
                                    <tr><td className="py-2 text-[#485550]/60">Student:</td><td className="font-semibold">{selectedPayment.studentName}</td></tr>
                                    <tr><td className="py-2 text-[#485550]/60">Matric No:</td><td>{selectedPayment.matricNumber}</td></tr>
                                    <tr><td className="py-2 text-[#485550]/60">Fee Type:</td><td>{selectedPayment.feeCategory}</td></tr>
                                    <tr><td className="py-2 text-[#485550]/60">Amount Paid:</td><td className="font-bold text-lg text-green-600">{formatCurrency(selectedPayment.amountPaid)}</td></tr>
                                    <tr><td className="py-2 text-[#485550]/60">Payment Ref:</td><td className="font-mono">{selectedPayment.paymentRef}</td></tr>
                                    <tr><td className="py-2 text-[#485550]/60">Method:</td><td>{selectedPayment.paymentMethod}</td></tr>
                                </tbody>
                            </table>
                            <div className="mt-6 pt-4 border-t text-center text-xs text-[#485550]/60">
                                <p>This is a computer-generated receipt.</p>
                                <p>For queries, contact: bursary@univarse.edu.ng</p>
                            </div>
                        </div>
                    )}
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setReceiptDialogOpen(false)}>Close</Button>
                        <Button onClick={handlePrintReceipt} className="bg-[#485550] hover:bg-[#6b7c6f]">
                            <Printer className="w-4 h-4 mr-2" /> Print
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}
