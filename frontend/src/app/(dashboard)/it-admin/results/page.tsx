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
    ClipboardCheck,
    FileText,
    Calculator,
    CheckCircle2,
    Upload,
    Send,
    Eye,
    Printer,
    Download,
    Search,
    Check,
    X,
    Loader2,
    AlertTriangle,
    GraduationCap,
    Users,
    BarChart3,
    Shield,
    Clock,
    ChevronRight,
    Edit,
    MessageSquare,
} from 'lucide-react';
import { toast } from 'sonner';

// Types
interface Student {
    id: string;
    matricNo: string;
    name: string;
    department: string;
    level: string;
}

interface Course {
    id: string;
    code: string;
    title: string;
    creditUnits: number;
    department: string;
    level: string;
}

interface StudentResult {
    id: string;
    studentId: string;
    matricNo: string;
    studentName: string;
    courseId: string;
    courseCode: string;
    courseTitle: string;
    creditUnits: number;
    caScore: number;
    examScore: number;
    total: number;
    grade: string;
    gradePoint: number;
    semester: string;
    session: string;
    status: 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'PUBLISHED';
}

interface GradeScale {
    grade: string;
    minScore: number;
    maxScore: number;
    gradePoint: number;
    description: string;
}

interface ApprovalRequest {
    id: string;
    courseCode: string;
    courseTitle: string;
    department: string;
    level: string;
    semester: string;
    session: string;
    submittedBy: string;
    submittedDate: string;
    studentCount: number;
    currentStage: string;
    status: 'PENDING' | 'APPROVED' | 'REJECTED';
}

interface PublishedResult {
    id: string;
    semester: string;
    session: string;
    department: string;
    publishedDate: string;
    publishedBy: string;
    courseCount: number;
    studentCount: number;
}

// Mock Data
const mockStudents: Student[] = [
    { id: 's1', matricNo: 'CSC/2021/001', name: 'Adeyemi Johnson', department: 'Computer Science', level: '300' },
    { id: 's2', matricNo: 'CSC/2021/002', name: 'Bello Fatima', department: 'Computer Science', level: '300' },
    { id: 's3', matricNo: 'CSC/2021/003', name: 'Chukwu Emeka', department: 'Computer Science', level: '300' },
    { id: 's4', matricNo: 'CSC/2021/004', name: 'Danjuma Amina', department: 'Computer Science', level: '300' },
    { id: 's5', matricNo: 'CSC/2021/005', name: 'Eze Michael', department: 'Computer Science', level: '300' },
    { id: 's6', matricNo: 'CSC/2021/006', name: 'Femi Williams', department: 'Computer Science', level: '300' },
    { id: 's7', matricNo: 'CSC/2021/007', name: 'Garba Hassan', department: 'Computer Science', level: '300' },
    { id: 's8', matricNo: 'CSC/2021/008', name: 'Ibrahim Khadija', department: 'Computer Science', level: '300' },
];

const mockCourses: Course[] = [
    { id: 'c1', code: 'CSC301', title: 'Data Structures & Algorithms', creditUnits: 3, department: 'Computer Science', level: '300' },
    { id: 'c2', code: 'CSC303', title: 'Operating Systems', creditUnits: 3, department: 'Computer Science', level: '300' },
    { id: 'c3', code: 'CSC305', title: 'Database Systems', creditUnits: 3, department: 'Computer Science', level: '300' },
    { id: 'c4', code: 'CSC307', title: 'Computer Networks', creditUnits: 3, department: 'Computer Science', level: '300' },
    { id: 'c5', code: 'MTH301', title: 'Numerical Analysis', creditUnits: 3, department: 'Mathematics', level: '300' },
];

const defaultGradeScale: GradeScale[] = [
    { grade: 'A', minScore: 70, maxScore: 100, gradePoint: 5.0, description: 'Excellent' },
    { grade: 'B', minScore: 60, maxScore: 69, gradePoint: 4.0, description: 'Very Good' },
    { grade: 'C', minScore: 50, maxScore: 59, gradePoint: 3.0, description: 'Good' },
    { grade: 'D', minScore: 45, maxScore: 49, gradePoint: 2.0, description: 'Fair' },
    { grade: 'E', minScore: 40, maxScore: 44, gradePoint: 1.0, description: 'Pass' },
    { grade: 'F', minScore: 0, maxScore: 39, gradePoint: 0.0, description: 'Fail' },
];

const academicStandings = [
    { classification: 'First Class', minCGPA: 4.50, maxCGPA: 5.00, color: 'bg-green-500' },
    { classification: 'Second Class Upper', minCGPA: 3.50, maxCGPA: 4.49, color: 'bg-blue-500' },
    { classification: 'Second Class Lower', minCGPA: 2.40, maxCGPA: 3.49, color: 'bg-yellow-500' },
    { classification: 'Third Class', minCGPA: 1.50, maxCGPA: 2.39, color: 'bg-orange-500' },
    { classification: 'Pass', minCGPA: 1.00, maxCGPA: 1.49, color: 'bg-gray-500' },
    { classification: 'Probation', minCGPA: 0.00, maxCGPA: 0.99, color: 'bg-red-500' },
];

