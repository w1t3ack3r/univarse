'use client';

import { useState, useEffect } from 'react';
import { CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Checkbox } from "@/components/ui/checkbox";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    DialogFooter,
} from '@/components/ui/dialog';
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from "@/components/ui/popover";
import {
    Command,
    CommandEmpty,
    CommandGroup,
    CommandInput,
    CommandItem,
    CommandList
} from "@/components/ui/command";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select"

import {
    Mail,
    Send,
    Loader2,
    Clock,
    Users,
    CheckCircle2,
    Plus,
    Megaphone,
    Search,
    UserCircle,
    BellRing,
    FileText,
    Calendar,
    Save,
    MoreVertical,
    Trash2,
    PenSquare,
    ChevronDown,
    Building2,
    Check,
    AlertTriangle,
    Info,
    AlertCircle,
    X
} from 'lucide-react';
import { toast } from 'sonner';

// --- Types ---
type PriorityLevel = 'CRITICAL' | 'URGENT' | 'NORMAL' | 'INFO';

interface Broadcast {
    id: string;
    subject: string;
    content: string;
    sentByName: string;
    sentAt: string;
    recipientCount: number;
    status: 'SENT' | 'FAILED';
    recipients?: string[]; // IDs or 'ALL'
    priority: PriorityLevel;
}

interface Template {
    id: string;
    name: string;
    subject: string;
    content: string;
    priority: PriorityLevel;
    lastUsed?: string;
}

interface ScheduledBroadcast {
    id: string;
    subject: string;
    content: string;
    scheduledFor: string;
    createdBy: string;
    recipients?: string[];
    priority: PriorityLevel;
}

interface Draft {
    id: string;
    subject: string;
    content: string;
    updatedAt: string;
    priority: PriorityLevel;
}

interface InstitutionOption {
    id: string;
    name: string;
    status: 'ACTIVE' | 'SUSPENDED' | 'PROVISIONING';
}

// --- Mock Data ---
const MOCK_INSTITUTIONS: InstitutionOption[] = [
    { id: '1', name: 'Universal Tech Institute', status: 'ACTIVE' },
    { id: '2', name: 'Cyber Academy', status: 'ACTIVE' },
    { id: '3', name: 'Future Leaders School', status: 'SUSPENDED' },
    { id: '4', name: 'Global Science College', status: 'ACTIVE' },
    { id: '5', name: 'Tech Pioneers High', status: 'PROVISIONING' },
];

const MOCK_TEMPLATES: Template[] = [
    { id: 't1', name: 'Maintenance Notice', subject: 'Scheduled Maintenance Update', content: 'We will be performing scheduled maintenance on [Date] at [Time]. Service may be interrupted.', priority: 'URGENT', lastUsed: '2024-03-01' },
    { id: 't2', name: 'Welcome Message', subject: 'Welcome to UniVarse', content: 'We are excited to have you on board. Here are some resources to get started...', priority: 'INFO', lastUsed: '2024-02-20' },
];

const MOCK_SCHEDULED: ScheduledBroadcast[] = [
    { id: 's1', subject: 'Weekend Feature Drop', content: 'New features arriving this weekend!', scheduledFor: '2026-02-05T09:00:00Z', createdBy: 'Super Admin', recipients: ['ALL'], priority: 'NORMAL' },
];

const MOCK_DRAFTS: Draft[] = [
    { id: 'd1', subject: 'Q2 Roadmap Update', content: 'Our roadmap for Q2 includes...', updatedAt: '2026-01-30T10:00:00Z', priority: 'INFO' },
];

