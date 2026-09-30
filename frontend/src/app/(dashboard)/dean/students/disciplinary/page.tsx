'use client';

import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
    Gavel,
    Search,
    FileWarning,
    AlertTriangle,
    User,
    Calendar,
    MoreVertical,
    CheckCircle,
    Clock,
    ArrowLeft
} from 'lucide-react';
import { Input } from '@/components/ui/input';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { toast } from 'sonner';
import Link from 'next/link';

// Mock Cases
const cases = [
    {
        id: 'CS-2024-004',
        student: 'David Ojo',
        matric: 'UNI/23/PHY/012',
        dept: 'Physics',
        offense: 'Examination Malpractice',
        details: 'Caught with cheat sheets during PHY 101 Exam.',
        date: '2024-02-14',
        status: 'PENDING_HEARING',
        panel: 'Panel A'
    },
    {
        id: 'CS-2024-002',
        student: 'Grace Eze',
        matric: 'UNI/22/CHM/056',
        dept: 'Chemistry',
        offense: 'Plagiarism',
        details: 'Submitted substantial part of Final Year Project from online source without citation.',
        date: '2024-01-20',
        status: 'DECIDED',
        verdict: 'Semester Suspension',
        panel: 'Panel B'
    },
    {
        id: 'CS-2024-001',
        student: 'Mohammed Ali',
        matric: 'UNI/22/CSC/088',
        dept: 'Computer Science',
        offense: 'Gross Misconduct',
        details: 'Disrespectful behavior towards a Faculty Officer.',
        date: '2024-01-15',
        status: 'DECIDED',
        verdict: 'Warning Letter',
        panel: 'Panel A'
    }
];

