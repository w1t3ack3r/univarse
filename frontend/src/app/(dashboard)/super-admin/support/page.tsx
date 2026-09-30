'use client';

import { useState, useEffect } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import {
    Ticket,
    Search,
    RefreshCw,
    Loader2,
    MessageSquare,
    Clock,
    User,
    Building2,
    Send,
    AlertCircle,
    CheckCircle2,
    XCircle,
    Inbox,
    Filter
} from 'lucide-react';
import { toast } from 'sonner';
import { MorphButton } from '@/components/morph/MorphButton';

interface TicketData {
    id: string;
    ticketNumber: string;
    subject: string;
    description: string;
    category: string;
    priority: string;
    status: string;
    submitterName: string;
    submitterEmail: string;
    institutionId: string;
    assignedToName?: string;
    createdAt: string;
    updatedAt: string;
    _count?: { responses: number };
    responses?: any[];
}

const priorityColors: Record<string, string> = {
    LOW: 'bg-gray-100 text-gray-700',
    MEDIUM: 'bg-blue-100 text-blue-700',
    HIGH: 'bg-orange-100 text-orange-700',
    CRITICAL: 'bg-red-100 text-red-700',
};

const statusColors: Record<string, string> = {
    OPEN: 'bg-green-100 text-green-700',
    IN_PROGRESS: 'bg-blue-100 text-blue-700',
    WAITING: 'bg-amber-100 text-amber-700',
    RESOLVED: 'bg-gray-100 text-gray-700',
    CLOSED: 'bg-gray-200 text-gray-500',
};