export default function BroadcastPage() {
    const [activeTab, setActiveTab] = useState('overview');
    const [isLoading, setIsLoading] = useState(true);

    // Data handling
    const [broadcasts, setBroadcasts] = useState<Broadcast[]>([]);
    const [templates, setTemplates] = useState<Template[]>(MOCK_TEMPLATES);
    const [scheduled, setScheduled] = useState<ScheduledBroadcast[]>(MOCK_SCHEDULED);
    const [drafts, setDrafts] = useState<Draft[]>(MOCK_DRAFTS);
    const [institutions, setInstitutions] = useState<InstitutionOption[]>(MOCK_INSTITUTIONS);

    // Compose State
    const [showCompose, setShowCompose] = useState(false);
    const [composeData, setComposeData] = useState<{ id: string, subject: string, content: string, priority: PriorityLevel }>({ id: '', subject: '', content: '', priority: 'NORMAL' });
    const [selectedRecipients, setSelectedRecipients] = useState<string[]>([]); // 'ALL', 'ACTIVE', or specific IDs
    const [recipientMode, setRecipientMode] = useState<'ALL' | 'ACTIVE' | 'SELECT'>('ALL');
    const [isSending, setIsSending] = useState(false);
    const [scheduleDate, setScheduleDate] = useState('');
    const [showRecipientSelector, setShowRecipientSelector] = useState(false); // For popover

    // New Template State
    const [showCreateTemplate, setShowCreateTemplate] = useState(false);
    const [newTemplate, setNewTemplate] = useState<{ name: string, subject: string, content: string, priority: PriorityLevel }>({ name: '', subject: '', content: '', priority: 'NORMAL' });

    useEffect(() => {
        fetchBroadcasts();
    }, []);

    const fetchBroadcasts = async () => {
        setIsLoading(true);
        try {
            await new Promise(resolve => setTimeout(resolve, 800));
            setBroadcasts([
                { id: '1', subject: 'System Maintenance Scheduled', content: 'We will be performing scheduled maintenance on Saturday at 2 AM UTC.', sentByName: 'Super Admin', sentAt: '2024-03-10T09:00:00Z', recipientCount: 42, status: 'SENT', recipients: ['ALL'], priority: 'URGENT' },
                { id: '2', subject: 'New Feature: Analytics Dashboard', content: 'Check out the new analytics dashboard available in your portal.', sentByName: 'John Doe', sentAt: '2024-02-28T14:30:00Z', recipientCount: 40, status: 'SENT', recipients: ['ALL'], priority: 'INFO' },
                { id: '3', subject: 'Security Update Required', content: 'Please update your institution security settings by end of week.', sentByName: 'Super Admin', sentAt: '2024-02-15T08:15:00Z', recipientCount: 38, status: 'SENT', recipients: ['ACTIVE'], priority: 'CRITICAL' },
            ]);
        } catch (error) {
            toast.error('Failed to load broadcasts');
        } finally {
            setIsLoading(false);
        }
    };

    // --- Actions ---
    const handleSend = async (isScheduled: boolean = false) => {
        if (!composeData.subject.trim() || !composeData.content.trim()) return;
        setIsSending(true);
        try {
            await new Promise(resolve => setTimeout(resolve, 1500));

            const finalRecipients = recipientMode === 'SELECT' ? selectedRecipients : [recipientMode];

            // Check if we are editing a draft and remove it
            if (composeData.id) {
                setDrafts(prev => prev.filter(d => d.id !== composeData.id));
            }

            if (isScheduled && scheduleDate) {
                const newScheduled: ScheduledBroadcast = {
                    id: Math.random().toString(36).substr(2, 9),
                    subject: composeData.subject,
                    content: composeData.content,
                    scheduledFor: scheduleDate,
                    createdBy: 'Super Admin',
                    recipients: finalRecipients,
                    priority: composeData.priority
                };
                setScheduled([newScheduled, ...scheduled]);
                toast.success(`Broadcast scheduled for ${new Date(scheduleDate).toLocaleString()}`);
            } else {
                const newBroadcast: Broadcast = {
                    id: Math.random().toString(36).substr(2, 9),
                    subject: composeData.subject,
                    content: composeData.content,
                    sentByName: 'Super Admin',
                    sentAt: new Date().toISOString(),
                    recipientCount: finalRecipients.length === 1 && (finalRecipients[0] === 'ALL' || finalRecipients[0] === 'ACTIVE')
                        ? institutions.length // Mock count for bulk
                        : finalRecipients.length,
                    status: 'SENT',
                    recipients: finalRecipients,
                    priority: composeData.priority
                };
                setBroadcasts([newBroadcast, ...broadcasts]);
                toast.success(`Broadcast sent successfully`);
            }

            resetCompose();
        } catch (error) {
            toast.error('Failed to process request');
        } finally {
            setIsSending(false);
        }
    };

    const handleSaveDraft = () => {
        if (!composeData.subject.trim() && !composeData.content.trim()) return;

        if (composeData.id) {
            // Update existing draft
            setDrafts(prev => prev.map(d => d.id === composeData.id ? {
                ...d,
                subject: composeData.subject || 'Untitled Draft',
                content: composeData.content,
                updatedAt: new Date().toISOString(),
                priority: composeData.priority
            } : d));
            toast.success('Draft updated');
        } else {
            // Create new draft
            const newDraft: Draft = {
                id: Math.random().toString(36).substr(2, 9),
                subject: composeData.subject || 'Untitled Draft',
                content: composeData.content,
                updatedAt: new Date().toISOString(),
                priority: composeData.priority
            };
            setDrafts([newDraft, ...drafts]);
            toast.success('Draft saved');
        }

        resetCompose();
    };

    const handleCreateTemplate = async () => {
        if (!newTemplate.name || !newTemplate.subject || !newTemplate.content) return;
        try {
            // Mock API call
            await new Promise(resolve => setTimeout(resolve, 500));
            const template: Template = {
                id: Math.random().toString(36).substr(2, 9),
                ...newTemplate,
                lastUsed: ''
            };
            setTemplates([...templates, template]);
            setNewTemplate({ name: '', subject: '', content: '', priority: 'NORMAL' });
            setShowCreateTemplate(false);
            toast.success('Template created successfully');
        } catch (e) {
            toast.error('Failed to create template');
        }
    };


    const handleUseTemplate = (template: Template) => {
        setComposeData({ id: '', subject: template.subject, content: template.content, priority: template.priority });
        setShowCompose(true);
    };

    const handleEditDraft = (draft: Draft) => {
        setComposeData({ id: draft.id, subject: draft.subject, content: draft.content, priority: draft.priority });
        setShowCompose(true);
    };

    const resetCompose = () => {
        setShowCompose(false);
        setComposeData({ id: '', subject: '', content: '', priority: 'NORMAL' });
        setScheduleDate('');
        setRecipientMode('ALL');
        setSelectedRecipients([]);
    };

    const deleteItem = (id: string, type: 'template' | 'draft' | 'scheduled') => {
        if (type === 'template') setTemplates(prev => prev.filter(i => i.id !== id));
        if (type === 'draft') setDrafts(prev => prev.filter(i => i.id !== id));
        if (type === 'scheduled') setScheduled(prev => prev.filter(i => i.id !== id));
        toast.success('Item deleted');
    };

    const toggleRecipient = (id: string) => {
        setSelectedRecipients(prev =>
            prev.includes(id) ? prev.filter(i => i !== id) : [...prev, id]
        );
    };

    const removeRecipient = (id: string) => {
        setSelectedRecipients(prev => prev.filter(i => i !== id));
        if (selectedRecipients.length <= 1) { // If removing makes it empty (or was 1 and now 0)
            if (selectedRecipients.length === 1 && selectedRecipients[0] === id) {
                setRecipientMode('ALL'); // Default back to ALL if empty
            }
        }
    };

    const getPriorityColor = (p: PriorityLevel) => {
        switch (p) {
            case 'CRITICAL': return 'bg-red-100 text-red-700 border-red-200';
            case 'URGENT': return 'bg-amber-100 text-amber-700 border-amber-200';
            case 'INFO': return 'bg-blue-100 text-blue-700 border-blue-200';
            default: return 'bg-gray-100 text-gray-700 border-gray-200';
        }
    };

    if (isLoading) {
        return (
            <div className="flex items-center justify-center h-[calc(100vh-200px)]">
                <div className="flex flex-col items-center gap-4">
                    <Loader2 className="w-10 h-10 text-[#C0EB6A] animate-spin" />
                    <p className="text-[#6B7C6F] animate-pulse">Loading broadcasts...</p>
                </div>
            </div>
        );
    }

    return (
        <div className="space-y-8">
            {/* Header */}
            <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
                <div>
                    <h2 className="text-2xl font-bold text-[#485550]">Broadcast Center</h2>
                    <p className="text-[#6B7C6F]">Mass communications to platform administrators</p>
                </div>
                <Button onClick={() => setShowCompose(true)} className="btn-morph-primary shadow-lg">
                    <Plus className="w-4 h-4 mr-2" />
                    Compose New
                </Button>
            </div>

            {/* Main Content Tabs */}
            <Tabs defaultValue="overview" value={activeTab} onValueChange={setActiveTab} className="space-y-6">
                <TabsList className="bg-transparent p-0 gap-6 border-b border-[#D1DBC1] w-full justify-start rounded-none h-auto">
                    {[
                        { id: 'overview', label: 'Overview', icon: Megaphone },
                        { id: 'templates', label: 'Templates', icon: FileText },
                        { id: 'scheduled', label: 'Scheduled', icon: Calendar },
                        { id: 'drafts', label: 'Drafts', icon: PenSquare }
                    ].map((tab) => (
                        <TabsTrigger
                            key={tab.id}
                            value={tab.id}
                            className="rounded-none border-b-2 border-transparent data-[state=active]:border-[#C0EB6A] data-[state=active]:bg-transparent data-[state=active]:text-[#485550] text-[#6B7C6F] px-2 py-3 capitalize font-semibold shadow-none transition-all hover:text-[#485550] gap-2"
                        >
                            <tab.icon className="w-4 h-4" />
                            {tab.label}
                        </TabsTrigger>
                    ))}
                </TabsList>

                {/* OVERVIEW TAB */}
                <TabsContent value="overview" className="space-y-6 animate-in slide-in-from-bottom-2 duration-300">
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                        <div className="morph-card p-6 flex items-center justify-between group hover:bg-[#F4F6F0] transition-colors">
                            <div className="space-y-1">
                                <p className="text-[#6B7C6F] text-sm font-medium">Total Sent</p>
                                <p className="text-3xl font-bold text-[#485550]">{broadcasts.length}</p>
                            </div>
                            <div className="w-14 h-14 rounded-2xl bg-blue-50 text-blue-600 flex items-center justify-center shadow-lg group-hover:scale-110 transition-transform">
                                <Megaphone className="w-6 h-6" />
                            </div>
                        </div>
                        <div className="morph-card p-6 flex items-center justify-between group hover:bg-[#F4F6F0] transition-colors">
                            <div className="space-y-1">
                                <p className="text-[#6B7C6F] text-sm font-medium">Scheduled</p>
                                <p className="text-3xl font-bold text-[#485550]">{scheduled.length}</p>
                            </div>
                            <div className="w-14 h-14 rounded-2xl bg-amber-50 text-amber-600 flex items-center justify-center shadow-lg group-hover:scale-110 transition-transform">
                                <Calendar className="w-6 h-6" />
                            </div>
                        </div>
                        <div className="morph-card p-6 flex items-center justify-between group hover:bg-[#F4F6F0] transition-colors">
                            <div className="space-y-1">
                                <p className="text-[#6B7C6F] text-sm font-medium">Drafts</p>
                                <p className="text-3xl font-bold text-[#485550]">{drafts.length}</p>
                            </div>
                            <div className="w-14 h-14 rounded-2xl bg-gray-50 text-gray-600 flex items-center justify-center shadow-lg group-hover:scale-110 transition-transform">
                                <PenSquare className="w-6 h-6" />
                            </div>
                        </div>
                    </div>

                    <div className="morph-card flex flex-col">
                        <CardHeader className="border-b border-gray-100 pb-4">
                            <CardTitle className="text-xl font-bold text-[#485550]">Recent History</CardTitle>
                        </CardHeader>
                        <CardContent className="pt-6 space-y-4">
                            {broadcasts.map((broadcast) => (
                                <div key={broadcast.id} className="p-5 rounded-2xl bg-[#F4F6F0]/50 hover:bg-white border border-transparent hover:border-[#D1DBC1] transition-all group">
                                    <div className="flex justify-between items-start gap-4">
                                        <div>
                                            <div className="flex items-center gap-3 mb-1">
                                                <h3 className="font-bold text-[#485550]">{broadcast.subject}</h3>
                                                <Badge className={`border-0 ${getPriorityColor(broadcast.priority)}`}>
                                                    {broadcast.priority}
                                                </Badge>
                                                <Badge className="bg-green-100 text-green-700 hover:bg-green-200 border-0">Sent</Badge>
                                            </div>
                                            <p className="text-sm text-[#6B7C6F] line-clamp-2 mb-2">{broadcast.content}</p>
                                            <div className="flex items-center gap-4 text-xs text-[#6B7C6F]">
                                                <span className="flex items-center gap-1"><UserCircle className="w-3 h-3" /> {broadcast.sentByName}</span>
                                                <span className="flex items-center gap-1"><Clock className="w-3 h-3" /> {new Date(broadcast.sentAt).toLocaleString()}</span>
                                            </div>
                                        </div>
                                        <div className="text-center">
                                            <span className="block text-xl font-bold text-[#485550]">{broadcast.recipientCount}</span>
                                            <span className="text-[10px] uppercase text-[#6B7C6F] font-bold">Recipients</span>
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </CardContent>
                    </div>
                </TabsContent>

                {/* TEMPLATES TAB */}
                <TabsContent value="templates" className="space-y-6 animate-in slide-in-from-bottom-2 duration-300">
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                        {templates.map((template) => (
                            <div key={template.id} className="morph-card p-6 flex flex-col justify-between group hover:border-[#C0EB6A]">
                                <div>
                                    <div className='flex justify-between items-start mb-2'>
                                        <h3 className="font-bold text-[#485550] text-lg">{template.name}</h3>
                                        <Badge className={`border-0 scale-90 ${getPriorityColor(template.priority)}`}>
                                            {template.priority}
                                        </Badge>
                                    </div>
                                    <p className="text-sm text-[#485550] font-medium mb-1">Subject: {template.subject}</p>
                                    <p className="text-sm text-[#6B7C6F] line-clamp-3 mb-4 bg-[#F4F6F0] p-3 rounded-lg italic">"{template.content}"</p>
                                </div>
                                <div className="flex justify-between items-center pt-4 border-t border-[#F4F6F0]">
                                    <span className="text-xs text-[#6B7C6F]">Used: {template.lastUsed || 'Never'}</span>
                                    <div className="flex gap-2">
                                        <Button size="sm" variant="ghost" onClick={() => deleteItem(template.id, 'template')} className="text-red-400 hover:text-red-600 hover:bg-red-50"><Trash2 className="w-4 h-4" /></Button>
                                        <Button size="sm" onClick={() => handleUseTemplate(template)} className="bg-[#E8EDE0] text-[#485550] hover:bg-[#C0EB6A]">Use</Button>
                                    </div>
                                </div>
                            </div>
                        ))}
                        <div onClick={() => setShowCreateTemplate(true)} className="morph-card p-6 flex flex-col items-center justify-center border-2 border-dashed border-[#D1DBC1] hover:border-[#C0EB6A] cursor-pointer min-h-[200px] bg-[#F4F6F0]/30 transition-colors">
                            <Plus className="w-10 h-10 text-[#6B7C6F] mb-3" />
                            <p className="font-bold text-[#485550]">Create Template</p>
                        </div>
                    </div>
                </TabsContent>

                {/* SCHEDULED TAB */}
                <TabsContent value="scheduled" className="space-y-6 animate-in slide-in-from-bottom-2 duration-300">
                    <div className="space-y-4">
                        {scheduled.length === 0 && <p className="text-center text-[#6B7C6F] py-10">No scheduled broadcasts.</p>}
                        {scheduled.map((item) => (
                            <div key={item.id} className="morph-card p-5 flex items-center justify-between">
                                <div className="flex items-start gap-4">
                                    <div className="p-3 rounded-xl bg-amber-50 text-amber-600">
                                        <Calendar className="w-6 h-6" />
                                    </div>
                                    <div>
                                        <div className='flex items-center gap-2 mb-1'>
                                            <h3 className="font-bold text-[#485550] text-lg">{item.subject}</h3>
                                            <Badge className={`border-0 scale-90 ${getPriorityColor(item.priority)}`}>
                                                {item.priority}
                                            </Badge>
                                        </div>
                                        <p className="text-sm text-[#6B7C6F] mb-2">{item.content.substring(0, 100)}...</p>
                                        <div className="flex items-center gap-4 text-xs text-[#6B7C6F] font-medium">
                                            <span className="flex items-center gap-1 text-amber-600"><Clock className="w-3 h-3" /> Scheduled for: {new Date(item.scheduledFor).toLocaleString()}</span>
                                            <span>By: {item.createdBy}</span>
                                        </div>
                                    </div>
                                </div>
                                <Button variant="outline" onClick={() => deleteItem(item.id, 'scheduled')} className="border-red-200 text-red-500 hover:bg-red-50 hover:text-red-600">Cancel</Button>
                            </div>
                        ))}
                    </div>
                </TabsContent>

                {/* DRAFTS TAB */}
                <TabsContent value="drafts" className="space-y-6 animate-in slide-in-from-bottom-2 duration-300">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                        {drafts.map((draft) => (
                            <div key={draft.id} className="morph-card p-6 relative group">
                                <div className="absolute top-4 right-4 opacity-0 group-hover:opacity-100 transition-opacity flex gap-2">
                                    <Button size="icon" variant="ghost" className="h-8 w-8 text-red-400 hover:bg-red-50" onClick={() => deleteItem(draft.id, 'draft')}><Trash2 className="w-4 h-4" /></Button>
                                </div>
                                <div className='flex items-center gap-2 mb-2'>
                                    <h3 className="font-bold text-[#485550]">{draft.subject}</h3>
                                    <Badge className={`border-0 scale-90 ${getPriorityColor(draft.priority)}`}>
                                        {draft.priority}
                                    </Badge>
                                </div>
                                <p className="text-sm text-[#6B7C6F] mb-4 bg-[#F4F6F0] p-3 rounded-lg min-h-[60px]">{draft.content.substring(0, 150)}...</p>
                                <div className="flex items-center justify-between">
                                    <span className="text-xs text-[#6B7C6F]">Updated: {new Date(draft.updatedAt).toLocaleDateString()}</span>
                                    <Button size="sm" onClick={() => handleEditDraft(draft)} className="btn-morph-primary h-8">Countinue Editing</Button>
                                </div>
                            </div>
                        ))}
                    </div>
                </TabsContent>
            </Tabs>

            {/* Compose Dialog */}
            <Dialog open={showCompose} onOpenChange={setShowCompose}>
                <DialogContent className="sm:max-w-4xl bg-[#F4F6F0] border-white shadow-2xl rounded-[2rem] p-0 overflow-hidden">
                    <div className="grid grid-cols-1 md:grid-cols-5 h-full">
                        {/* Left Side - Visual & Tips */}
                        <div className="md:col-span-2 bg-[#E8EDE0]/50 p-8 flex flex-col justify-between border-b md:border-b-0 md:border-r border-[#D1DBC1]/50 relative overflow-hidden">
                            <div className="relative z-10">
                                <div className="p-3 bg-white rounded-2xl w-fit shadow-sm mb-6 rotate-3">
                                    <div className="p-3 bg-[#C0EB6A] rounded-xl text-[#485550]">
                                        <Megaphone className="w-8 h-8" />
                                    </div>
                                </div>
                                <h3 className="text-[#485550] font-bold text-xl mb-2">Compose Broadcast</h3>
                                <p className="text-[#6B7C6F] text-sm leading-relaxed">
                                    Reach all platform administrators with important updates, maintenance notices, or feature announcements.
                                </p>
                            </div>

                            <div className="relative z-10 mt-8 bg-white/60 p-4 rounded-xl border border-white/50 backdrop-blur-sm">
                                <h4 className="flex items-center gap-2 font-bold text-[#485550] text-sm mb-2">
                                    <BellRing className="w-4 h-4 text-[#C0EB6A]" />
                                    Pro Tips
                                </h4>
                                <ul className="text-xs text-[#6B7C6F] space-y-2 list-disc pl-4">
                                    <li>Keep subjects concise and urgency-driven.</li>
                                    <li>Use templates for recurring maintenance.</li>
                                    <li>Schedule messages for optimal open rates.</li>
                                </ul>
                            </div>

                            {/* Decor */}
                            <div className="absolute -bottom-10 -right-10 text-[#D1DBC1]/20 transform rotate-12">
                                <Send className="w-48 h-48" />
                            </div>
                        </div>

                        {/* Right Side - Form */}
                        <div className="md:col-span-3 p-8 flex flex-col h-full">
                            <DialogHeader className="mb-6 flex-row justify-between items-start">
                                <div>
                                    <DialogTitle className="text-[#485550] text-xl font-bold">New Message</DialogTitle>
                                    <DialogDescription className="text-[#6B7C6F]">
                                        Fill in the details below to send your broadcast.
                                    </DialogDescription>
                                </div>
                            </DialogHeader>

                            <div className="space-y-5 flex-1">

                                {/* Recipient Dropdown */}
                                <div className="space-y-2 relative">
                                    <Label className="text-[#485550] font-medium">Recipients</Label>
                                    <Popover open={showRecipientSelector} onOpenChange={setShowRecipientSelector}>
                                        <PopoverTrigger asChild>
                                            <div className="w-full min-h-[42px] max-h-[80px] overflow-y-auto px-3 py-2 bg-white rounded-xl border border-[#D1DBC1] cursor-pointer flex flex-wrap items-center gap-2 hover:border-[#C0EB6A] transition-colors scrollbar-thin scrollbar-thumb-gray-200 scrollbar-track-transparent">
                                                {recipientMode === 'ALL' && (
                                                    <Badge className="bg-[#485550] text-white border-0 hover:bg-[#485550]">All Institutions</Badge>
                                                )}
                                                {recipientMode === 'ACTIVE' && (
                                                    <Badge className="bg-green-100 text-green-700 border-0 hover:bg-[#485550]">Active Institutions Only</Badge>
                                                )}
                                                {recipientMode === 'SELECT' && selectedRecipients.length > 0 && selectedRecipients.map(id => {
                                                    const inst = institutions.find(i => i.id === id);
                                                    return inst ? (
                                                        <Badge key={id} variant="secondary" className="bg-[#F4F6F0] text-[#485550] hover:bg-[#E8EDE0] flex items-center gap-1">
                                                            {inst.name}
                                                            <X className="w-3 h-3 cursor-pointer hover:text-red-500" onClick={(e) => { e.stopPropagation(); removeRecipient(id); }} />
                                                        </Badge>
                                                    ) : null;
                                                })}
                                                {recipientMode === 'SELECT' && selectedRecipients.length === 0 && (
                                                    <span className="text-[#6B7C6F] text-sm">Select institutions...</span>
                                                )}
                                                <ChevronDown className="ml-auto h-4 w-4 opacity-50 sticky right-0 top-0" />
                                            </div>
                                        </PopoverTrigger>
                                        <PopoverContent className="w-[450px] p-0" align="center">
                                            <Command>
                                                <CommandInput placeholder="Search institutions..." />
                                                <CommandList className="max-h-[200px] overflow-y-auto scrollbar-thin scrollbar-thumb-gray-200">
                                                    <CommandEmpty>No institution found.</CommandEmpty>
                                                    <CommandGroup heading="Broadcast Groups">
                                                        <CommandItem onSelect={() => { setRecipientMode('ALL'); setShowRecipientSelector(false); }}>
                                                            <Users className="mr-2 h-4 w-4" /> All Institutions
                                                            {recipientMode === 'ALL' && <Check className="ml-auto h-4 w-4" />}
                                                        </CommandItem>
                                                        <CommandItem onSelect={() => { setRecipientMode('ACTIVE'); setShowRecipientSelector(false); }}>
                                                            <CheckCircle2 className="mr-2 h-4 w-4" /> Active Only
                                                            {recipientMode === 'ACTIVE' && <Check className="ml-auto h-4 w-4" />}
                                                        </CommandItem>
                                                    </CommandGroup>
                                                    <CommandGroup heading="Specific Institutions">
                                                        {/* Logic to toggle SELECT mode if item clicked */}
                                                        <CommandItem onSelect={() => {
                                                            setRecipientMode('SELECT');
                                                            // Keep open to allow multiple select
                                                        }} disabled className="opacity-50 font-bold">
                                                            -- Select Individually --
                                                        </CommandItem>
                                                        {institutions.map(inst => (
                                                            <CommandItem key={inst.id} onSelect={() => {
                                                                setRecipientMode('SELECT');
                                                                toggleRecipient(inst.id);
                                                            }}>
                                                                <div className={`mr-2 flex h-4 w-4 items-center justify-center rounded-sm border border-primary ${selectedRecipients.includes(inst.id) && recipientMode === 'SELECT' ? "bg-primary text-primary-foreground" : "opacity-50 [&_svg]:invisible"}`}>
                                                                    <Check className="h-4 w-4" />
                                                                </div>
                                                                {inst.name}
                                                                <span className="ml-auto text-xs text-muted-foreground">{inst.status}</span>
                                                            </CommandItem>
                                                        ))}
                                                    </CommandGroup>
                                                </CommandList>
                                            </Command>
                                        </PopoverContent>
                                    </Popover>
                                </div>

                                <div className="flex gap-4">
                                    <div className="space-y-2 flex-1">
                                        <Label className="text-[#485550] font-medium">Subject Line</Label>
                                        <Input
                                            placeholder="e.g., Important Platform Maintenance Update"
                                            value={composeData.subject}
                                            onChange={(e) => setComposeData({ ...composeData, subject: e.target.value })}
                                            className="input-morph bg-white font-medium"
                                        />
                                    </div>
                                    <div className="space-y-2 w-1/3">
                                        <Label className="text-[#485550] font-medium">Priority</Label>
                                        <Select
                                            value={composeData.priority}
                                            onValueChange={(val: PriorityLevel) => setComposeData({ ...composeData, priority: val })}
                                        >
                                            <SelectTrigger className="input-morph bg-white">
                                                <SelectValue />
                                            </SelectTrigger>
                                            <SelectContent>
                                                <SelectItem value="NORMAL">
                                                    <div className="flex items-center gap-2"><div className="w-2 h-2 rounded-full bg-gray-400"></div> Normal</div>
                                                </SelectItem>
                                                <SelectItem value="INFO">
                                                    <div className="flex items-center gap-2"><div className="w-2 h-2 rounded-full bg-blue-500"></div> Info</div>
                                                </SelectItem>
                                                <SelectItem value="URGENT">
                                                    <div className="flex items-center gap-2"><div className="w-2 h-2 rounded-full bg-amber-500"></div> Urgent</div>
                                                </SelectItem>
                                                <SelectItem value="CRITICAL">
                                                    <div className="flex items-center gap-2"><div className="w-2 h-2 rounded-full bg-red-500"></div> Critical</div>
                                                </SelectItem>
                                            </SelectContent>
                                        </Select>
                                    </div>
                                </div>

                                <div className="space-y-2 flex-1 flex flex-col">
                                    <Label className="text-[#485550] font-medium">Message Content</Label>
                                    <Textarea
                                        placeholder="Type your message here..."
                                        value={composeData.content}
                                        onChange={(e) => setComposeData({ ...composeData, content: e.target.value })}
                                        className="min-h-[150px] flex-1 bg-white border-0 shadow-inner resize-none rounded-xl p-4 focus:ring-2 focus:ring-[#C0EB6A]"
                                    />
                                </div>
                            </div>

                            <DialogFooter className="flex justify-between sm:justify-between gap-3 border-t border-[#F4F6F0] pt-6 mt-6 items-end">
                                <Button
                                    variant="ghost"
                                    onClick={handleSaveDraft}
                                    className="text-[#6B7C6F] hover:text-[#485550] hover:bg-[#D1DBC1]/20 rounded-xl"
                                >
                                    <Save className="w-4 h-4 mr-2" />
                                    Save Draft
                                </Button>
                                <div className="flex gap-2">
                                    <Button variant="ghost" onClick={resetCompose} className="text-[#6B7C6F]">Cancel</Button>
                                    <div className="flex bg-[#485550] rounded-xl overflow-hidden p-0.5">
                                        <Button
                                            onClick={() => handleSend(Boolean(scheduleDate))}
                                            disabled={isSending || !composeData.subject.trim() || !composeData.content.trim()}
                                            className="bg-[#485550] hover:bg-[#3a4440] text-white rounded-l-lg rounded-r-none h-auto py-2 px-4 shadow-none border-r border-[#ffffff]/20"
                                        >
                                            {isSending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : (scheduleDate ? <Calendar className="w-4 h-4 mr-2" /> : <Send className="w-4 h-4 mr-2" />)}
                                            {scheduleDate ? 'Schedule' : 'Send Now'}
                                        </Button>
                                        <DropdownMenu>
                                            <DropdownMenuTrigger asChild>
                                                <Button className="bg-[#485550] hover:bg-[#3a4440] text-white rounded-r-lg rounded-l-none h-auto px-2 shadow-none">
                                                    <ChevronDown className="w-4 h-4" />
                                                </Button>
                                            </DropdownMenuTrigger>
                                            <DropdownMenuContent align="end" className="w-[300px] p-4">
                                                <Label className="text-xs font-bold text-[#6B7C6F] uppercase mb-2 block">Schedule Send Time</Label>
                                                <Input
                                                    type="datetime-local"
                                                    className="bg-white border-[#D1DBC1] h-9 text-sm"
                                                    value={scheduleDate}
                                                    onChange={(e) => setScheduleDate(e.target.value)}
                                                />
                                                {scheduleDate && (
                                                    <Button
                                                        variant="ghost"
                                                        size="sm"
                                                        onClick={() => setScheduleDate('')}
                                                        className="w-full mt-2 text-red-500 h-8 hover:text-red-700 hover:bg-red-50"
                                                    >
                                                        Clear Schedule
                                                    </Button>
                                                )}
                                            </DropdownMenuContent>
                                        </DropdownMenu>
                                    </div>
                                </div>
                            </DialogFooter>
                        </div>
                    </div>
                </DialogContent>
            </Dialog>

            {/* Create Template Dialog */}
            <Dialog open={showCreateTemplate} onOpenChange={setShowCreateTemplate}>
                <DialogContent className="sm:max-w-md bg-white rounded-2xl">
                    <DialogHeader>
                        <DialogTitle>Create Template</DialogTitle>
                        <DialogDescription>Save a new message template for future use.</DialogDescription>
                    </DialogHeader>
                    <div className="space-y-4 py-4">
                        <div className="space-y-2">
                            <Label>Template Name</Label>
                            <Input
                                placeholder="e.g., Monthly Maintenance"
                                value={newTemplate.name}
                                onChange={(e) => setNewTemplate({ ...newTemplate, name: e.target.value })}
                            />
                        </div>
                        <div className="space-y-2">
                            <Label>Subject Line</Label>
                            <Input
                                placeholder="Email Subject"
                                value={newTemplate.subject}
                                onChange={(e) => setNewTemplate({ ...newTemplate, subject: e.target.value })}
                            />
                        </div>
                        <div className="space-y-2">
                            <Label>Default Priority</Label>
                            <Select
                                value={newTemplate.priority}
                                onValueChange={(val: PriorityLevel) => setNewTemplate({ ...newTemplate, priority: val })}
                            >
                                <SelectTrigger className="input-morph bg-white">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="NORMAL">Normal</SelectItem>
                                    <SelectItem value="INFO">Info</SelectItem>
                                    <SelectItem value="URGENT">Urgent</SelectItem>
                                    <SelectItem value="CRITICAL">Critical</SelectItem>
                                </SelectContent>
                            </Select>
                        </div>
                        <div className="space-y-2">
                            <Label>Content Body</Label>
                            <Textarea
                                placeholder="Template content..."
                                className="min-h-[100px]"
                                value={newTemplate.content}
                                onChange={(e) => setNewTemplate({ ...newTemplate, content: e.target.value })}
                            />
                        </div>
                    </div>
                    <DialogFooter>
                        <Button variant="ghost" onClick={() => setShowCreateTemplate(false)}>Cancel</Button>
                        <Button onClick={handleCreateTemplate} className="btn-morph-primary">Create Template</Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}
