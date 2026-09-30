'use client';

import { useState, useRef } from 'react';
import {
    DollarSign,
    FileText,
    Users,
    Check,
    MoreVertical,
    Download,
    Plus,
    BarChart3,
    ArrowUpRight,
    ArrowDownRight,
    Printer,
    Save,
    Briefcase,
    Edit2
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Dialog, DialogContent, DialogTrigger, DialogTitle } from '@/components/ui/dialog';
import { toast } from 'sonner';

// --- MOCK DATA & TYPES ---

interface PricingTier {
    id: string;
    name: string;
    price: number;
    currency: string;
    features: string[];
    isPopular?: boolean;
}

interface StudentRange {
    id: string;
    min: number;
    max: number | null;
    tiers: PricingTier[];
}

const INITIAL_RANGES: StudentRange[] = [
    {
        id: '1',
        min: 0,
        max: 500,
        tiers: [
            { id: 't1', name: 'Basic', price: 98, currency: 'USD', features: ['LMS Access', 'Email Support'] },
            { id: 't2', name: 'Pro', price: 199, currency: 'USD', features: ['LMS Access', 'Priority Support', 'Analytics'], isPopular: true },
            { id: 't3', name: 'Premium', price: 399, currency: 'USD', features: ['All Features', 'Dedicated Manager', 'API Access'] },
        ]
    },
    {
        id: '2',
        min: 501,
        max: 2000,
        tiers: [
            { id: 't4', name: 'Basic', price: 299, currency: 'USD', features: ['LMS Access', 'Email Support'] },
            { id: 't5', name: 'Pro', price: 599, currency: 'USD', features: ['LMS Access', 'Priority Support', 'Analytics'], isPopular: true },
            { id: 't6', name: 'Premium', price: 899, currency: 'USD', features: ['All Features', 'Dedicated Manager', 'API Access'] },
        ]
    }
];

const FLAT_RATE_TIERS: PricingTier[] = [
    { id: 'f1', name: 'Starter License', price: 499, currency: 'USD', features: ['Up to 1000 users', 'Standard Support'] },
    { id: 'f2', name: 'Enterprise License', price: 2499, currency: 'USD', features: ['Unlimited users', '24/7 Support', 'SLA', 'On-premise option'], isPopular: true },
];

const MOCK_INVOICES = [
    { id: 'INV-2024-001', tenant: 'Universal Tech', date: '2026-01-30', amount: 899, status: 'PAID', items: [{ desc: 'Premium Plan (501-2000 Students)', qty: 1, price: 899 }] },
    { id: 'INV-2024-002', tenant: 'Cyber Academy', date: '2026-01-28', amount: 599, status: 'PAID', items: [{ desc: 'Pro Plan (501-2000 Students)', qty: 1, price: 599 }] },
    { id: 'INV-2024-003', tenant: 'EdTech High', date: '2026-01-25', amount: 199, status: 'OVERDUE', items: [{ desc: 'Pro Plan (0-500 Students)', qty: 1, price: 199 }] },
    { id: 'INV-2024-004', tenant: 'Future Learn', date: '2026-01-20', amount: 899, status: 'PAID', items: [{ desc: 'Premium Plan (501-2000 Students)', qty: 1, price: 899 }] },
];

// --- COMPONENTS ---