const mockApprovals: ApprovalRequest[] = [
    { id: 'a1', courseCode: 'CSC301', courseTitle: 'Data Structures', department: 'Computer Science', level: '300', semester: 'First', session: '2024/2025', submittedBy: 'Dr. Adeyemi', submittedDate: '2025-01-10', studentCount: 45, currentStage: 'HOD', status: 'PENDING' },
    { id: 'a2', courseCode: 'CSC303', courseTitle: 'Operating Systems', department: 'Computer Science', level: '300', semester: 'First', session: '2024/2025', submittedBy: 'Prof. Ibrahim', submittedDate: '2025-01-08', studentCount: 42, currentStage: 'Dean', status: 'PENDING' },
    { id: 'a3', courseCode: 'MTH301', courseTitle: 'Numerical Analysis', department: 'Mathematics', level: '300', semester: 'First', session: '2024/2025', submittedBy: 'Mr. Okoro', submittedDate: '2025-01-05', studentCount: 38, currentStage: 'Exam Officer', status: 'APPROVED' },
];

const mockPublished: PublishedResult[] = [
    { id: 'p1', semester: 'Second', session: '2023/2024', department: 'Computer Science', publishedDate: '2024-07-15', publishedBy: 'Exam Officer', courseCount: 12, studentCount: 156 },
    { id: 'p2', semester: 'First', session: '2023/2024', department: 'Computer Science', publishedDate: '2024-02-20', publishedBy: 'Exam Officer', courseCount: 10, studentCount: 148 },
];