export default function DisciplinaryCommittee() {
    const [searchTerm, setSearchTerm] = useState('');
    const [newCaseOpen, setNewCaseOpen] = useState(false);

    const handleCreateCase = () => {
        toast.success('Case Logged', { description: 'The student has been notified to appear before the committee.' });
        setNewCaseOpen(false);
    };

    return (
        <div className="space-y-6">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div className="flex items-center gap-4">
                    <Link href="/dean/students">
                        <Button variant="ghost" size="icon">
                            <ArrowLeft className="h-5 w-5" />
                        </Button>
                    </Link>
                    <div className="flex flex-col">
                        <h1 className="text-3xl font-bold text-[#485550]">Disciplinary Committee</h1>
                        <p className="text-[#485550]/70 mt-1">
                            Manage student misconduct cases and hearings
                        </p>
                    </div>
                </div>
                <Button className="bg-red-600 hover:bg-red-700 text-white" onClick={() => setNewCaseOpen(true)}>
                    <Gavel className="mr-2 h-4 w-4" /> Log New Case
                </Button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                <Card className="border-[#F4F6F0]">
                    <CardContent className="p-6">
                        <div className="flex items-center gap-4">
                            <div className="h-12 w-12 rounded-full bg-amber-100 flex items-center justify-center text-amber-600">
                                <Clock className="w-6 h-6" />
                            </div>
                            <div>
                                <p className="text-sm font-medium text-[#485550]/70">Pending Hearings</p>
                                <h3 className="text-2xl font-bold text-[#485550]">5</h3>
                            </div>
                        </div>
                    </CardContent>
                </Card>
                <Card className="border-[#F4F6F0]">
                    <CardContent className="p-6">
                        <div className="flex items-center gap-4">
                            <div className="h-12 w-12 rounded-full bg-red-100 flex items-center justify-center text-red-600">
                                <FileWarning className="w-6 h-6" />
                            </div>
                            <div>
                                <p className="text-sm font-medium text-[#485550]/70">Expulsions (Session)</p>
                                <h3 className="text-2xl font-bold text-[#485550]">2</h3>
                            </div>
                        </div>
                    </CardContent>
                </Card>
                <Card className="border-[#F4F6F0]">
                    <CardContent className="p-6">
                        <div className="flex items-center gap-4">
                            <div className="h-12 w-12 rounded-full bg-blue-100 flex items-center justify-center text-blue-600">
                                <Gavel className="w-6 h-6" />
                            </div>
                            <div>
                                <p className="text-sm font-medium text-[#485550]/70">Cases Closed</p>
                                <h3 className="text-2xl font-bold text-[#485550]">18</h3>
                            </div>
                        </div>
                    </CardContent>
                </Card>
            </div>

            <Card className="border-[#F4F6F0]">
                <CardHeader>
                    <div className="flex justify-between items-center">
                        <CardTitle className="text-[#485550]">Case Docket</CardTitle>
                        <div className="relative w-full sm:w-64">
                            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-[#485550]/40" />
                            <Input
                                placeholder="Search matric number..."
                                className="pl-9 border-[#485550]/20"
                                value={searchTerm}
                                onChange={(e) => setSearchTerm(e.target.value)}
                            />
                        </div>
                    </div>
                </CardHeader>
                <CardContent>
                    <div className="space-y-4">
                        {cases.filter(c => c.student.toLowerCase().includes(searchTerm.toLowerCase())).map((c) => (
                            <div key={c.id} className="flex flex-col md:flex-row justify-between p-4 rounded-xl border border-[#F4F6F0] bg-white hover:border-[#C0EB6A]/50 transition-all">
                                <div className="flex gap-4">
                                    <div className="mt-1">
                                        {c.status === 'PENDING_HEARING' ? (
                                            <AlertTriangle className="h-5 w-5 text-amber-500" />
                                        ) : (
                                            <CheckCircle className="h-5 w-5 text-green-500" />
                                        )}
                                    </div>
                                    <div>
                                        <div className="flex items-center gap-2">
                                            <h3 className="font-bold text-[#485550]">{c.student}</h3>
                                            <span className="text-xs font-mono text-[#485550]/50 bg-[#F4F6F0] px-1.5 py-0.5 rounded">{c.matric}</span>
                                        </div>
                                        <p className="text-sm font-medium text-red-600 mt-0.5">{c.offense}</p>
                                        <p className="text-sm text-[#485550]/70 mt-1">{c.details}</p>
                                        <div className="flex gap-4 mt-2 text-xs text-[#485550]/50">
                                            <span className="flex items-center gap-1"><Calendar className="w-3 h-3" /> {c.date}</span>
                                            <span>•</span>
                                            <span>{c.panel}</span>
                                        </div>
                                    </div>
                                </div>

                                <div className="flex flex-col items-end gap-2 mt-4 md:mt-0 justify-center min-w-[140px]">
                                    {c.status === 'PENDING_HEARING' ? (
                                        <Badge variant="outline" className="border-amber-200 text-amber-700 bg-amber-50">Pending Hearing</Badge>
                                    ) : (
                                        <div className="text-right">
                                            <Badge variant="outline" className="border-gray-200 text-gray-700 bg-gray-50 mb-1">Decided</Badge>
                                            <p className="text-xs font-semibold text-[#485550]"> Verdict: {c.verdict}</p>
                                        </div>
                                    )}
                                    <Button size="sm" variant="ghost" className="h-8 text-[#485550]/60 hover:text-[#485550]">
                                        View Details
                                    </Button>
                                </div>
                            </div>
                        ))}
                    </div>
                </CardContent>
            </Card>

            <Dialog open={newCaseOpen} onOpenChange={setNewCaseOpen}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Log Disciplinary Case</DialogTitle>
                        <DialogDescription>Initiate a new disciplinary proceeding against a student.</DialogDescription>
                    </DialogHeader>
                    <div className="space-y-4 py-2">
                        <div className="space-y-2">
                            <Label>Student Matric Number</Label>
                            <Input placeholder="e.g. UNI/23/..." />
                        </div>
                        <div className="space-y-2">
                            <Label>Offense Type</Label>
                            <Select>
                                <SelectTrigger>
                                    <SelectValue placeholder="Select offense" />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="malpractice">Examination Malpractice</SelectItem>
                                    <SelectItem value="misconduct">Gross Misconduct</SelectItem>
                                    <SelectItem value="plagiarism">Plagiarism</SelectItem>
                                    <SelectItem value="theft">Theft/Damage to Property</SelectItem>
                                </SelectContent>
                            </Select>
                        </div>
                        <div className="space-y-2">
                            <Label>Description of Incident</Label>
                            <Textarea placeholder="Provide details..." className="min-h-[100px]" />
                        </div>
                    </div>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setNewCaseOpen(false)}>Cancel</Button>
                        <Button className="bg-red-600 hover:bg-red-700 text-white" onClick={handleCreateCase}>Create Case</Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}
