'use client';

import { useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
    Search,
    FileText,
    CheckCircle,
    Printer,
    Download,
    Filter,
    Loader2,
    AlertTriangle
} from 'lucide-react';
import { toast } from 'sonner';
import {
    Accordion,
    AccordionContent,
    AccordionItem,
    AccordionTrigger,
} from "@/components/ui/accordion";

// Mock Senate List Candidates
const initialCandidates = [
    {
        id: 'SEN-001',
        matricNumber: 'UNI/2020/CSC/045',
        name: 'Oluwaseun Adebayo',
        department: 'Computer Science',
        cgpa: '4.65',
        classOfDegree: 'First Class',
        session: '2023/2024',
        status: 'READY'
    },
    {
        id: 'SEN-002',
        matricNumber: 'UNI/2020/MTH/012',
        name: 'Chioma Nwosu',
        department: 'Mathematics',
        cgpa: '4.52',
        classOfDegree: 'First Class',
        session: '2023/2024',
        status: 'READY'
    },
    {
        id: 'SEN-003',
        matricNumber: 'UNI/2020/PHY/088',
        name: 'Ibrahim Musa',
        department: 'Physics',
        cgpa: '3.85',
        classOfDegree: 'Second Class Upper',
        session: '2023/2024',
        status: 'PENDING_BURSARY'
    },
    {
        id: 'SEN-004',
        matricNumber: 'UNI/2020/CSC/099',
        name: 'Sarah Idahosa',
        department: 'Computer Science',
        cgpa: '4.20',
        classOfDegree: 'Second Class Upper',
        session: '2023/2024',
        status: 'READY'
    },
];

