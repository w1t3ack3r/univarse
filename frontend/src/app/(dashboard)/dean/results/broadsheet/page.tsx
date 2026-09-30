'use client';

import { useState } from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow
} from '@/components/ui/table';
import { Input } from '@/components/ui/input';
import {
    Download,
    Filter,
    Search,
    CheckCircle,
    AlertTriangle
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';

// Mock Broadsheet Data
const MOCK_COURSES = [
    { code: 'CSC 401', unit: 3 },
    { code: 'CSC 403', unit: 3 },
    { code: 'CSC 405', unit: 2 },
    { code: 'MTH 401', unit: 3 },
    { code: 'GNS 401', unit: 2 },
];

const MOCK_RESULTS = [
    {
        student: { name: 'Oluwaseun Adebayo', matNo: 'UNI/20/CSC/045' },
        scores: {
            'CSC 401': { ca: 24, exam: 48, total: 72, grade: 'A', attempt: 'FIRST' },
            'CSC 403': { ca: 22, exam: 45, total: 67, grade: 'B', attempt: 'FIRST' },
            'CSC 405': { ca: 25, exam: 50, total: 75, grade: 'A', attempt: 'FIRST' },
            'MTH 401': { ca: 20, exam: 40, total: 60, grade: 'B', attempt: 'FIRST' },
            'GNS 401': { ca: 28, exam: 55, total: 83, grade: 'A', attempt: 'FIRST' }
        },
        summary: { tcp: 65, tnu: 13, gpa: 4.85, cgpa: 4.65, status: 'GOOD STANDING' }
    },
    {
        student: { name: 'Chioma Nwosu', matNo: 'UNI/20/CSC/052' },
        scores: {
            'CSC 401': { ca: 18, exam: 35, total: 53, grade: 'C', attempt: 'FIRST' },
            'CSC 403': { ca: 20, exam: 42, total: 62, grade: 'B', attempt: 'FIRST' },
            'CSC 405': { ca: 21, exam: 44, total: 65, grade: 'B', attempt: 'FIRST' },
            'MTH 401': { ca: 15, exam: 25, total: 40, grade: 'E', attempt: 'FIRST' }, // Fail
            'GNS 401': { ca: 25, exam: 45, total: 70, grade: 'A', attempt: 'CARRY_OVER' } // Example of CO passed
        },
        summary: { tcp: 42, tnu: 13, gpa: 3.23, cgpa: 3.45, status: 'GOOD STANDING' }
    },
    {
        student: { name: 'Ibrahim Musa', matNo: 'UNI/20/CSC/066' },
        scores: {
            'CSC 401': { ca: 12, exam: 20, total: 32, grade: 'F', attempt: 'FIRST' }, // Fail
            'CSC 403': { ca: 15, exam: 30, total: 45, grade: 'D', attempt: 'FIRST' },
            'CSC 405': { ca: 18, exam: 32, total: 50, grade: 'C', attempt: 'CARRY_OVER' }, // Retaken and passed
            'MTH 401': { ca: 10, exam: 15, total: 25, grade: 'F', attempt: 'FIRST' }, // Fail
            'GNS 401': { ca: 22, exam: 38, total: 60, grade: 'B', attempt: 'FIRST' }
        },
        summary: { tcp: 24, tnu: 13, gpa: 1.84, cgpa: 1.95, status: 'PROBATION' }
    },
    // Add more rows to simulate density...
    ...Array.from({ length: 15 }).map((_, i) => ({
        student: { name: `Student ${i + 1}`, matNo: `UNI/20/CSC/${100 + i}` },
        scores: {
            'CSC 401': { ca: 20, exam: 40, total: 60, grade: 'B', attempt: 'FIRST' },
            'CSC 403': { ca: 20, exam: 40, total: 60, grade: 'B', attempt: 'FIRST' },
            'CSC 405': { ca: 20, exam: 40, total: 60, grade: 'B', attempt: 'CARRY_OVER' }, // Simulated random CO
            'MTH 401': { ca: 20, exam: 40, total: 60, grade: 'B', attempt: 'FIRST' },
            'GNS 401': { ca: 20, exam: 40, total: 60, grade: 'B', attempt: 'FIRST' }
        },
        summary: { tcp: 52, tnu: 13, gpa: 4.00, cgpa: 4.00, status: 'GOOD STANDING' }
    }))
];

export default function BroadsheetView() {
    const [searchTerm, setSearchTerm] = useState('');

    const getGradeColor = (grade: string) => {
        switch (grade) {
            case 'A': return 'text-green-700 font-bold';
            case 'B': return 'text-green-600';
            case 'C': return 'text-blue-600';
            case 'D': return 'text-[#485550]';
            case 'E': return 'text-amber-600';
            case 'F': return 'text-red-600 font-bold bg-red-50 ring-1 ring-red-200'; // Highlight fails
            default: return '';
        }
    };

    return (
        <div className="space-y-4 h-[calc(100vh-8rem)] flex flex-col">
            <div className="flex flex-col sm:flex-row justify-between gap-4">
                <div>
                    <h1 className="text-3xl font-bold text-[#485550]">Master Broadsheet</h1>
                    <div className="flex items-center gap-2 mt-1">
                        <p className="text-[#485550]/70">
                            Computer Science • 400 Level • 2024/2025 Harmattan
                        </p>
                        <Badge variant="outline" className="text-amber-600 border-amber-200 bg-amber-50 text-[10px]">
                            CO: Carry Over
                        </Badge>
                    </div>
                </div>
                <div className="flex gap-2">
                    <div className="relative w-64">
                        <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-[#485550]/40" />
                        <Input
                            placeholder="Search matric no..."
                            className="pl-9 border-[#485550]/20"
                            value={searchTerm}
                            onChange={(e) => setSearchTerm(e.target.value)}
                        />
                    </div>
                    <Button variant="outline" className="border-[#485550]/20 text-[#485550]">
                        <Filter className="mr-2 h-4 w-4" /> Filter
                    </Button>
                    <Button variant="outline" className="border-[#485550]/20 text-[#485550]">
                        <Download className="mr-2 h-4 w-4" /> Export
                    </Button>
                </div>
            </div>

            <Card className="border-[#F4F6F0] flex-1 overflow-hidden flex flex-col">
                <div className="overflow-auto flex-1">
                    <Table>
                        <TableHeader className="bg-[#F4F6F0] sticky top-0 z-10">
                            <TableRow>
                                <TableHead className="min-w-[250px] font-bold text-[#485550]">Student Details</TableHead>
                                {MOCK_COURSES.map(course => (
                                    <TableHead key={course.code} className="text-center border-l border-[#485550]/10 min-w-[100px]">
                                        <div className="font-bold text-[#485550]">{course.code}</div>
                                        <div className="text-xs text-[#485550]/60">{course.unit} Units</div>
                                    </TableHead>
                                ))}
                                <TableHead className="text-center border-l-2 border-[#485550]/10 bg-[#F4F6F0] min-w-[300px]">Summary</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {MOCK_RESULTS.filter(r =>
                                r.student.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
                                r.student.matNo.toLowerCase().includes(searchTerm.toLowerCase())
                            ).map((row, idx) => (
                                <TableRow key={idx} className="hover:bg-[#F4F6F0]/30 transition-colors">
                                    <TableCell className="font-medium bg-white/50 sticky left-0 z-10">
                                        <div className="text-[#485550]">{row.student.name}</div>
                                        <div className="text-xs text-[#485550]/60 font-mono">{row.student.matNo}</div>
                                    </TableCell>
                                    {MOCK_COURSES.map(course => {
                                        const score = row.scores[course.code as keyof typeof row.scores];
                                        return (
                                            <TableCell key={course.code} className="text-center border-l border-[#F4F6F0] p-2 relative group">
                                                {score ? (
                                                    <div>
                                                        <div className={`text-lg ${getGradeColor(score.grade)}`}>{score.total}</div>
                                                        <div className="text-[10px] text-[#485550]/50 font-mono">
                                                            {score.grade} ({score.ca}/{score.exam})
                                                        </div>
                                                        {score.attempt === 'CARRY_OVER' && (
                                                            <div className="absolute top-1 right-1">
                                                                <Badge variant="secondary" className="h-4 px-1 text-[8px] bg-amber-100 text-amber-700 hover:bg-amber-200">CO</Badge>
                                                            </div>
                                                        )}
                                                    </div>
                                                ) : (
                                                    <span className="text-gray-300">-</span>
                                                )}
                                            </TableCell>
                                        );
                                    })}
                                    <TableCell className="border-l-2 border-[#F4F6F0] bg-[#F4F6F0]/10">
                                        <div className="grid grid-cols-4 gap-2 text-center">
                                            <div>
                                                <div className="text-[10px] text-[#485550]/50">TCP</div>
                                                <div className="font-bold text-[#485550]">{row.summary.tcp}</div>
                                            </div>
                                            <div>
                                                <div className="text-[10px] text-[#485550]/50">TNU</div>
                                                <div className="font-bold text-[#485550]">{row.summary.tnu}</div>
                                            </div>
                                            <div>
                                                <div className="text-[10px] text-[#485550]/50">GPA</div>
                                                <div className="font-bold text-[#485550]">{row.summary.gpa}</div>
                                            </div>
                                            <div>
                                                <div className="text-[10px] text-[#485550]/50">CGPA</div>
                                                <div className="font-bold text-[#485550]">{row.summary.cgpa}</div>
                                            </div>
                                        </div>
                                        <div className="mt-2 text-center">
                                            {row.summary.status === 'PROBATION' ? (
                                                <Badge variant="destructive" className="text-[10px]">
                                                    <AlertTriangle className="w-3 h-3 mr-1" /> Probation
                                                </Badge>
                                            ) : (
                                                <Badge variant="outline" className="text-green-600 border-green-200 bg-green-50 text-[10px]">
                                                    <CheckCircle className="w-3 h-3 mr-1" /> Good Standing
                                                </Badge>
                                            )}
                                        </div>
                                    </TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                </div>
            </Card>
        </div>
    );
}