export default function BillingPage() {
    const [selectedTab, setSelectedTab] = useState('overview');
    const [billingCycle, setBillingCycle] = useState<'monthly' | 'yearly'>('monthly');
    const [pricingModel, setPricingModel] = useState<'students' | 'flat'>('students');
    const [studentRanges, setStudentRanges] = useState<StudentRange[]>(INITIAL_RANGES);
    const [flatTiers, setFlatTiers] = useState<PricingTier[]>(FLAT_RATE_TIERS);
    const [selectedInvoice, setSelectedInvoice] = useState<typeof MOCK_INVOICES[0] | null>(null);

    // -- ACTIONS --

    const handleSavePricing = () => {
        const promise = new Promise(resolve => setTimeout(resolve, 1000));
        toast.promise(promise, {
            loading: 'Updating pricing engine...',
            success: 'Pricing tiers updated successfully',
            error: 'Failed to update pricing'
        });
    };

    const handlePrintInvoice = () => {
        window.print();
    };

    const calculatePrice = (basePrice: number) => {
        if (billingCycle === 'yearly') {
            return Math.floor(basePrice * 12 * 0.8); // 20% discount
        }
        return basePrice;
    };

    return (
        <div className="space-y-6">
            <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4 print:hidden">
                <div>
                    <h2 className="text-2xl font-bold text-[#485550]">Billing & Subscriptions</h2>
                    <p className="text-[#6B7C6F]">Manage pricing tiers, invoices, and tenant subscriptions.</p>
                </div>
                <div className="flex gap-2">
                    <Button variant="outline" className="btn-morph bg-white">
                        <Download className="w-4 h-4 mr-2" />
                        Export Report
                    </Button>
                    <Button className="btn-morph-primary" onClick={() => setSelectedTab('invoices')}>
                        <Plus className="w-4 h-4 mr-2" />
                        Create Invoice
                    </Button>
                </div>
            </div>

            <Tabs defaultValue="overview" value={selectedTab} onValueChange={setSelectedTab} className="space-y-6 print:hidden">
                <TabsList className="bg-[#F4F6F0] p-1 rounded-xl border border-transparent">
                    <TabsTrigger value="overview" className="rounded-lg data-[state=active]:bg-white data-[state=active]:shadow-sm">Overview</TabsTrigger>
                    <TabsTrigger value="plans" className="rounded-lg data-[state=active]:bg-white data-[state=active]:shadow-sm">Pricing Engine</TabsTrigger>
                    <TabsTrigger value="subscriptions" className="rounded-lg data-[state=active]:bg-white data-[state=active]:shadow-sm">Subscriptions</TabsTrigger>
                    <TabsTrigger value="invoices" className="rounded-lg data-[state=active]:bg-white data-[state=active]:shadow-sm">Invoices</TabsTrigger>
                </TabsList>

                {/* OVERVIEW TAB */}
                <TabsContent value="overview" className="space-y-6 animate-in slide-in-from-bottom-2">
                    {/* ENHANCED REVENUE CARDS */}
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                        {/* High Visibility MRR Card */}
                        <div className="morph-card p-0 overflow-hidden border-0 shadow-lg relative group">
                            <div className="absolute inset-0 bg-gradient-to-br from-[#485550] to-[#2A302D]"></div>
                            {/* Decorative patterns */}
                            <div className="absolute top-0 right-0 w-32 h-32 bg-[#C0EB6A] rounded-full blur-[60px] opacity-10 group-hover:opacity-20 transition-opacity"></div>

                            <div className="relative p-6 text-white min-h-[160px] flex flex-col justify-between">
                                <div className="flex justify-between items-start">
                                    <div className="p-3 bg-white/10 backdrop-blur-md rounded-2xl border border-white/10">
                                        <DollarSign className="w-6 h-6 text-[#C0EB6A]" />
                                    </div>
                                    <div className="flex flex-col items-end">
                                        <span className="flex items-center text-[#C0EB6A] text-sm font-bold bg-[#C0EB6A]/20 px-2 py-1 rounded-lg backdrop-blur-md border border-[#C0EB6A]/20">
                                            <ArrowUpRight className="w-3 h-3 mr-1" />
                                            12.5%
                                        </span>
                                        <span className="text-xs text-gray-300 mt-1">vs last month</span>
                                    </div>
                                </div>
                                <div>
                                    <h3 className="text-4xl font-black mb-1 tracking-tight">$42,500<span className="text-lg font-normal text-gray-400">.00</span></h3>
                                    <p className="text-gray-300 font-medium">Monthly Recurring Revenue</p>
                                </div>
                            </div>
                        </div>

                        <div className="morph-card p-6 flex flex-col justify-between">
                            <div className="flex justify-between items-start mb-4">
                                <div className="p-3 bg-blue-50 text-blue-600 rounded-xl">
                                    <Users className="w-6 h-6" />
                                </div>
                                <span className="flex items-center text-green-600 text-sm font-bold bg-green-50 px-2 py-1 rounded-lg">
                                    <ArrowUpRight className="w-3 h-3 mr-1" />
                                    8.2%
                                </span>
                            </div>
                            <div>
                                <h3 className="text-3xl font-bold text-[#485550]">1,240</h3>
                                <p className="text-[#6B7C6F] font-medium">Total Paying Students</p>
                            </div>
                        </div>

                        <div className="morph-card p-6 flex flex-col justify-between">
                            <div className="flex justify-between items-start mb-4">
                                <div className="p-3 bg-amber-50 text-amber-600 rounded-xl">
                                    <FileText className="w-6 h-6" />
                                </div>
                                <span className="flex items-center text-red-500 text-sm font-bold bg-red-50 px-2 py-1 rounded-lg">
                                    <ArrowDownRight className="w-3 h-3 mr-1" />
                                    2.1%
                                </span>
                            </div>
                            <div>
                                <h3 className="text-3xl font-bold text-[#485550]">$1,200</h3>
                                <p className="text-[#6B7C6F] font-medium">Outstanding Invoices</p>
                            </div>
                        </div>
                    </div>

                    {/* Revenue Chart */}
                    <div className="morph-card p-6">
                        <div className="flex items-center justify-between mb-8">
                            <h3 className="font-bold text-[#485550] flex items-center gap-2 text-lg">
                                <BarChart3 className="w-5 h-5 text-[#C0EB6A]" />
                                Revenue Trends
                            </h3>
                            <Select defaultValue="6m">
                                <SelectTrigger className="w-[140px] bg-[#F4F6F0] border-transparent rounded-xl">
                                    <SelectValue placeholder="Period" />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="1m">Last Month</SelectItem>
                                    <SelectItem value="6m">Last 6 Months</SelectItem>
                                    <SelectItem value="1y">Last Year</SelectItem>
                                </SelectContent>
                            </Select>
                        </div>
                        <div className="h-[300px] flex items-end justify-between gap-4 px-2">
                            {/* Enhanced Chart Bars */}
                            {[35, 42, 38, 55, 62, 70, 68, 75, 82, 90, 88, 95].map((h, i) => (
                                <div key={i} className="flex-1 flex flex-col justify-end group h-full relative">
                                    <div
                                        className="w-full bg-[#D1DBC1]/50 group-hover:bg-[#C0EB6A] transition-all duration-300 rounded-t-xl relative"
                                        style={{ height: `${h}%` }}
                                    >
                                        <div className="absolute -top-10 left-1/2 -translate-x-1/2 bg-[#485550] text-white text-xs font-bold py-1.5 px-3 rounded-lg opacity-0 group-hover:opacity-100 transition-opacity shadow-lg whitespace-nowrap z-10">
                                            ${(h * 500).toLocaleString()}
                                            <div className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-[#485550]"></div>
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                        <div className="flex justify-between mt-4 text-xs font-bold text-[#6B7C6F] uppercase tracking-wide border-t border-[#F4F6F0] pt-4">
                            <span>Jan</span><span>Feb</span><span>Mar</span><span>Apr</span><span>May</span><span>Jun</span>
                            <span>Jul</span><span>Aug</span><span>Sep</span><span>Oct</span><span>Nov</span><span>Dec</span>
                        </div>
                    </div>
                </TabsContent>

                {/* PRICING ENGINE TAB */}
                <TabsContent value="plans" className="space-y-8 animate-in slide-in-from-bottom-2">
                    <div className="morph-card p-6 bg-[#F4F6F0]/50 border-dashed border-[#C0EB6A]">
                        <div className="flex flex-col md:flex-row items-center justify-between gap-6">
                            <div className="flex gap-2 p-1 bg-white rounded-xl shadow-sm">
                                <Button
                                    variant="ghost"
                                    onClick={() => setPricingModel('students')}
                                    className={`rounded-lg transition-all ${pricingModel === 'students' ? 'bg-[#485550] text-white shadow-md' : 'text-[#6B7C6F] hover:bg-[#F4F6F0]'}`}
                                >
                                    <Users className="w-4 h-4 mr-2" />
                                    Student Count Based
                                </Button>
                                <Button
                                    variant="ghost"
                                    onClick={() => setPricingModel('flat')}
                                    className={`rounded-lg transition-all ${pricingModel === 'flat' ? 'bg-[#485550] text-white shadow-md' : 'text-[#6B7C6F] hover:bg-[#F4F6F0]'}`}
                                >
                                    <Briefcase className="w-4 h-4 mr-2" />
                                    Flat Rate
                                </Button>
                            </div>

                            <div className="flex items-center gap-3 bg-white px-4 py-2 rounded-xl shadow-sm">
                                <span className={`text-sm font-bold ${billingCycle === 'monthly' ? 'text-[#485550]' : 'text-[#6B7C6F]'}`}>Monthly</span>
                                <Switch
                                    checked={billingCycle === 'yearly'}
                                    onCheckedChange={(c) => setBillingCycle(c ? 'yearly' : 'monthly')}
                                    className="data-[state=checked]:bg-[#C0EB6A]"
                                />
                                <span className={`text-sm font-bold ${billingCycle === 'yearly' ? 'text-[#485550]' : 'text-[#6B7C6F]'}`}>Yearly</span>
                                {billingCycle === 'yearly' && (
                                    <Badge className="bg-[#C0EB6A] text-[#485550] hover:bg-[#C0EB6A] ml-2">Save 20%</Badge>
                                )}
                            </div>
                        </div>
                    </div>

                    {pricingModel === 'students' && (
                        <div className="space-y-8">
                            {studentRanges.map((range) => (
                                <div key={range.id} className="space-y-4">
                                    <div className="flex items-center gap-4">
                                        <div className="flex items-baseline gap-2 bg-white px-4 py-2 rounded-xl shadow-sm border border-[#F4F6F0]">
                                            <Users className="w-5 h-5 text-[#C0EB6A]" />
                                            <span className="font-bold text-[#485550] text-lg">{range.min}</span>
                                            <span className="text-[#6B7C6F]">-</span>
                                            <span className="font-bold text-[#485550] text-lg">{range.max || '∞'}</span>
                                            <span className="text-xs text-[#6B7C6F] ml-1 uppercase font-bold">Students</span>
                                        </div>
                                        <Button variant="ghost" size="icon" className="text-[#6B7C6F] hover:text-[#485550]">
                                            <Edit2 className="w-4 h-4" />
                                        </Button>
                                    </div>

                                    <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                                        {range.tiers.map((tier) => (
                                            <div key={tier.id} className={`morph-card p-6 relative group transition-all duration-300 ${tier.isPopular ? 'border-[#C0EB6A] shadow-md' : 'hover:border-[#D1DBC1]'}`}>
                                                {tier.isPopular && (
                                                    <div className="absolute -top-3 left-1/2 -translate-x-1/2 bg-[#C0EB6A] text-[#485550] text-xs font-bold px-3 py-1 rounded-full shadow-sm">
                                                        MOST POPULAR
                                                    </div>
                                                )}
                                                <div className="flex justify-between items-start mb-4">
                                                    <div>
                                                        <h4 className="font-bold text-[#485550] text-lg">{tier.name}</h4>
                                                        <p className="text-xs text-[#6B7C6F] mt-1">{tier.name === 'Basic' ? 'Essential Features' : tier.name === 'Pro' ? 'Growth Toolkit' : 'Full Power'}</p>
                                                    </div>
                                                    <Button variant="ghost" size="icon" className="h-8 w-8 -mr-2 text-[#6B7C6F] hover:bg-[#F4F6F0]">
                                                        <MoreVertical className="w-4 h-4" />
                                                    </Button>
                                                </div>

                                                <div className="mb-6">
                                                    <div className="flex items-baseline gap-1">
                                                        <span className="text-3xl font-bold text-[#485550]">${calculatePrice(tier.price)}</span>
                                                        <span className="text-sm text-[#6B7C6F] font-medium">/{billingCycle === 'yearly' ? 'yr' : 'mo'}</span>
                                                    </div>
                                                    {billingCycle === 'yearly' && (
                                                        <p className="text-xs text-[#C0EB6A] font-bold mt-1 line-through opacity-70">
                                                            ${tier.price * 12}/yr
                                                        </p>
                                                    )}
                                                </div>

                                                <div className="space-y-3 mb-6">
                                                    {tier.features.map((feature, idx) => (
                                                        <div key={idx} className="flex items-start gap-2 text-sm text-[#485550]">
                                                            <div className="mt-0.5 w-4 h-4 rounded-full bg-[#F4F6F0] flex items-center justify-center shrink-0">
                                                                <Check className="w-2.5 h-2.5 text-[#C0EB6A]" />
                                                            </div>
                                                            {feature}
                                                        </div>
                                                    ))}
                                                </div>

                                                <Button className={`w-full ${tier.isPopular ? 'btn-morph-primary' : 'bg-[#F4F6F0] text-[#485550] hover:bg-[#E8EDE0]'}`}>
                                                    Edit Tier
                                                </Button>
                                            </div>
                                        ))}
                                        {/* Add Tier Card */}
                                        <div className="border-2 border-dashed border-[#D1DBC1] rounded-[2rem] flex flex-col items-center justify-center p-6 cursor-pointer hover:bg-[#F4F6F0]/50 hover:border-[#C0EB6A] transition-colors min-h-[300px]">
                                            <div className="w-12 h-12 rounded-full bg-[#F4F6F0] flex items-center justify-center mb-3">
                                                <Plus className="w-6 h-6 text-[#6B7C6F]" />
                                            </div>
                                            <span className="font-bold text-[#6B7C6F]">Add Pricing Tier</span>
                                        </div>
                                    </div>
                                </div>
                            ))}
                            <Button variant="outline" className="w-full border-dashed border-[#D1DBC1] py-8 text-[#6B7C6F] hover:text-[#485550] hover:border-[#C0EB6A] hover:bg-[#F4F6F0]/30">
                                <Plus className="w-5 h-5 mr-2" /> Add New Student Range Bucket
                            </Button>
                        </div>
                    )}

                    {pricingModel === 'flat' && (
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                            {flatTiers.map((tier) => (
                                <div key={tier.id} className="morph-card p-6 border-l-4 border-l-[#C0EB6A]">
                                    <h4 className="font-bold text-[#485550] text-xl mb-2">{tier.name}</h4>
                                    <div className="text-3xl font-bold text-[#485550] mb-6">
                                        ${calculatePrice(tier.price)} <span className="text-sm text-[#6B7C6F] font-normal">/{billingCycle === 'yearly' ? 'yr' : 'mo'}</span>
                                    </div>
                                    <div className="space-y-3 mb-8">
                                        {tier.features.map(f => (
                                            <div key={f} className="flex items-center gap-2 text-sm text-[#6B7C6F]">
                                                <Check className="w-4 h-4 text-[#C0EB6A]" /> {f}
                                            </div>
                                        ))}
                                    </div>
                                    <Button className="w-full btn-morph-primary">Edit Plan</Button>
                                </div>
                            ))}
                            <div className="border-2 border-dashed border-[#D1DBC1] rounded-[2rem] flex flex-col items-center justify-center p-6 cursor-pointer hover:bg-[#F4F6F0]/50 hover:border-[#C0EB6A] transition-colors">
                                <Plus className="w-8 h-8 text-[#D1DBC1] mb-2" />
                                <span className="font-bold text-[#6B7C6F]">Add Flat Plan</span>
                            </div>
                        </div>
                    )}

                    <div className="flex justify-end pt-8 border-t border-[#F4F6F0]">
                        <Button size="lg" className="btn-morph-primary shadow-xl" onClick={handleSavePricing}>
                            <Save className="w-5 h-5 mr-2" /> Save Pricing Configuration
                        </Button>
                    </div>
                </TabsContent>

                {/* SUBSCRIPTIONS TAB (Simplified for brevity as focus is on Billing Engine) */}
                <TabsContent value="subscriptions">
                    <div className="morph-card p-12 text-center text-[#6B7C6F]">
                        <Users className="w-12 h-12 mx-auto mb-4 opacity-50" />
                        <h3 className="text-lg font-bold">Subscription Management</h3>
                        <p>Tenant list and active subscription tracking.</p>
                    </div>
                </TabsContent>

                {/* INVOICES TAB */}
                <TabsContent value="invoices" className="space-y-6 animate-in slide-in-from-bottom-2">
                    <div className="morph-card overflow-hidden">
                        <Table>
                            <TableHeader className="bg-[#F4F6F0]">
                                <TableRow>
                                    <TableHead className="text-[#485550] font-bold">Invoice ID</TableHead>
                                    <TableHead className="text-[#485550] font-bold">Tenant</TableHead>
                                    <TableHead className="text-[#485550] font-bold">Date Issued</TableHead>
                                    <TableHead className="text-[#485550] font-bold">Amount</TableHead>
                                    <TableHead className="text-[#485550] font-bold">Status</TableHead>
                                    <TableHead className="text-right text-[#485550] font-bold">Action</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {MOCK_INVOICES.map((inv) => (
                                    <TableRow key={inv.id} className="hover:bg-[#F4F6F0]/50 transition-colors">
                                        <TableCell className="font-mono text-[#6B7C6F]">{inv.id}</TableCell>
                                        <TableCell className="font-bold text-[#485550]">{inv.tenant}</TableCell>
                                        <TableCell>{new Date(inv.date).toLocaleDateString()}</TableCell>
                                        <TableCell className="font-bold">${inv.amount.toFixed(2)}</TableCell>
                                        <TableCell>
                                            <Badge className={inv.status === 'PAID' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}>
                                                {inv.status}
                                            </Badge>
                                        </TableCell>
                                        <TableCell className="text-right">
                                            <Dialog>
                                                <DialogTrigger asChild>
                                                    <Button
                                                        variant="ghost"
                                                        size="sm"
                                                        className="text-[#C0EB6A] hover:bg-[#C0EB6A]/10 hover:text-[#485550]"
                                                        onClick={() => setSelectedInvoice(inv)}
                                                    >
                                                        <FileText className="w-4 h-4 mr-2" />
                                                        View PDF
                                                    </Button>
                                                </DialogTrigger>
                                                <DialogContent className="max-w-3xl p-0 overflow-hidden bg-white gap-0 rounded-xl">
                                                    {/* PDF PREVIEW HEADER */}
                                                    <div className="bg-[#485550] p-4 flex justify-between items-center text-white">
                                                        <DialogTitle className="font-bold flex items-center gap-2 text-white text-base m-0">
                                                            <FileText className="w-4 h-4" /> Invoice Preview
                                                        </DialogTitle>
                                                        <div className="flex gap-2">
                                                            <Button size="sm" variant="secondary" className="h-8" onClick={handlePrintInvoice}>
                                                                <Printer className="w-3 h-3 mr-2" /> Print
                                                            </Button>
                                                            <Button size="sm" variant="secondary" className="h-8">
                                                                <Download className="w-3 h-3 mr-2" /> Download
                                                            </Button>
                                                        </div>
                                                    </div>

                                                    {/* INVOICE DOCUMENT */}
                                                    {selectedInvoice && (
                                                        <div className="p-12 print:p-0" id="invoice-content">
                                                            <div className="flex justify-between items-start mb-12">
                                                                <div>
                                                                    <div className="text-2xl font-bold text-[#485550] mb-1">UniVarse</div>
                                                                    <div className="text-sm text-gray-500">Platform Billing</div>
                                                                </div>
                                                                <div className="text-right">
                                                                    <div className="text-4xl font-light text-[#C0EB6A] mb-2">INVOICE</div>
                                                                    <div className="text-sm font-bold text-[#485550]">{selectedInvoice.id}</div>
                                                                    <div className="text-sm text-gray-500">{new Date(selectedInvoice.date).toLocaleDateString()}</div>
                                                                </div>
                                                            </div>

                                                            <div className="grid grid-cols-2 gap-12 mb-12">
                                                                <div>
                                                                    <h4 className="text-xs font-bold text-gray-400 uppercase mb-2">Bill To</h4>
                                                                    <p className="font-bold text-[#485550] text-lg">{selectedInvoice.tenant}</p>
                                                                    <p className="text-gray-500 text-sm">123 Education Lane</p>
                                                                    <p className="text-gray-500 text-sm">Tech City, TC 90210</p>
                                                                </div>
                                                                <div className="text-right">
                                                                    <h4 className="text-xs font-bold text-gray-400 uppercase mb-2">Payment Details</h4>
                                                                    <p className="text-[#485550] font-medium">Card ending in •••• 4242</p>
                                                                    <p className="text-gray-500 text-sm">{selectedInvoice.status === 'PAID' ? 'Paid on Jan 30, 2026' : 'Due Immediately'}</p>
                                                                </div>
                                                            </div>

                                                            <Table className="mb-8">
                                                                <TableHeader>
                                                                    <TableRow>
                                                                        <TableHead>Description</TableHead>
                                                                        <TableHead className="text-right">Qty</TableHead>
                                                                        <TableHead className="text-right">Price</TableHead>
                                                                        <TableHead className="text-right">Total</TableHead>
                                                                    </TableRow>
                                                                </TableHeader>
                                                                <TableBody>
                                                                    {selectedInvoice.items.map((item, i) => (
                                                                        <TableRow key={i}>
                                                                            <TableCell className="font-medium text-[#485550]">{item.desc}</TableCell>
                                                                            <TableCell className="text-right">{item.qty}</TableCell>
                                                                            <TableCell className="text-right">${item.price.toFixed(2)}</TableCell>
                                                                            <TableCell className="text-right font-bold">${(item.price * item.qty).toFixed(2)}</TableCell>
                                                                        </TableRow>
                                                                    ))}
                                                                </TableBody>
                                                            </Table>

                                                            <div className="flex justify-end">
                                                                <div className="w-64 space-y-3">
                                                                    <div className="flex justify-between text-sm text-gray-500">
                                                                        <span>Subtotal</span>
                                                                        <span>${selectedInvoice.amount.toFixed(2)}</span>
                                                                    </div>
                                                                    <div className="flex justify-between text-sm text-gray-500">
                                                                        <span>Tax (0%)</span>
                                                                        <span>$0.00</span>
                                                                    </div>
                                                                    <div className="flex justify-between text-xl font-bold text-[#485550] pt-3 border-t border-gray-100">
                                                                        <span>Total</span>
                                                                        <span>${selectedInvoice.amount.toFixed(2)}</span>
                                                                    </div>
                                                                </div>
                                                            </div>
                                                        </div>
                                                    )}
                                                </DialogContent>
                                            </Dialog>
                                        </TableCell>
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    </div>
                </TabsContent>
            </Tabs>

            {/* PRINT STYLES */}
            <style jsx global>{`
                @media print {
                    body * {
                        visibility: hidden;
                    }
                    .print\\:hidden {
                        display: none !important;
                    }
                    div[role="dialog"] {
                        visibility: visible;
                        position: absolute;
                        left: 0;
                        top: 0;
                        width: 100%;
                        height: 100%;
                        z-index: 9999;
                        background: white;
                    }
                    div[role="dialog"] * {
                        visibility: visible;
                    }
                }
            `}</style>
        </div>
    );
}