export default function SenateList() {
    const [candidates, setCandidates] = useState(initialCandidates);
    const [generating, setGenerating] = useState(false);
    const [printing, setPrinting] = useState(false);

    const handlePrint = async () => {
        setPrinting(true);
        // Simulate generation
        await new Promise(resolve => setTimeout(resolve, 2000));
        toast.success('Senate Draft generated', {
            description: 'The PDF has been sent to your downloads folder.'
        });
        setPrinting(false);
    };

    const handleGenerateFinal = async () => {
        if (!confirm('Are you sure you want to generate the Final Senate List? This will lock the current batch.')) return;

        setGenerating(true);
        // Simulate heavy processing
        await new Promise(resolve => setTimeout(resolve, 3000));

        toast.success('Final Senate List Generated successfully', {
            description: 'The list is now available for the University Senate review.'
        });
        setGenerating(false);
    };

    return (
        <div className="space-y-6">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div>
                    <h1 className="text-3xl font-bold text-[#485550]">Senate Graduation Lists</h1>
                    <p className="text-[#485550]/70 mt-1">
                        Compile and approve list of graduating students for Senate ratification
                    </p>
                </div>
                <div className="flex gap-2">
                    <Button
                        variant="outline"
                        className="border-[#485550]/20 text-[#485550]"
                        onClick={handlePrint}
                        disabled={printing || generating}
                    >
                        {printing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Printer className="mr-2 h-4 w-4" />}
                        Print Draft
                    </Button>
                    <Button
                        className="bg-[#485550] hover:bg-[#3a4543]"
                        onClick={handleGenerateFinal}
                        disabled={printing || generating}
                    >
                        {generating ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <FileText className="mr-2 h-4 w-4" />}
                        Generate Final List
                    </Button>
                </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                {/* Statistics */}
                <Card className="border-[#F4F6F0]">
                    <CardHeader className="pb-2">
                        <CardTitle className="text-sm font-medium text-[#485550]/70">Total Candidates</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <div className="text-2xl font-bold text-[#485550]">342</div>
                        <p className="text-xs text-[#485550]/50 mt-1">Academically qualified</p>
                    </CardContent>
                </Card>
                <Card className="border-[#F4F6F0]">
                    <CardHeader className="pb-2">
                        <CardTitle className="text-sm font-medium text-[#485550]/70">Fully Cleared</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <div className="text-2xl font-bold text-[#C0EB6A] text-shadow-sm">285</div>
                        <p className="text-xs text-[#485550]/50 mt-1">Ready for Senate</p>
                    </CardContent>
                </Card>
                <Card className="border-[#F4F6F0]">
                    <CardHeader className="pb-2">
                        <CardTitle className="text-sm font-medium text-[#485550]/70">Pending Clearance</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <div className="text-2xl font-bold text-amber-600">57</div>
                        <p className="text-xs text-[#485550]/50 mt-1">Bursary or Library issues</p>
                    </CardContent>
                </Card>
            </div>

            {/* Main List */}
            <Accordion type="multiple" className="space-y-4" defaultValue={['Computer Science', 'Mathematics']}>
                {Object.entries(candidates.reduce((acc, student) => {
                    if (!acc[student.department]) acc[student.department] = [];
                    acc[student.department].push(student);
                    return acc;
                }, {} as Record<string, typeof candidates>)).map(([dept, students]) => {
                    const firstClassCount = students.filter(s => s.classOfDegree === 'First Class').length;
                    const clearedCount = students.filter(s => s.status === 'READY').length;

                    return (
                        <AccordionItem value={dept} key={dept} className="border border-[#F4F6F0] rounded-xl bg-white overflow-hidden">
                            <AccordionTrigger className="px-6 py-4 hover:bg-[#F4F6F0]/30 transition-all hover:no-underline">
                                <div className="flex items-center gap-4 w-full">
                                    <div className="flex items-center gap-3 flex-1">
                                        <div className="h-8 w-8 rounded-lg bg-[#C0EB6A]/20 flex items-center justify-center">
                                            <FileText className="h-4 w-4 text-[#485550]" />
                                        </div>
                                        <div className="text-left">
                                            <h3 className="font-bold text-[#485550] text-lg">{dept}</h3>
                                            <p className="text-xs text-[#485550]/60 font-normal">
                                                {students.length} Graduating Students
                                            </p>
                                        </div>
                                    </div>
                                    <div className="flex gap-4 pr-4">
                                        <div className="text-right hidden sm:block">
                                            <p className="text-xs text-[#485550]/60">First Class</p>
                                            <p className="font-bold text-[#485550]">{firstClassCount}</p>
                                        </div>
                                        <div className="text-right hidden sm:block">
                                            <p className="text-xs text-[#485550]/60">Cleared</p>
                                            <p className="font-bold text-[#C0EB6A]">{clearedCount}/{students.length}</p>
                                        </div>
                                    </div>
                                </div>
                            </AccordionTrigger>
                            <AccordionContent className="p-0 border-t border-[#F4F6F0]">
                                <div className="p-4 bg-[#F4F6F0]/30 border-b border-[#F4F6F0] flex justify-between items-center">
                                    <div className="text-xs font-medium text-[#485550]/70 uppercase tracking-wider">Departmental Graduation List</div>
                                    <div className="flex gap-2">
                                        <Button variant="outline" size="sm" className="h-8 border-[#485550]/20 text-[#485550] text-xs">
                                            <Download className="mr-2 h-3 w-3" /> Export Dept List
                                        </Button>
                                    </div>
                                </div>
                                <div className="overflow-x-auto">
                                    <table className="w-full text-sm text-left">
                                        <thead className="bg-[#F4F6F0]/50 text-[#485550] font-medium">
                                            <tr>
                                                <th className="px-6 py-3">Student Details</th>
                                                <th className="px-6 py-3">CGPA</th>
                                                <th className="px-6 py-3">Class of Degree</th>
                                                <th className="px-6 py-3">Status</th>
                                            </tr>
                                        </thead>
                                        <tbody className="divide-y divide-[#F4F6F0]">
                                            {students.map((student) => (
                                                <tr key={student.id} className="hover:bg-[#F4F6F0]/30 transition-colors">
                                                    <td className="px-6 py-4">
                                                        <div className="font-semibold text-[#485550]">{student.name}</div>
                                                        <div className="text-xs text-[#485550]/60 font-mono">{student.matricNumber}</div>
                                                    </td>
                                                    <td className="px-6 py-4 font-semibold text-[#485550]">{student.cgpa}</td>
                                                    <td className="px-6 py-4 text-[#485550]">
                                                        <Badge variant="secondary" className={`${student.classOfDegree === 'First Class' ? 'bg-purple-100 text-purple-700' : 'bg-gray-100 text-gray-700'}`}>
                                                            {student.classOfDegree}
                                                        </Badge>
                                                    </td>
                                                    <td className="px-6 py-4">
                                                        {student.status === 'READY' ? (
                                                            <Badge className="bg-[#C0EB6A]/20 text-[#485550] border-[#C0EB6A] hover:bg-[#C0EB6A]/30">
                                                                <CheckCircle className="w-3 h-3 mr-1" /> Cleared
                                                            </Badge>
                                                        ) : (
                                                            <Badge variant="outline" className="text-amber-600 border-amber-200 bg-amber-50">
                                                                <AlertTriangle className="w-3 h-3 mr-1" /> Pending
                                                            </Badge>
                                                        )}
                                                    </td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            </AccordionContent>
                        </AccordionItem>
                    );
                })}
            </Accordion>
        </div>
    );
}