export default function Results() {
    const [isLoading, setIsLoading] = useState(true);
    const [activeTab, setActiveTab] = useState('grades');
    const [gradeScale] = useState<GradeScale[]>(defaultGradeScale);
    const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
    const [publishedResults] = useState<PublishedResult[]>(mockPublished);

    // Grade Entry State
    const [selectedCourse, setSelectedCourse] = useState<string>('');
    const [selectedSemester, setSelectedSemester] = useState<string>('First');
    const [selectedSession, setSelectedSession] = useState<string>('2024/2025');
    const [studentGrades, setStudentGrades] = useState<Map<string, { ca: number; exam: number }>>(new Map());

    // Verification State
    const [verifyMatricNo, setVerifyMatricNo] = useState('');
    const [verifiedStudent, setVerifiedStudent] = useState<{ student: Student; results: StudentResult[]; gpa: number; cgpa: number } | null>(null);

    // Dialog State
    const [approvalDialogOpen, setApprovalDialogOpen] = useState(false);
    const [selectedApproval, setSelectedApproval] = useState<ApprovalRequest | null>(null);
    const [approvalComment, setApprovalComment] = useState('');
    const [submitting, setSubmitting] = useState(false);

    useEffect(() => {
        setTimeout(() => {
            setApprovals(mockApprovals);
            // Initialize grades for first course
            const initialGrades = new Map<string, { ca: number; exam: number }>();
            mockStudents.forEach(s => {
                initialGrades.set(s.id, { ca: Math.floor(Math.random() * 20) + 20, exam: Math.floor(Math.random() * 30) + 30 });
            });
            setStudentGrades(initialGrades);
            setSelectedCourse('c1');
            setIsLoading(false);
        }, 500);
    }, []);

    // Calculate grade from score
    const getGradeFromScore = (total: number): { grade: string; gradePoint: number } => {
        for (const scale of gradeScale) {
            if (total >= scale.minScore && total <= scale.maxScore) {
                return { grade: scale.grade, gradePoint: scale.gradePoint };
            }
        }
        return { grade: 'F', gradePoint: 0 };
    };

    // Get class from CGPA
    const getClassFromCGPA = (cgpa: number) => {
        for (const standing of academicStandings) {
            if (cgpa >= standing.minCGPA && cgpa <= standing.maxCGPA) {
                return standing;
            }
        }
        return academicStandings[academicStandings.length - 1];
    };

    // Update student grade
    const handleScoreChange = (studentId: string, field: 'ca' | 'exam', value: string) => {
        const numValue = Math.min(field === 'ca' ? 40 : 60, Math.max(0, parseInt(value) || 0));
        const newGrades = new Map(studentGrades);
        const current = newGrades.get(studentId) || { ca: 0, exam: 0 };
        newGrades.set(studentId, { ...current, [field]: numValue });
        setStudentGrades(newGrades);
    };

    // Submit grades
    const handleSubmitGrades = async () => {
        setSubmitting(true);
        await new Promise(r => setTimeout(r, 1000));
        toast.success('Grades submitted for approval!');
        setSubmitting(false);
    };

    // Handle approval
    const handleApproval = (approval: ApprovalRequest) => {
        setSelectedApproval(approval);
        setApprovalComment('');
        setApprovalDialogOpen(true);
    };

    const handleApprovalAction = async (action: 'approve' | 'reject') => {
        if (!selectedApproval) return;
        setSubmitting(true);
        await new Promise(r => setTimeout(r, 500));

        setApprovals(approvals.map(a =>
            a.id === selectedApproval.id
                ? { ...a, status: action === 'approve' ? 'APPROVED' : 'REJECTED' as const }
                : a
        ));

        toast.success(`Result ${action === 'approve' ? 'approved' : 'rejected'}!`);
        setApprovalDialogOpen(false);
        setSubmitting(false);
    };

    // Verify student
    const handleVerifyStudent = () => {
        const student = mockStudents.find(s => s.matricNo.toLowerCase() === verifyMatricNo.toLowerCase());
        if (!student) {
            toast.error('Student not found');
            setVerifiedStudent(null);
            return;
        }

        // Generate mock results
        const results: StudentResult[] = mockCourses.slice(0, 4).map((course, idx) => {
            const ca = Math.floor(Math.random() * 15) + 25;
            const exam = Math.floor(Math.random() * 20) + 35;
            const total = ca + exam;
            const { grade, gradePoint } = getGradeFromScore(total);
            return {
                id: `r${idx}`,
                studentId: student.id,
                matricNo: student.matricNo,
                studentName: student.name,
                courseId: course.id,
                courseCode: course.code,
                courseTitle: course.title,
                creditUnits: course.creditUnits,
                caScore: ca,
                examScore: exam,
                total,
                grade,
                gradePoint,
                semester: 'First',
                session: '2024/2025',
                status: 'PUBLISHED',
            };
        });

        // Calculate GPA
        const totalQualityPoints = results.reduce((sum, r) => sum + (r.gradePoint * r.creditUnits), 0);
        const totalCreditUnits = results.reduce((sum, r) => sum + r.creditUnits, 0);
        const gpa = totalQualityPoints / totalCreditUnits;
        const cgpa = gpa * 0.95; // Slightly lower for demo

        setVerifiedStudent({ student, results, gpa, cgpa });
        toast.success('Student verified!');
    };

    // Stats
    const stats = {
        totalCourses: mockCourses.length,
        pendingApprovals: approvals.filter(a => a.status === 'PENDING').length,
        publishedResults: publishedResults.length,
        onProbation: 3, // Mock value
    };

    const selectedCourseData = mockCourses.find(c => c.id === selectedCourse);

    if (isLoading) {
        return <div className="flex items-center justify-center h-64"><Loader2 className="h-8 w-8 animate-spin text-[#485550]" /></div>;
    }

    return (
        <div className="space-y-6">
            {/* Header */}
            <div>
                <h1 className="text-3xl font-bold text-[#485550]">Result Processing</h1>
                <p className="text-[#485550]/60 mt-1">Manage grades, compute GPA/CGPA, and publish results</p>
            </div>

            {/* Stats Cards */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <Card className="border-[#F4F6F0]">
                    <CardContent className="p-4">
                        <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-lg bg-[#485550] flex items-center justify-center">
                                <FileText className="w-5 h-5 text-white" />
                            </div>
                            <div>
                                <p className="text-2xl font-bold text-[#485550]">{stats.totalCourses}</p>
                                <p className="text-xs text-[#485550]/60">Courses</p>
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
                                <p className="text-2xl font-bold text-amber-600">{stats.pendingApprovals}</p>
                                <p className="text-xs text-[#485550]/60">Pending</p>
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
                                <p className="text-2xl font-bold text-green-600">{stats.publishedResults}</p>
                                <p className="text-xs text-[#485550]/60">Published</p>
                            </div>
                        </div>
                    </CardContent>
                </Card>
                <Card className="border-[#F4F6F0]">
                    <CardContent className="p-4">
                        <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-lg bg-red-100 flex items-center justify-center">
                                <AlertTriangle className="w-5 h-5 text-red-600" />
                            </div>
                            <div>
                                <p className="text-2xl font-bold text-red-600">{stats.onProbation}</p>
                                <p className="text-xs text-[#485550]/60">Probation</p>
                            </div>
                        </div>
                    </CardContent>
                </Card>
            </div>

            {/* Tabs */}
            <Tabs value={activeTab} onValueChange={setActiveTab}>
                <TabsList className="grid w-full grid-cols-5 bg-[#485550]">
                    <TabsTrigger value="grades" className="text-white data-[state=active]:bg-[#C0EB6A] data-[state=active]:text-[#485550]">
                        <Edit className="w-4 h-4 mr-1" /> Grade Entry
                    </TabsTrigger>
                    <TabsTrigger value="gpa" className="text-white data-[state=active]:bg-[#C0EB6A] data-[state=active]:text-[#485550]">
                        <Calculator className="w-4 h-4 mr-1" /> GPA/CGPA
                    </TabsTrigger>
                    <TabsTrigger value="approval" className="text-white data-[state=active]:bg-[#C0EB6A] data-[state=active]:text-[#485550]">
                        <CheckCircle2 className="w-4 h-4 mr-1" /> Approval
                    </TabsTrigger>
                    <TabsTrigger value="published" className="text-white data-[state=active]:bg-[#C0EB6A] data-[state=active]:text-[#485550]">
                        <Upload className="w-4 h-4 mr-1" /> Published
                    </TabsTrigger>
                    <TabsTrigger value="verify" className="text-white data-[state=active]:bg-[#C0EB6A] data-[state=active]:text-[#485550]">
                        <Shield className="w-4 h-4 mr-1" /> Verify
                    </TabsTrigger>
                </TabsList>

                {/* Grade Entry Tab */}
                <TabsContent value="grades" className="mt-4 space-y-4">
                    {/* Filters */}
                    <Card className="border-[#F4F6F0]">
                        <CardContent className="p-4">
                            <div className="flex flex-wrap items-end gap-4">
                                <div className="space-y-1">
                                    <Label className="text-xs text-[#485550]/60">Session</Label>
                                    <Select value={selectedSession} onValueChange={setSelectedSession}>
                                        <SelectTrigger className="w-[140px] border-[#485550]/20">
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            <SelectItem value="2024/2025">2024/2025</SelectItem>
                                            <SelectItem value="2023/2024">2023/2024</SelectItem>
                                        </SelectContent>
                                    </Select>
                                </div>
                                <div className="space-y-1">
                                    <Label className="text-xs text-[#485550]/60">Semester</Label>
                                    <Select value={selectedSemester} onValueChange={setSelectedSemester}>
                                        <SelectTrigger className="w-[120px] border-[#485550]/20">
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            <SelectItem value="First">First</SelectItem>
                                            <SelectItem value="Second">Second</SelectItem>
                                        </SelectContent>
                                    </Select>
                                </div>
                                <div className="space-y-1 flex-1 min-w-[200px]">
                                    <Label className="text-xs text-[#485550]/60">Course</Label>
                                    <Select value={selectedCourse} onValueChange={setSelectedCourse}>
                                        <SelectTrigger className="border-[#485550]/20">
                                            <SelectValue placeholder="Select course..." />
                                        </SelectTrigger>
                                        <SelectContent>
                                            {mockCourses.map(c => (
                                                <SelectItem key={c.id} value={c.id}>{c.code} - {c.title}</SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                </div>
                                <Button variant="outline" className="border-[#485550]/20">
                                    <Download className="w-4 h-4 mr-2" /> Import CSV
                                </Button>
                            </div>
                        </CardContent>
                    </Card>

                    {/* Grade Table */}
                    {selectedCourseData && (
                        <Card className="border-[#F4F6F0]">
                            <CardHeader className="pb-2">
                                <div className="flex items-center justify-between">
                                    <div>
                                        <CardTitle className="text-[#485550]">{selectedCourseData.code} - {selectedCourseData.title}</CardTitle>
                                        <CardDescription>{selectedCourseData.creditUnits} Credit Units • {mockStudents.length} Students</CardDescription>
                                    </div>
                                    <Button onClick={handleSubmitGrades} disabled={submitting} className="bg-[#485550] hover:bg-[#6b7c6f]">
                                        {submitting ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Send className="w-4 h-4 mr-2" />}
                                        Submit for Approval
                                    </Button>
                                </div>
                            </CardHeader>
                            <CardContent>
                                <div className="overflow-x-auto">
                                    <table className="w-full">
                                        <thead>
                                            <tr className="border-b border-[#F4F6F0]">
                                                <th className="text-left py-3 px-2 text-sm font-medium text-[#485550]/60">S/N</th>
                                                <th className="text-left py-3 px-2 text-sm font-medium text-[#485550]/60">Matric No</th>
                                                <th className="text-left py-3 px-2 text-sm font-medium text-[#485550]/60">Name</th>
                                                <th className="text-center py-3 px-2 text-sm font-medium text-[#485550]/60">CA (40)</th>
                                                <th className="text-center py-3 px-2 text-sm font-medium text-[#485550]/60">Exam (60)</th>
                                                <th className="text-center py-3 px-2 text-sm font-medium text-[#485550]/60">Total</th>
                                                <th className="text-center py-3 px-2 text-sm font-medium text-[#485550]/60">Grade</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {mockStudents.map((student, idx) => {
                                                const grades = studentGrades.get(student.id) || { ca: 0, exam: 0 };
                                                const total = grades.ca + grades.exam;
                                                const { grade, gradePoint } = getGradeFromScore(total);
                                                const gradeColor = grade === 'A' ? 'bg-green-100 text-green-700' :
                                                    grade === 'B' ? 'bg-blue-100 text-blue-700' :
                                                        grade === 'C' ? 'bg-yellow-100 text-yellow-700' :
                                                            grade === 'D' ? 'bg-orange-100 text-orange-700' :
                                                                grade === 'E' ? 'bg-gray-100 text-gray-700' :
                                                                    'bg-red-100 text-red-700';
                                                return (
                                                    <tr key={student.id} className="border-b border-[#F4F6F0]/50 hover:bg-[#F4F6F0]/30">
                                                        <td className="py-3 px-2 text-sm text-[#485550]">{idx + 1}</td>
                                                        <td className="py-3 px-2 text-sm font-mono text-[#485550]">{student.matricNo}</td>
                                                        <td className="py-3 px-2 text-sm text-[#485550] font-medium">{student.name}</td>
                                                        <td className="py-3 px-2">
                                                            <Input
                                                                type="number"
                                                                value={grades.ca}
                                                                onChange={(e) => handleScoreChange(student.id, 'ca', e.target.value)}
                                                                className="w-16 text-center h-8 border-[#485550]/20"
                                                                min={0}
                                                                max={40}
                                                            />
                                                        </td>
                                                        <td className="py-3 px-2">
                                                            <Input
                                                                type="number"
                                                                value={grades.exam}
                                                                onChange={(e) => handleScoreChange(student.id, 'exam', e.target.value)}
                                                                className="w-16 text-center h-8 border-[#485550]/20"
                                                                min={0}
                                                                max={60}
                                                            />
                                                        </td>
                                                        <td className="py-3 px-2 text-center text-sm font-bold text-[#485550]">{total}</td>
                                                        <td className="py-3 px-2 text-center">
                                                            <Badge className={gradeColor}>{grade} ({gradePoint.toFixed(1)})</Badge>
                                                        </td>
                                                    </tr>
                                                );
                                            })}
                                        </tbody>
                                    </table>
                                </div>
                            </CardContent>
                        </Card>
                    )}
                </TabsContent>

                {/* GPA/CGPA Tab */}
                <TabsContent value="gpa" className="mt-4 space-y-4">
                    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                        {/* Grade Scale */}
                        <Card className="border-[#F4F6F0]">
                            <CardHeader>
                                <CardTitle className="text-[#485550] text-base">Grade Point Scale</CardTitle>
                            </CardHeader>
                            <CardContent>
                                <div className="space-y-2">
                                    {gradeScale.map(scale => (
                                        <div key={scale.grade} className="flex items-center justify-between p-2 bg-[#F4F6F0]/50 rounded">
                                            <div className="flex items-center gap-2">
                                                <Badge className={
                                                    scale.grade === 'A' ? 'bg-green-500' :
                                                        scale.grade === 'B' ? 'bg-blue-500' :
                                                            scale.grade === 'C' ? 'bg-yellow-500' :
                                                                scale.grade === 'D' ? 'bg-orange-500' :
                                                                    scale.grade === 'E' ? 'bg-gray-500' :
                                                                        'bg-red-500'
                                                }>{scale.grade}</Badge>
                                                <span className="text-sm text-[#485550]">{scale.minScore}-{scale.maxScore}</span>
                                            </div>
                                            <span className="font-bold text-[#485550]">{scale.gradePoint.toFixed(1)}</span>
                                        </div>
                                    ))}
                                </div>
                            </CardContent>
                        </Card>

                        {/* Academic Standing */}
                        <Card className="border-[#F4F6F0]">
                            <CardHeader>
                                <CardTitle className="text-[#485550] text-base">Academic Standing</CardTitle>
                            </CardHeader>
                            <CardContent>
                                <div className="space-y-2">
                                    {academicStandings.map(standing => (
                                        <div key={standing.classification} className="flex items-center justify-between p-2 bg-[#F4F6F0]/50 rounded">
                                            <span className="text-sm text-[#485550]">{standing.classification}</span>
                                            <Badge className={standing.color}>{standing.minCGPA.toFixed(2)} - {standing.maxCGPA.toFixed(2)}</Badge>
                                        </div>
                                    ))}
                                </div>
                            </CardContent>
                        </Card>

                        {/* GPA Calculator */}
                        <Card className="border-[#F4F6F0]">
                            <CardHeader>
                                <CardTitle className="text-[#485550] text-base">GPA Formula</CardTitle>
                            </CardHeader>
                            <CardContent className="space-y-4">
                                <div className="p-4 bg-[#485550] text-white rounded-lg text-center">
                                    <p className="text-xs opacity-70 mb-2">Grade Point Average</p>
                                    <p className="text-lg font-mono">GPA = Σ(GP × CU) / Σ(CU)</p>
                                </div>
                                <div className="text-sm text-[#485550]/70 space-y-1">
                                    <p>• GP = Grade Point (0-5)</p>
                                    <p>• CU = Credit Units</p>
                                    <p>• CGPA = Cumulative GPA across all semesters</p>
                                </div>
                            </CardContent>
                        </Card>
                    </div>

                    {/* Sample Student Results */}
                    <Card className="border-[#F4F6F0]">
                        <CardHeader>
                            <CardTitle className="text-[#485550]">Sample GPA Calculation</CardTitle>
                            <CardDescription>Showing computed GPA for sample students</CardDescription>
                        </CardHeader>
                        <CardContent>
                            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                                {mockStudents.slice(0, 6).map(student => {
                                    const gpa = 3.2 + Math.random() * 1.5;
                                    const standing = getClassFromCGPA(gpa);
                                    return (
                                        <div key={student.id} className="p-4 bg-[#F4F6F0]/50 rounded-lg">
                                            <div className="flex items-center gap-3 mb-3">
                                                <div className="w-10 h-10 rounded-full bg-[#485550] flex items-center justify-center text-white font-bold text-sm">
                                                    {student.name.split(' ').map(n => n[0]).join('')}
                                                </div>
                                                <div>
                                                    <p className="font-medium text-[#485550]">{student.name}</p>
                                                    <p className="text-xs text-[#485550]/60">{student.matricNo}</p>
                                                </div>
                                            </div>
                                            <div className="flex items-center justify-between">
                                                <div>
                                                    <p className="text-xs text-[#485550]/60">CGPA</p>
                                                    <p className="text-2xl font-bold text-[#485550]">{gpa.toFixed(2)}</p>
                                                </div>
                                                <Badge className={standing.color}>{standing.classification}</Badge>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        </CardContent>
                    </Card>
                </TabsContent>

                {/* Approval Tab */}
                <TabsContent value="approval" className="mt-4 space-y-4">
                    <Card className="border-[#F4F6F0]">
                        <CardHeader>
                            <CardTitle className="text-[#485550]">Pending Approvals</CardTitle>
                            <CardDescription>Results awaiting approval at various stages</CardDescription>
                        </CardHeader>
                        <CardContent>
                            <div className="space-y-3">
                                {approvals.map(approval => (
                                    <div key={approval.id} className={`p-4 rounded-lg border ${approval.status === 'PENDING' ? 'border-amber-200 bg-amber-50/50' : approval.status === 'APPROVED' ? 'border-green-200 bg-green-50/50' : 'border-red-200 bg-red-50/50'}`}>
                                        <div className="flex items-center justify-between">
                                            <div className="flex-1">
                                                <div className="flex items-center gap-2 mb-1">
                                                    <span className="font-bold text-[#485550]">{approval.courseCode}</span>
                                                    <span className="text-sm text-[#485550]/70">{approval.courseTitle}</span>
                                                    <Badge variant="outline" className="ml-2">{approval.studentCount} students</Badge>
                                                </div>
                                                <div className="flex items-center gap-4 text-xs text-[#485550]/60">
                                                    <span>{approval.department}</span>
                                                    <span>•</span>
                                                    <span>{approval.level} Level</span>
                                                    <span>•</span>
                                                    <span>{approval.semester} Semester {approval.session}</span>
                                                </div>
                                                <div className="flex items-center gap-2 mt-2">
                                                    <span className="text-xs text-[#485550]/60">Submitted by {approval.submittedBy} on {approval.submittedDate}</span>
                                                </div>
                                            </div>
                                            <div className="flex items-center gap-3">
                                                {/* Approval Flow */}
                                                <div className="flex items-center gap-1 text-xs">
                                                    <Badge variant="outline" className={approval.currentStage === 'HOD' ? 'border-blue-500 text-blue-600' : approval.currentStage === 'Dean' || approval.currentStage === 'Exam Officer' ? 'bg-green-100 text-green-700' : ''}>HOD</Badge>
                                                    <ChevronRight className="w-3 h-3 text-[#485550]/30" />
                                                    <Badge variant="outline" className={approval.currentStage === 'Dean' ? 'border-blue-500 text-blue-600' : approval.currentStage === 'Exam Officer' ? 'bg-green-100 text-green-700' : ''}>Dean</Badge>
                                                    <ChevronRight className="w-3 h-3 text-[#485550]/30" />
                                                    <Badge variant="outline" className={approval.currentStage === 'Exam Officer' ? 'border-blue-500 text-blue-600' : ''}>EO</Badge>
                                                </div>

                                                {approval.status === 'PENDING' ? (
                                                    <Button size="sm" onClick={() => handleApproval(approval)} className="bg-[#485550] hover:bg-[#6b7c6f]">
                                                        Review
                                                    </Button>
                                                ) : (
                                                    <Badge className={approval.status === 'APPROVED' ? 'bg-green-500' : 'bg-red-500'}>
                                                        {approval.status}
                                                    </Badge>
                                                )}
                                            </div>
                                        </div>
                                    </div>
                                ))}

                                {approvals.length === 0 && (
                                    <div className="text-center py-12 text-[#485550]/60">
                                        <CheckCircle2 className="w-12 h-12 mx-auto mb-2 opacity-30" />
                                        <p>No pending approvals</p>
                                    </div>
                                )}
                            </div>
                        </CardContent>
                    </Card>
                </TabsContent>

                {/* Published Results Tab */}
                <TabsContent value="published" className="mt-4 space-y-4">
                    <Card className="border-[#F4F6F0]">
                        <CardHeader>
                            <div className="flex items-center justify-between">
                                <div>
                                    <CardTitle className="text-[#485550]">Published Results</CardTitle>
                                    <CardDescription>Results that have been published and are visible to students</CardDescription>
                                </div>
                                <Button className="bg-[#485550] hover:bg-[#6b7c6f]">
                                    <Upload className="w-4 h-4 mr-2" /> Publish Approved
                                </Button>
                            </div>
                        </CardHeader>
                        <CardContent>
                            <div className="space-y-3">
                                {publishedResults.map(result => (
                                    <div key={result.id} className="p-4 bg-[#F4F6F0]/50 rounded-lg flex items-center justify-between">
                                        <div>
                                            <div className="flex items-center gap-2 mb-1">
                                                <Badge className="bg-green-500">{result.semester} Semester</Badge>
                                                <span className="font-bold text-[#485550]">{result.session}</span>
                                            </div>
                                            <div className="text-sm text-[#485550]/60">
                                                {result.department} • {result.courseCount} courses • {result.studentCount} students
                                            </div>
                                            <div className="text-xs text-[#485550]/50 mt-1">
                                                Published on {result.publishedDate} by {result.publishedBy}
                                            </div>
                                        </div>
                                        <div className="flex gap-2">
                                            <Button size="sm" variant="outline" className="border-[#485550]/20">
                                                <Eye className="w-4 h-4 mr-1" /> View
                                            </Button>
                                            <Button size="sm" variant="outline" className="border-[#485550]/20">
                                                <Download className="w-4 h-4 mr-1" /> Export
                                            </Button>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </CardContent>
                    </Card>
                </TabsContent>

                {/* Verification Tab */}
                <TabsContent value="verify" className="mt-4 space-y-4">
                    <Card className="border-[#F4F6F0]">
                        <CardHeader>
                            <CardTitle className="text-[#485550]">Result Verification</CardTitle>
                            <CardDescription>Verify student results and generate result slips</CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-6">
                            {/* Search */}
                            <div className="flex gap-4 max-w-xl">
                                <div className="flex-1 relative">
                                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#485550]/40" />
                                    <Input
                                        placeholder="Enter Matriculation Number (e.g., CSC/2021/001)"
                                        value={verifyMatricNo}
                                        onChange={(e) => setVerifyMatricNo(e.target.value)}
                                        onKeyDown={(e) => e.key === 'Enter' && handleVerifyStudent()}
                                        className="pl-10 border-[#485550]/20"
                                    />
                                </div>
                                <Button onClick={handleVerifyStudent} className="bg-[#485550] hover:bg-[#6b7c6f]">
                                    <Shield className="w-4 h-4 mr-2" /> Verify
                                </Button>
                            </div>

                            {/* Verified Result */}
                            {verifiedStudent && (
                                <div className="border border-[#485550]/20 rounded-lg overflow-hidden">
                                    {/* Header */}
                                    <div className="bg-[#485550] text-white p-6 text-center">
                                        <GraduationCap className="w-12 h-12 mx-auto mb-2" />
                                        <h3 className="text-xl font-bold">UniVarse University</h3>
                                        <p className="text-sm opacity-70">Official Result Statement</p>
                                    </div>

                                    {/* Student Info */}
                                    <div className="p-6 bg-[#F4F6F0]/50">
                                        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
                                            <div>
                                                <p className="text-xs text-[#485550]/60">Name</p>
                                                <p className="font-bold text-[#485550]">{verifiedStudent.student.name}</p>
                                            </div>
                                            <div>
                                                <p className="text-xs text-[#485550]/60">Matric No</p>
                                                <p className="font-mono text-[#485550]">{verifiedStudent.student.matricNo}</p>
                                            </div>
                                            <div>
                                                <p className="text-xs text-[#485550]/60">Department</p>
                                                <p className="text-[#485550]">{verifiedStudent.student.department}</p>
                                            </div>
                                            <div>
                                                <p className="text-xs text-[#485550]/60">Level</p>
                                                <p className="text-[#485550]">{verifiedStudent.student.level}</p>
                                            </div>
                                        </div>
                                    </div>

                                    {/* Results Table */}
                                    <div className="p-6">
                                        <table className="w-full mb-6">
                                            <thead>
                                                <tr className="border-b-2 border-[#485550]">
                                                    <th className="text-left py-2 text-sm font-bold text-[#485550]">Course Code</th>
                                                    <th className="text-left py-2 text-sm font-bold text-[#485550]">Course Title</th>
                                                    <th className="text-center py-2 text-sm font-bold text-[#485550]">Units</th>
                                                    <th className="text-center py-2 text-sm font-bold text-[#485550]">Grade</th>
                                                    <th className="text-center py-2 text-sm font-bold text-[#485550]">GP</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {verifiedStudent.results.map(result => (
                                                    <tr key={result.id} className="border-b border-[#F4F6F0]">
                                                        <td className="py-2 text-sm font-mono text-[#485550]">{result.courseCode}</td>
                                                        <td className="py-2 text-sm text-[#485550]">{result.courseTitle}</td>
                                                        <td className="py-2 text-sm text-center text-[#485550]">{result.creditUnits}</td>
                                                        <td className="py-2 text-sm text-center font-bold text-[#485550]">{result.grade}</td>
                                                        <td className="py-2 text-sm text-center text-[#485550]">{result.gradePoint.toFixed(1)}</td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>

                                        {/* Summary */}
                                        <div className="flex items-center justify-between p-4 bg-[#485550] text-white rounded-lg">
                                            <div>
                                                <p className="text-xs opacity-70">Semester GPA</p>
                                                <p className="text-2xl font-bold">{verifiedStudent.gpa.toFixed(2)}</p>
                                            </div>
                                            <div>
                                                <p className="text-xs opacity-70">Cumulative GPA</p>
                                                <p className="text-2xl font-bold">{verifiedStudent.cgpa.toFixed(2)}</p>
                                            </div>
                                            <div>
                                                <p className="text-xs opacity-70">Standing</p>
                                                <Badge className={getClassFromCGPA(verifiedStudent.cgpa).color}>
                                                    {getClassFromCGPA(verifiedStudent.cgpa).classification}
                                                </Badge>
                                            </div>
                                            <Button variant="outline" className="border-white text-white hover:bg-white/10">
                                                <Printer className="w-4 h-4 mr-2" /> Print
                                            </Button>
                                        </div>
                                    </div>

                                    {/* Verification Stamp */}
                                    <div className="p-4 bg-green-50 border-t border-green-200 flex items-center justify-center gap-2">
                                        <CheckCircle2 className="w-5 h-5 text-green-600" />
                                        <span className="text-green-700 font-medium">Verified Authentic</span>
                                        <span className="text-green-600 text-sm">• Generated on {new Date().toLocaleDateString()}</span>
                                    </div>
                                </div>
                            )}

                            {!verifiedStudent && (
                                <div className="text-center py-12 text-[#485550]/60">
                                    <Shield className="w-16 h-16 mx-auto mb-4 opacity-30" />
                                    <p>Enter a matriculation number to verify student results</p>
                                    <p className="text-sm mt-1">Try: CSC/2021/001</p>
                                </div>
                            )}
                        </CardContent>
                    </Card>
                </TabsContent>
            </Tabs>

            {/* Approval Dialog */}
            <Dialog open={approvalDialogOpen} onOpenChange={setApprovalDialogOpen}>
                <DialogContent className="max-w-md">
                    <DialogHeader>
                        <DialogTitle className="text-[#485550]">Review Result</DialogTitle>
                        <DialogDescription>
                            {selectedApproval?.courseCode} - {selectedApproval?.courseTitle}
                        </DialogDescription>
                    </DialogHeader>
                    <div className="space-y-4 py-4">
                        <div className="p-4 bg-[#F4F6F0] rounded-lg space-y-2">
                            <div className="flex justify-between text-sm">
                                <span className="text-[#485550]/60">Department</span>
                                <span className="text-[#485550]">{selectedApproval?.department}</span>
                            </div>
                            <div className="flex justify-between text-sm">
                                <span className="text-[#485550]/60">Level</span>
                                <span className="text-[#485550]">{selectedApproval?.level}</span>
                            </div>
                            <div className="flex justify-between text-sm">
                                <span className="text-[#485550]/60">Students</span>
                                <span className="text-[#485550]">{selectedApproval?.studentCount}</span>
                            </div>
                            <div className="flex justify-between text-sm">
                                <span className="text-[#485550]/60">Current Stage</span>
                                <Badge variant="outline">{selectedApproval?.currentStage}</Badge>
                            </div>
                        </div>
                        <div className="space-y-2">
                            <Label>Comment (Optional)</Label>
                            <Input
                                value={approvalComment}
                                onChange={(e) => setApprovalComment(e.target.value)}
                                placeholder="Add a comment..."
                                className="border-[#485550]/20"
                            />
                        </div>
                    </div>
                    <DialogFooter className="gap-2">
                        <Button variant="outline" onClick={() => handleApprovalAction('reject')} disabled={submitting} className="border-red-500 text-red-600 hover:bg-red-50">
                            <X className="w-4 h-4 mr-1" /> Reject
                        </Button>
                        <Button onClick={() => handleApprovalAction('approve')} disabled={submitting} className="bg-green-600 hover:bg-green-700">
                            {submitting ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : <Check className="w-4 h-4 mr-1" />}
                            Approve
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}