export default function SupportPage() {
    const [tickets, setTickets] = useState<TicketData[]>([]);
    const [stats, setStats] = useState({ total: 0, open: 0, inProgress: 0, resolved: 0 });
    const [isLoading, setIsLoading] = useState(true);
    const [search, setSearch] = useState('');
    const [statusFilter, setStatusFilter] = useState('ALL');

    // Ticket detail
    const [selectedTicket, setSelectedTicket] = useState<TicketData | null>(null);
    const [showDetail, setShowDetail] = useState(false);
    const [newResponse, setNewResponse] = useState('');
    const [isSending, setIsSending] = useState(false);

    useEffect(() => {
        fetchTickets();
    }, [statusFilter]);

    const fetchTickets = async () => {
        setIsLoading(true);
        // MOCK DATA FETCH
        try {
            await new Promise(resolve => setTimeout(resolve, 800));

            const mockTickets: TicketData[] = [
                {
                    id: 't-1',
                    ticketNumber: 'T-1001',
                    subject: 'Database connection issue',
                    description: 'We are unable to connect to the provided PostgreSQL instance.',
                    category: 'TECHNICAL',
                    priority: 'HIGH',
                    status: 'OPEN',
                    submitterName: 'Alice Admin',
                    submitterEmail: 'alice@univ.edu',
                    institutionId: '1',
                    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24).toISOString(),
                    updatedAt: new Date(Date.now() - 1000 * 60 * 60 * 24).toISOString(),
                    _count: { responses: 0 }
                },
                {
                    id: 't-2',
                    ticketNumber: 'T-1002',
                    subject: 'Request for backup restoration',
                    description: 'Please restore the backup from yesterday.',
                    category: 'DATA_RECOVERY',
                    priority: 'CRITICAL',
                    status: 'IN_PROGRESS',
                    submitterName: 'Bob Tech',
                    submitterEmail: 'bob@cyber.edu',
                    institutionId: '2',
                    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 48).toISOString(),
                    updatedAt: new Date(Date.now() - 1000 * 60 * 60 * 5).toISOString(),
                    _count: { responses: 2 }
                },
                {
                    id: 't-3',
                    ticketNumber: 'T-1003',
                    subject: 'General inquiry about limits',
                    description: 'What are the storage limits for the basic plan?',
                    category: 'BILLING',
                    priority: 'LOW',
                    status: 'RESOLVED',
                    submitterName: 'Charlie Finance',
                    submitterEmail: 'charlie@nextgen.edu',
                    institutionId: '3',
                    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 72).toISOString(),
                    updatedAt: new Date(Date.now() - 1000 * 60 * 60 * 24).toISOString(),
                    _count: { responses: 1 }
                }
            ];

            const filtered = statusFilter === 'ALL'
                ? mockTickets
                : mockTickets.filter(t => t.status === statusFilter);

            setTickets(filtered);
            setStats({ total: 3, open: 1, inProgress: 1, resolved: 1 });
        } catch (error: any) {
            toast.error('Failed to load tickets (Mock Mode)');
        } finally {
            setIsLoading(false);
        }
    };

    const openTicketDetail = async (ticket: TicketData) => {
        // MOCK DETAIL FETCH
        try {
            await new Promise(resolve => setTimeout(resolve, 500));
            // Add mock responses if not present
            const detailedTicket = {
                ...ticket,
                responses: ticket.id === 't-2' ? [
                    { id: 'r1', message: 'We are looking into this.', authorName: 'Super Admin', authorType: 'SUPER_ADMIN', createdAt: new Date(Date.now() - 1000 * 60 * 60 * 4).toISOString() },
                    { id: 'r2', message: 'Thanks for the update.', authorName: 'Bob Tech', authorType: 'INSTITUTION_ADMIN', createdAt: new Date(Date.now() - 1000 * 60 * 60 * 3).toISOString() }
                ] : []
            };
            setSelectedTicket(detailedTicket);
            setShowDetail(true);
        } catch (error: any) {
            toast.error('Failed to load ticket details');
        }
    };

    const sendResponse = async () => {
        if (!newResponse.trim() || !selectedTicket) return;

        setIsSending(true);
        // MOCK RESPONSE
        try {
            await new Promise(resolve => setTimeout(resolve, 1000));

            const newMsg = {
                id: `mock-r-${Date.now()}`,
                message: newResponse,
                authorName: 'Super Admin', // You
                authorType: 'SUPER_ADMIN',
                createdAt: new Date().toISOString()
            };

            const updatedTicket = {
                ...selectedTicket,
                responses: [...(selectedTicket.responses || []), newMsg],
                _count: { responses: (selectedTicket._count?.responses || 0) + 1 }
            };

            setSelectedTicket(updatedTicket);

            // Update in list
            setTickets(tickets.map(t => t.id === selectedTicket.id ? { ...t, _count: updatedTicket._count } : t));

            toast.success('Response sent (Mock Mode)');
            setNewResponse('');
        } catch (error: any) {
            toast.error('Failed to send response');
        } finally {
            setIsSending(false);
        }
    };

    const updateStatus = async (status: string) => {
        if (!selectedTicket) return;
        // MOCK STATUS UPDATE
        try {
            await new Promise(resolve => setTimeout(resolve, 800));

            const updatedTicket = { ...selectedTicket, status };
            setSelectedTicket(updatedTicket);

            // Update in list
            setTickets(tickets.map(t => t.id === selectedTicket.id ? { ...t, status } : t));

            toast.success(`Status updated to ${status} (Mock Mode)`);
        } catch (error: any) {
            toast.error('Failed to update status');
        }
    };

    if (isLoading) {
        return (
            <div className="flex items-center justify-center h-[calc(100vh-200px)]">
                <div className="flex flex-col items-center gap-4">
                    <Loader2 className="w-10 h-10 text-[#C0EB6A] animate-spin" />
                    <p className="text-[#6B7C6F] animate-pulse">Loading helpdesk...</p>
                </div>
            </div>
        );
    }

    return (
        <div className="space-y-6">
            {/* Header */}
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div>
                    <h2 className="text-2xl font-bold text-[#485550]">Support Center</h2>
                    <p className="text-[#6B7C6F]">Manage support requests and technical issues</p>
                </div>
                <Button variant="outline" onClick={fetchTickets} className="btn-morph bg-white">
                    <RefreshCw className="w-4 h-4 mr-2" />
                    Refresh
                </Button>
            </div>

            {/* Stats */}
            <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
                <div className="morph-card p-6 flex items-center justify-between">
                    <div>
                        <p className="text-[#6B7C6F] font-medium text-sm">Total Tickets</p>
                        <p className="text-3xl font-bold text-[#485550] mt-1">{stats.total}</p>
                    </div>
                    <div className="w-12 h-12 rounded-2xl bg-gray-100 flex items-center justify-center text-gray-500 shadow-sm">
                        <Inbox className="w-6 h-6" />
                    </div>
                </div>

                <div
                    className="morph-card p-6 flex items-center justify-between cursor-pointer hover:bg-[#F4F6F0] transition-colors border-l-4 border-l-green-500"
                    onClick={() => setStatusFilter('OPEN')}
                >
                    <div>
                        <p className="text-[#6B7C6F] font-medium text-sm">Open</p>
                        <p className="text-3xl font-bold text-green-600 mt-1">{stats.open}</p>
                    </div>
                    <div className="w-12 h-12 rounded-2xl bg-green-100 flex items-center justify-center text-green-600 shadow-sm">
                        <AlertCircle className="w-6 h-6" />
                    </div>
                </div>

                <div
                    className="morph-card p-6 flex items-center justify-between cursor-pointer hover:bg-[#F4F6F0] transition-colors border-l-4 border-l-blue-500"
                    onClick={() => setStatusFilter('IN_PROGRESS')}
                >
                    <div>
                        <p className="text-[#6B7C6F] font-medium text-sm">In Progress</p>
                        <p className="text-3xl font-bold text-blue-600 mt-1">{stats.inProgress}</p>
                    </div>
                    <div className="w-12 h-12 rounded-2xl bg-blue-100 flex items-center justify-center text-blue-600 shadow-sm">
                        <Clock className="w-6 h-6" />
                    </div>
                </div>

                <div
                    className="morph-card p-6 flex items-center justify-between cursor-pointer hover:bg-[#F4F6F0] transition-colors border-l-4 border-l-gray-500"
                    onClick={() => setStatusFilter('RESOLVED')}
                >
                    <div>
                        <p className="text-[#6B7C6F] font-medium text-sm">Resolved</p>
                        <p className="text-3xl font-bold text-[#485550] mt-1">{stats.resolved}</p>
                    </div>
                    <div className="w-12 h-12 rounded-2xl bg-gray-100 flex items-center justify-center text-gray-500 shadow-sm">
                        <CheckCircle2 className="w-6 h-6" />
                    </div>
                </div>
            </div>

            {/* Filters */}
            <div className="morph-card p-4">
                <div className="flex flex-col md:flex-row gap-4">
                    <div className="flex-1 relative">
                        <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-[#6B7C6F] w-4 h-4" />
                        <Input
                            placeholder="Search tickets by ID, subject, or submitter..."
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && fetchTickets()}
                            className="input-morph pl-10 bg-white"
                        />
                    </div>
                    <Select value={statusFilter} onValueChange={setStatusFilter}>
                        <SelectTrigger className="w-[200px] bg-white border-transparent shadow-sm rounded-xl h-10 text-[#485550]">
                            <Filter className="w-4 h-4 mr-2 text-[#C0EB6A]" />
                            <SelectValue placeholder="All Statuses" />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="ALL">All Statuses</SelectItem>
                            <SelectItem value="OPEN">Open</SelectItem>
                            <SelectItem value="IN_PROGRESS">In Progress</SelectItem>
                            <SelectItem value="WAITING">Waiting</SelectItem>
                            <SelectItem value="RESOLVED">Resolved</SelectItem>
                            <SelectItem value="CLOSED">Closed</SelectItem>
                        </SelectContent>
                    </Select>
                </div>
            </div>

            {/* Ticket List */}
            <div className="space-y-4">
                {tickets.length === 0 ? (
                    <div className="morph-card py-16 text-center">
                        <div className="w-16 h-16 bg-[#F4F6F0] rounded-full flex items-center justify-center mx-auto mb-4">
                            <Ticket className="w-8 h-8 text-[#D1DBC1]" />
                        </div>
                        <h3 className="text-lg font-bold text-[#485550]">No tickets found</h3>
                        <p className="text-[#6B7C6F]">Your support queue is empty</p>
                    </div>
                ) : (
                    <div className="grid gap-4">
                        {tickets.map((ticket) => (
                            <div
                                key={ticket.id}
                                className="group p-5 rounded-2xl bg-white border border-[#F4F6F0] hover:border-[#D1DBC1] hover:shadow-md cursor-pointer transition-all duration-300"
                                onClick={() => openTicketDetail(ticket)}
                            >
                                <div className="flex flex-col md:flex-row md:items-start justify-between gap-4">
                                    <div className="flex-1">
                                        <div className="flex items-center flex-wrap gap-2 mb-2">
                                            <code className="text-xs font-bold text-[#6B7C6F] bg-[#F4F6F0] px-2 py-0.5 rounded">{ticket.ticketNumber}</code>
                                            <Badge className={`border-0 ${priorityColors[ticket.priority]}`}>{ticket.priority}</Badge>
                                            <Badge className={`border-0 ${statusColors[ticket.status]}`}>{ticket.status.replace('_', ' ')}</Badge>
                                        </div>
                                        <h3 className="font-bold text-[#485550] text-lg group-hover:text-[#2A302D]">{ticket.subject}</h3>
                                        <p className="text-sm text-[#6B7C6F] mt-1 flex items-center gap-1.5">
                                            <User className="w-3 h-3" />
                                            {ticket.submitterName}
                                            <span className="opacity-50">•</span>
                                            {new Date(ticket.createdAt).toLocaleString()}
                                        </p>
                                    </div>
                                    <div className="flex items-center gap-2 text-[#6B7C6F] bg-[#F4F6F0] px-3 py-1.5 rounded-xl self-start">
                                        <MessageSquare className="w-4 h-4" />
                                        <span className="text-sm font-semibold">{ticket._count?.responses || 0}</span>
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>

            {/* Ticket Detail Dialog */}
            <Dialog open={showDetail} onOpenChange={setShowDetail}>
                <DialogContent className="sm:max-w-5xl h-[85vh] bg-[#F4F6F0] border-white shadow-2xl rounded-[2rem] p-0 overflow-hidden flex flex-col">
                    {selectedTicket && (
                        <div className="grid grid-cols-1 md:grid-cols-12 h-full">
                            {/* Left Sidebar - Metadata & Actions */}
                            <div className="md:col-span-4 bg-[#E8EDE0]/50 border-r border-[#D1DBC1]/50 p-6 flex flex-col gap-6 overflow-y-auto">
                                <div>
                                    <div className="flex items-center gap-2 mb-3">
                                        <code className="text-xs font-bold text-[#6B7C6F] bg-white px-2 py-0.5 rounded border border-[#D1DBC1]">{selectedTicket.ticketNumber}</code>
                                        <Badge className={`border-0 ${priorityColors[selectedTicket.priority]}`}>{selectedTicket.priority}</Badge>
                                        <Badge className={`border-0 ${statusColors[selectedTicket.status]}`}>{selectedTicket.status.replace('_', ' ')}</Badge>
                                    </div>
                                    <DialogTitle className="text-xl font-bold text-[#485550]">
                                        {selectedTicket.subject}
                                    </DialogTitle>
                                    <p className="text-sm text-[#6B7C6F] mt-1 flex items-center gap-2">
                                        <Building2 className="w-3 h-3" />
                                        {selectedTicket.category}
                                    </p>
                                </div>

                                {/* Submitter Card */}
                                <div className="p-4 bg-white rounded-2xl shadow-sm border border-[#F4F6F0]">
                                    <p className="text-xs font-bold text-[#6B7C6F] uppercase mb-3 tracking-wider">Submitted By</p>
                                    <div className="flex items-center gap-3">
                                        <div className="w-10 h-10 rounded-full bg-[#C0EB6A] flex items-center justify-center font-bold text-[#485550] shrink-0">
                                            {selectedTicket.submitterName.charAt(0)}
                                        </div>
                                        <div className="overflow-hidden">
                                            <p className="font-bold text-[#485550] truncate">{selectedTicket.submitterName}</p>
                                            <p className="text-xs text-[#6B7C6F] truncate">{selectedTicket.submitterEmail}</p>
                                        </div>
                                    </div>
                                    <div className="mt-3 pt-3 border-t border-[#F4F6F0] text-xs text-[#6B7C6F] flex items-center gap-1.5">
                                        <Clock className="w-3 h-3" />
                                        Created {new Date(selectedTicket.createdAt).toLocaleDateString()}
                                    </div>
                                </div>

                                {/* Status Actions */}
                                <div>
                                    <p className="text-xs font-bold text-[#6B7C6F] uppercase mb-3 tracking-wider">Update Status</p>
                                    <div className="grid grid-cols-2 gap-2">
                                        <Button size="sm" variant={selectedTicket.status === 'IN_PROGRESS' ? 'default' : 'outline'} onClick={() => updateStatus('IN_PROGRESS')} className={`h-9 text-xs justify-start ${selectedTicket.status === 'IN_PROGRESS' ? 'bg-blue-600 text-white hover:bg-blue-700' : 'bg-white hover:bg-[#F4F6F0]'}`}>
                                            <Loader2 className="w-3 h-3 mr-2" /> In Progress
                                        </Button>
                                        <Button size="sm" variant={selectedTicket.status === 'WAITING' ? 'default' : 'outline'} onClick={() => updateStatus('WAITING')} className={`h-9 text-xs justify-start ${selectedTicket.status === 'WAITING' ? 'bg-amber-500 text-white hover:bg-amber-600' : 'bg-white hover:bg-[#F4F6F0]'}`}>
                                            <Clock className="w-3 h-3 mr-2" /> Waiting
                                        </Button>
                                        <Button size="sm" variant={selectedTicket.status === 'RESOLVED' ? 'default' : 'outline'} onClick={() => updateStatus('RESOLVED')} className={`h-9 text-xs justify-start ${selectedTicket.status === 'RESOLVED' ? 'bg-green-600 text-white hover:bg-green-700' : 'bg-white hover:bg-[#F4F6F0]'}`}>
                                            <CheckCircle2 className="w-3 h-3 mr-2" /> Resolve
                                        </Button>
                                        <Button size="sm" variant={selectedTicket.status === 'CLOSED' ? 'default' : 'outline'} onClick={() => updateStatus('CLOSED')} className={`h-9 text-xs justify-start ${selectedTicket.status === 'CLOSED' ? 'bg-gray-600 text-white hover:bg-gray-700' : 'bg-white hover:bg-[#F4F6F0]'}`}>
                                            <XCircle className="w-3 h-3 mr-2" /> Close
                                        </Button>
                                    </div>
                                </div>
                            </div>

                            {/* Right Content - Chat & Description */}
                            <div className="md:col-span-8 flex flex-col h-full bg-[#FAFAFA] relative overflow-hidden">
                                {/* Fixed Description Section */}
                                <div className="p-6 pb-0 shrink-0 bg-[#FAFAFA] z-10">
                                    <div className="flex gap-4">
                                        <div className="w-8 h-8 rounded-full bg-white border border-[#D1DBC1] flex items-center justify-center font-bold text-[#485550] shrink-0 shadow-sm">
                                            <Ticket className="w-4 h-4 text-[#6B7C6F]" />
                                        </div>
                                        <div className="p-5 rounded-2xl rounded-tl-none bg-white border border-[#E8EDE0] shadow-sm max-w-[90%]">
                                            <div className="flex items-center gap-2 mb-2">
                                                <span className="font-bold text-[#485550] text-sm">Issue Description</span>
                                            </div>
                                            <p className="text-[#485550] whitespace-pre-wrap leading-relaxed text-sm max-h-[150px] overflow-y-auto scrollbar-thin scrollbar-thumb-gray-200">{selectedTicket.description}</p>
                                        </div>
                                    </div>
                                </div>

                                {/* Scrollable Activity Feed Area */}
                                <div className="flex-1 relative min-h-0">
                                    {/* Glassy Floating Divider */}
                                    <div className="absolute top-0 left-0 right-0 py-2 bg-[#FAFAFA]/80 backdrop-blur-sm z-20 flex items-center justify-center border-b border-transparent">
                                        <div className="absolute inset-0 flex items-center px-6">
                                            <div className="w-full border-t border-[#D1DBC1]/50"></div>
                                        </div>
                                        <span className="relative px-2 text-xs text-[#6B7C6F] uppercase tracking-widest font-bold bg-[#FAFAFA]/50 backdrop-blur-md rounded-md">Activity</span>
                                    </div>

                                    {/* Feed Content */}
                                    <div className="absolute inset-0 overflow-y-auto px-6 pb-6 pt-12 space-y-6">
                                        {/* Responses */}
                                        {selectedTicket.responses && selectedTicket.responses.map((response: any) => (
                                            <div key={response.id} className={`flex gap-3 ${response.authorType === 'SUPER_ADMIN' ? 'flex-row-reverse' : ''}`}>
                                                <div className={`w-8 h-8 rounded-full flex items-center justify-center font-bold text-xs shrink-0 shadow-sm ${response.authorType === 'SUPER_ADMIN' ? 'bg-[#485550] text-white' : 'bg-white border border-[#D1DBC1] text-[#6B7C6F]'}`}>
                                                    {response.authorName.charAt(0)}
                                                </div>
                                                <div className={`p-4 rounded-2xl max-w-[85%] shadow-sm text-sm leading-relaxed ${response.authorType === 'SUPER_ADMIN'
                                                    ? 'bg-[#485550] text-white rounded-tr-none'
                                                    : 'bg-white border border-[#E8EDE0] text-[#485550] rounded-tl-none'
                                                    }`}>
                                                    <div className={`flex items-center gap-2 text-[10px] mb-1 ${response.authorType === 'SUPER_ADMIN' ? 'text-white/60' : 'text-[#6B7C6F]'}`}>
                                                        <span className="font-bold">{response.authorName}</span>
                                                        <span>•</span>
                                                        <span>{new Date(response.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                                                    </div>
                                                    <p>{response.message}</p>
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                </div>

                                {/* Sticky Reply Box */}
                                <div className="p-4 bg-white border-t border-[#E8EDE0] shrink-0 z-10">
                                    <div className="relative">
                                        <Textarea
                                            placeholder="Type your response..."
                                            value={newResponse}
                                            onChange={(e) => setNewResponse(e.target.value)}
                                            className="min-h-[80px] pr-24 bg-[#F9FAF7] border-0 focus:ring-1 focus:ring-[#C0EB6A] resize-none rounded-xl"
                                        />
                                        <div className="absolute bottom-2 right-2">
                                            <Button
                                                size="sm"
                                                onClick={sendResponse}
                                                disabled={isSending || !newResponse.trim()}
                                                className="btn-morph-primary h-8 px-3 rounded-lg text-xs"
                                            >
                                                {isSending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3 mr-1.5" />}
                                                Send
                                            </Button>
                                        </div>
                                    </div>
                                    <p className="text-[10px] text-[#D1DBC1] mt-2 text-center">
                                        Response details will be emailed to the submitter automatically.
                                    </p>
                                </div>
                            </div>
                        </div>
                    )}
                </DialogContent>
            </Dialog>
        </div>
    );
}
