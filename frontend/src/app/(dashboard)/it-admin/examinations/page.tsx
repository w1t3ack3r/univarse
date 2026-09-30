'use client';

import { useState, useEffect, DragEvent } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import {
    Calendar,
    Building2,
    Users,
    FileText,
    CreditCard,
    Plus,
    Edit,
    Trash2,
    GripVertical,
    Clock,
    MapPin,
    User,
    Printer,
    Download,
    Check,
    X,
    Loader2,
    Search,
    ChevronLeft,
    ChevronRight,
    CalendarPlus,
    Maximize2,
    Minimize2,
} from 'lucide-react';
import { toast } from 'sonner';

// Types
interface Course {
    id: string;
    code: string;
    title: string;
    department: string;
    level: string;
    creditUnits: number;
    students: number;
}

interface Venue {
    id: string;
    name: string;
    capacity: number;
    type: 'HALL' | 'LAB' | 'CLASSROOM';
    isAvailable: boolean;
}

interface ExamWeek {
    id: string;
    name: string;
    days: ExamDay[];
}

interface ExamDay {
    id: string;
    name: string; // Sunday, Monday, etc.
    date?: string;
}

interface ExamSchedule {
    id: string;
    courseId: string;
    courseCode: string;
    courseTitle: string;
    venueId: string;
    venueName: string;
    weekId: string;
    dayId: string;
    startTime: string; // "08:00"
    endTime: string;   // "10:00"
    invigilators: string[];
    status: 'SCHEDULED' | 'ONGOING' | 'COMPLETED' | 'CANCELLED';
}

interface Invigilator {
    id: string;
    name: string;
    department: string;
    email: string;
    assignedExams: number;
}

// Mock Data
const mockCourses: Course[] = [
    { id: 'c1', code: 'CSC301', title: 'Data Structures', department: 'Computer Science', level: '300', creditUnits: 3, students: 120 },
    { id: 'c2', code: 'CSC201', title: 'Programming II', department: 'Computer Science', level: '200', creditUnits: 3, students: 150 },
    { id: 'c3', code: 'MTH201', title: 'Mathematical Methods', department: 'Mathematics', level: '200', creditUnits: 3, students: 200 },
    { id: 'c4', code: 'PHY101', title: 'General Physics I', department: 'Physics', level: '100', creditUnits: 4, students: 300 },
    { id: 'c5', code: 'CHM101', title: 'General Chemistry I', department: 'Chemistry', level: '100', creditUnits: 4, students: 280 },
    { id: 'c6', code: 'ACC301', title: 'Financial Accounting', department: 'Accounting', level: '300', creditUnits: 3, students: 100 },
    { id: 'c7', code: 'ENG201', title: 'Engineering Maths', department: 'Engineering', level: '200', creditUnits: 3, students: 180 },
    { id: 'c8', code: 'LAW301', title: 'Constitutional Law', department: 'Law', level: '300', creditUnits: 4, students: 90 },
    { id: 'c9', code: 'MED201', title: 'Anatomy I', department: 'Medicine', level: '200', creditUnits: 5, students: 80 },
    { id: 'c10', code: 'CYB301', title: 'Network Security', department: 'Cyber Security', level: '300', creditUnits: 3, students: 60 },
];

const mockVenues: Venue[] = [
    { id: 'v1', name: 'Main Hall A', capacity: 500, type: 'HALL', isAvailable: true },
    { id: 'v2', name: 'Main Hall B', capacity: 400, type: 'HALL', isAvailable: true },
    { id: 'v3', name: 'CBT Center', capacity: 200, type: 'LAB', isAvailable: true },
    { id: 'v4', name: 'Lecture Theatre 1', capacity: 300, type: 'CLASSROOM', isAvailable: true },
    { id: 'v5', name: 'Lecture Theatre 2', capacity: 250, type: 'CLASSROOM', isAvailable: true },
];

const mockInvigilators: Invigilator[] = [
    { id: 'i1', name: 'Dr. Adeyemi', department: 'Computer Science', email: 'adeyemi@uni.edu.ng', assignedExams: 2 },
    { id: 'i2', name: 'Prof. Ibrahim', department: 'Physics', email: 'ibrahim@uni.edu.ng', assignedExams: 1 },
    { id: 'i3', name: 'Mr. Okoro', department: 'Mathematics', email: 'okoro@uni.edu.ng', assignedExams: 1 },
    { id: 'i4', name: 'Dr. Nwosu', department: 'Chemistry', email: 'nwosu@uni.edu.ng', assignedExams: 1 },
    { id: 'i5', name: 'Mrs. Bello', department: 'Accounting', email: 'bello@uni.edu.ng', assignedExams: 0 },
];

const allDaysOfWeek = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const timeHours = ['06', '07', '08', '09', '10', '11', '12', '13', '14', '15', '16', '17', '18', '19', '20'];

// Color palette for exams
const examColors = [
    'bg-blue-500', 'bg-green-500', 'bg-purple-500', 'bg-amber-500', 'bg-rose-500',
    'bg-cyan-500', 'bg-indigo-500', 'bg-teal-500', 'bg-orange-500', 'bg-pink-500',
];

export default function Examinations() {
    const [isLoading, setIsLoading] = useState(true);
    const [activeTab, setActiveTab] = useState('timetable');
    const [courses] = useState<Course[]>(mockCourses);
    const [venues, setVenues] = useState<Venue[]>([]);
    const [schedules, setSchedules] = useState<ExamSchedule[]>([]);
    const [invigilators] = useState<Invigilator[]>(mockInvigilators);
    const [searchTerm, setSearchTerm] = useState('');
    const [departmentFilter, setDepartmentFilter] = useState('all');

    // Week management
    const [weeks, setWeeks] = useState<ExamWeek[]>([
        {
            id: 'w1', name: 'Week 1', days: [
                { id: 'd1', name: 'Monday' },
                { id: 'd2', name: 'Tuesday' },
                { id: 'd3', name: 'Wednesday' },
                { id: 'd4', name: 'Thursday' },
                { id: 'd5', name: 'Friday' },
            ]
        },
    ]);
    const [activeWeekId, setActiveWeekId] = useState('w1');

    // Dialog states
    const [venueDialogOpen, setVenueDialogOpen] = useState(false);
    const [editingVenue, setEditingVenue] = useState<Venue | null>(null);
    const [venueForm, setVenueForm] = useState({ name: '', capacity: '', type: 'HALL' });
    const [scheduleDialogOpen, setScheduleDialogOpen] = useState(false);
    const [pendingSchedule, setPendingSchedule] = useState<{ course: Course; dayId: string } | null>(null);
    const [scheduleForm, setScheduleForm] = useState({ startTime: '09:00', endTime: '11:00', venueId: '' });
    const [selectedExam, setSelectedExam] = useState<ExamSchedule | null>(null);
    const [editExamDialogOpen, setEditExamDialogOpen] = useState(false);
    const [editExamForm, setEditExamForm] = useState({ startTime: '', endTime: '', venueId: '' });
    const [addDayDialogOpen, setAddDayDialogOpen] = useState(false);
    const [newDayName, setNewDayName] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [draggedCourse, setDraggedCourse] = useState<Course | null>(null);
    const [isFullscreen, setIsFullscreen] = useState(false);

    useEffect(() => {
        setTimeout(() => {
            setVenues(mockVenues);
            // Sample schedules
            setSchedules([
                { id: 's1', courseId: 'c1', courseCode: 'CSC301', courseTitle: 'Data Structures', venueId: 'v1', venueName: 'Main Hall A', weekId: 'w1', dayId: 'd1', startTime: '08:00', endTime: '10:00', invigilators: ['Dr. Adeyemi'], status: 'SCHEDULED' },
                { id: 's2', courseId: 'c4', courseCode: 'PHY101', courseTitle: 'General Physics I', venueId: 'v2', venueName: 'Main Hall B', weekId: 'w1', dayId: 'd1', startTime: '09:00', endTime: '11:00', invigilators: ['Prof. Ibrahim'], status: 'SCHEDULED' },
                { id: 's3', courseId: 'c3', courseCode: 'MTH201', courseTitle: 'Mathematical Methods', venueId: 'v1', venueName: 'Main Hall A', weekId: 'w1', dayId: 'd2', startTime: '14:00', endTime: '16:00', invigilators: [], status: 'SCHEDULED' },
            ]);
            setIsLoading(false);
        }, 500);
    }, []);

    const activeWeek = weeks.find(w => w.id === activeWeekId) || weeks[0];

    // Get unscheduled courses
    const scheduledCourseIds = schedules.map(s => s.courseId);
    const unscheduledCourses = courses.filter(c => !scheduledCourseIds.includes(c.id));

    // Filtered unscheduled courses
    const filteredUnscheduled = unscheduledCourses.filter(c => {
        const matchesSearch = c.code.toLowerCase().includes(searchTerm.toLowerCase()) ||
            c.title.toLowerCase().includes(searchTerm.toLowerCase());
        const matchesDept = departmentFilter === 'all' || c.department === departmentFilter;
        return matchesSearch && matchesDept;
    });

    // Stats
    const stats = {
        totalCourses: courses.length,
        scheduled: schedules.length,
        unscheduled: unscheduledCourses.length,
        venues: venues.filter(v => v.isAvailable).length,
        invigilators: invigilators.length,
    };

    const departments = [...new Set(courses.map(c => c.department))];

    // Drag handlers
    const handleDragStart = (e: DragEvent, course: Course) => {
        setDraggedCourse(course);
        e.dataTransfer.effectAllowed = 'move';
    };

    const handleDragOver = (e: DragEvent) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
    };

    const handleDrop = (e: DragEvent, dayId: string) => {
        e.preventDefault();
        if (!draggedCourse) return;

        // Open dialog to set time and venue
        setPendingSchedule({ course: draggedCourse, dayId });
        setScheduleForm({ startTime: '09:00', endTime: '11:00', venueId: venues[0]?.id || '' });
        setScheduleDialogOpen(true);
        setDraggedCourse(null);
    };

    const handleConfirmSchedule = () => {
        if (!pendingSchedule || !scheduleForm.venueId) {
            toast.error('Please select a venue');
            return;
        }

        const venue = venues.find(v => v.id === scheduleForm.venueId);
        const newSchedule: ExamSchedule = {
            id: `s${Date.now()}`,
            courseId: pendingSchedule.course.id,
            courseCode: pendingSchedule.course.code,
            courseTitle: pendingSchedule.course.title,
            venueId: scheduleForm.venueId,
            venueName: venue?.name || '',
            weekId: activeWeekId,
            dayId: pendingSchedule.dayId,
            startTime: scheduleForm.startTime,
            endTime: scheduleForm.endTime,
            invigilators: [],
            status: 'SCHEDULED',
        };

        setSchedules([...schedules, newSchedule]);
        toast.success(`${pendingSchedule.course.code} scheduled for ${scheduleForm.startTime} - ${scheduleForm.endTime}`);
        setScheduleDialogOpen(false);
        setPendingSchedule(null);
    };

    const handleRemoveSchedule = (scheduleId: string) => {
        setSchedules(schedules.filter(s => s.id !== scheduleId));
        toast.success('Exam removed from schedule');
    };

    // Week/Day management
    const handleAddWeek = () => {
        const newWeek: ExamWeek = {
            id: `w${Date.now()}`,
            name: `Week ${weeks.length + 1}`,
            days: [
                { id: `d${Date.now()}1`, name: 'Monday' },
                { id: `d${Date.now()}2`, name: 'Tuesday' },
                { id: `d${Date.now()}3`, name: 'Wednesday' },
                { id: `d${Date.now()}4`, name: 'Thursday' },
                { id: `d${Date.now()}5`, name: 'Friday' },
            ],
        };
        setWeeks([...weeks, newWeek]);
        setActiveWeekId(newWeek.id);
        toast.success(`${newWeek.name} added`);
    };

    const handleAddDay = () => {
        if (!newDayName) {
            toast.error('Please select a day');
            return;
        }

        // Check if day already exists
        if (activeWeek.days.some(d => d.name === newDayName)) {
            toast.error(`${newDayName} already exists in this week`);
            return;
        }

        const newDay: ExamDay = { id: `d${Date.now()}`, name: newDayName };
        setWeeks(weeks.map(w =>
            w.id === activeWeekId
                ? { ...w, days: [...w.days, newDay].sort((a, b) => allDaysOfWeek.indexOf(a.name) - allDaysOfWeek.indexOf(b.name)) }
                : w
        ));
        setAddDayDialogOpen(false);
        setNewDayName('');
        toast.success(`${newDayName} added to ${activeWeek.name}`);
    };

    const handleRemoveDay = (dayId: string) => {
        if (activeWeek.days.length <= 1) {
            toast.error('Week must have at least one day');
            return;
        }
        // Remove schedules for this day
        setSchedules(schedules.filter(s => !(s.weekId === activeWeekId && s.dayId === dayId)));
        setWeeks(weeks.map(w =>
            w.id === activeWeekId
                ? { ...w, days: w.days.filter(d => d.id !== dayId) }
                : w
        ));
        toast.success('Day removed');
    };

    // Get exams for a specific day
    const getExamsForDay = (dayId: string) => {
        return schedules.filter(s => s.weekId === activeWeekId && s.dayId === dayId);
    };

    // Calculate position and width for exam block
    const getExamStyle = (exam: ExamSchedule) => {
        const startHour = parseInt(exam.startTime.split(':')[0]);
        const startMin = parseInt(exam.startTime.split(':')[1]) || 0;
        const endHour = parseInt(exam.endTime.split(':')[0]);
        const endMin = parseInt(exam.endTime.split(':')[1]) || 0;

        const startOffset = (startHour - 6) * 60 + startMin; // Minutes from 6AM
        const duration = (endHour - startHour) * 60 + (endMin - startMin);
        const totalMinutes = 15 * 60; // 6AM to 9PM = 15 hours

        const left = (startOffset / totalMinutes) * 100;
        const width = (duration / totalMinutes) * 100;

        return { left: `${left}%`, width: `${width}%` };
    };

    // Get color for course (consistent)
    const getCourseColor = (courseId: string) => {
        const index = courses.findIndex(c => c.id === courseId);
        return examColors[index % examColors.length];
    };

    // Venue handlers
    const handleCreateVenue = () => {
        setEditingVenue(null);
        setVenueForm({ name: '', capacity: '', type: 'HALL' });
        setVenueDialogOpen(true);
    };

    const handleEditVenue = (venue: Venue) => {
        setEditingVenue(venue);
        setVenueForm({ name: venue.name, capacity: venue.capacity.toString(), type: venue.type });
        setVenueDialogOpen(true);
    };

    const handleSaveVenue = async () => {
        if (!venueForm.name || !venueForm.capacity) {
            toast.error('Please fill in required fields');
            return;
        }
        setSubmitting(true);
        await new Promise(r => setTimeout(r, 500));

        if (editingVenue) {
            setVenues(venues.map(v => v.id === editingVenue.id ? { ...v, name: venueForm.name, capacity: parseInt(venueForm.capacity), type: venueForm.type as 'HALL' | 'LAB' | 'CLASSROOM' } : v));
            toast.success('Venue updated!');
        } else {
            const newVenue: Venue = {
                id: `v${Date.now()}`,
                name: venueForm.name,
                capacity: parseInt(venueForm.capacity),
                type: venueForm.type as 'HALL' | 'LAB' | 'CLASSROOM',
                isAvailable: true
            };
            setVenues([...venues, newVenue]);
            toast.success('Venue created!');
        }
        setVenueDialogOpen(false);
        setSubmitting(false);
    };

    const handleDeleteVenue = (venueId: string) => {
        if (!confirm('Delete this venue?')) return;
        setVenues(venues.filter(v => v.id !== venueId));
        toast.success('Venue deleted');
    };

    const handleEditExam = (exam: ExamSchedule) => {
        setSelectedExam(exam);
        setEditExamForm({ startTime: exam.startTime, endTime: exam.endTime, venueId: exam.venueId });
        setEditExamDialogOpen(true);
    };

    const handleSaveExamChanges = () => {
        if (!selectedExam || !editExamForm.venueId) {
            toast.error('Please select a venue');
            return;
        }
        const venue = venues.find(v => v.id === editExamForm.venueId);
        const updatedExam = {
            ...selectedExam,
            startTime: editExamForm.startTime,
            endTime: editExamForm.endTime,
            venueId: editExamForm.venueId,
            venueName: venue?.name || selectedExam.venueName
        };
        setSchedules(schedules.map(s => s.id === selectedExam.id ? updatedExam : s));
        setSelectedExam(updatedExam);
        toast.success('Exam updated!');
    };

    const handleAddInvigilatorToExam = (invigilatorName: string) => {
        if (!selectedExam) return;
        if (selectedExam.invigilators.includes(invigilatorName)) {
            toast.error('Already assigned');
            return;
        }
        setSchedules(schedules.map(s =>
            s.id === selectedExam.id
                ? { ...s, invigilators: [...s.invigilators, invigilatorName] }
                : s
        ));
        setSelectedExam({ ...selectedExam, invigilators: [...selectedExam.invigilators, invigilatorName] });
        toast.success(`${invigilatorName} assigned`);
    };

    const handleRemoveInvigilatorFromExam = (invigilatorName: string) => {
        if (!selectedExam) return;
        setSchedules(schedules.map(s =>
            s.id === selectedExam.id
                ? { ...s, invigilators: s.invigilators.filter(i => i !== invigilatorName) }
                : s
        ));
        setSelectedExam({ ...selectedExam, invigilators: selectedExam.invigilators.filter(i => i !== invigilatorName) });
        toast.success(`${invigilatorName} removed`);
    };

    const getVenueTypeBadge = (type: string) => {
        const colors: Record<string, string> = {
            HALL: 'bg-blue-100 text-blue-700',
            LAB: 'bg-purple-100 text-purple-700',
            CLASSROOM: 'bg-green-100 text-green-700',
        };
        return <Badge className={colors[type]}>{type}</Badge>;
    };

    if (isLoading) {
        return <div className="flex items-center justify-center h-64"><Loader2 className="h-8 w-8 animate-spin text-[#485550]" /></div>;
    }

    return (
        <div className="space-y-6">
            {/* Header */}
            <div>
                <h1 className="text-3xl font-bold text-[#485550]">Examinations</h1>
                <p className="text-[#485550]/60 mt-1">Schedule exams, manage venues, and assign invigilators</p>
            </div>

            {/* Stats Cards */}
            <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
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
                            <div className="w-10 h-10 rounded-lg bg-green-100 flex items-center justify-center">
                                <Check className="w-5 h-5 text-green-600" />
                            </div>
                            <div>
                                <p className="text-2xl font-bold text-green-600">{stats.scheduled}</p>
                                <p className="text-xs text-[#485550]/60">Scheduled</p>
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
                                <p className="text-2xl font-bold text-amber-600">{stats.unscheduled}</p>
                                <p className="text-xs text-[#485550]/60">Pending</p>
                            </div>
                        </div>
                    </CardContent>
                </Card>
                <Card className="border-[#F4F6F0]">
                    <CardContent className="p-4">
                        <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-lg bg-blue-100 flex items-center justify-center">
                                <Building2 className="w-5 h-5 text-blue-600" />
                            </div>
                            <div>
                                <p className="text-2xl font-bold text-blue-600">{stats.venues}</p>
                                <p className="text-xs text-[#485550]/60">Venues</p>
                            </div>
                        </div>
                    </CardContent>
                </Card>
                <Card className="border-[#F4F6F0]">
                    <CardContent className="p-4">
                        <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-lg bg-purple-100 flex items-center justify-center">
                                <Users className="w-5 h-5 text-purple-600" />
                            </div>
                            <div>
                                <p className="text-2xl font-bold text-purple-600">{stats.invigilators}</p>
                                <p className="text-xs text-[#485550]/60">Invigilators</p>
                            </div>
                        </div>
                    </CardContent>
                </Card>
            </div>

            {/* Tabs */}
            <Tabs value={activeTab} onValueChange={setActiveTab}>
                <TabsList className="grid w-full grid-cols-5 bg-[#485550]">
                    <TabsTrigger value="timetable" className="text-white data-[state=active]:bg-[#C0EB6A] data-[state=active]:text-[#485550]">
                        <Calendar className="w-4 h-4 mr-1" /> Timetable
                    </TabsTrigger>
                    <TabsTrigger value="venues" className="text-white data-[state=active]:bg-[#C0EB6A] data-[state=active]:text-[#485550]">
                        <Building2 className="w-4 h-4 mr-1" /> Venues
                    </TabsTrigger>
                    <TabsTrigger value="invigilators" className="text-white data-[state=active]:bg-[#C0EB6A] data-[state=active]:text-[#485550]">
                        <Users className="w-4 h-4 mr-1" /> Invigilators
                    </TabsTrigger>
                    <TabsTrigger value="ca" className="text-white data-[state=active]:bg-[#C0EB6A] data-[state=active]:text-[#485550]">
                        <FileText className="w-4 h-4 mr-1" /> CA Entry
                    </TabsTrigger>
                    <TabsTrigger value="cards" className="text-white data-[state=active]:bg-[#C0EB6A] data-[state=active]:text-[#485550]">
                        <CreditCard className="w-4 h-4 mr-1" /> Exam Cards
                    </TabsTrigger>
                </TabsList>

                {/* Timetable Tab - New Layout */}
                <TabsContent value="timetable" className="mt-4">
                    <div className={`${isFullscreen ? 'fixed inset-0 z-50 bg-white p-4 overflow-auto' : ''}`}>
                        <div className={`flex gap-4 ${isFullscreen ? 'h-full' : ''}`}>
                            {/* Left Panel - Unscheduled Courses */}
                            <div className={`w-64 flex-shrink-0 ${isFullscreen ? 'hidden' : ''}`}>
                                <Card className="border-[#F4F6F0] h-full">
                                    <CardHeader className="pb-2">
                                        <CardTitle className="text-[#485550] text-base flex items-center gap-2">
                                            <GripVertical className="w-4 h-4" />
                                            Courses
                                        </CardTitle>
                                        <CardDescription>Drag to schedule</CardDescription>
                                    </CardHeader>
                                    <CardContent className="space-y-3">
                                        <div className="space-y-2">
                                            <div className="relative">
                                                <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-4 h-4 text-[#485550]/40" />
                                                <Input
                                                    placeholder="Search..."
                                                    value={searchTerm}
                                                    onChange={(e) => setSearchTerm(e.target.value)}
                                                    className="pl-8 h-8 text-sm border-[#485550]/20"
                                                />
                                            </div>
                                            <Select value={departmentFilter} onValueChange={setDepartmentFilter}>
                                                <SelectTrigger className="h-8 text-sm border-[#485550]/20">
                                                    <SelectValue placeholder="All Depts" />
                                                </SelectTrigger>
                                                <SelectContent>
                                                    <SelectItem value="all">All Departments</SelectItem>
                                                    {departments.map(d => (
                                                        <SelectItem key={d} value={d}>{d}</SelectItem>
                                                    ))}
                                                </SelectContent>
                                            </Select>
                                        </div>

                                        <div className="space-y-2 max-h-[400px] overflow-y-auto">
                                            {filteredUnscheduled.length === 0 ? (
                                                <p className="text-sm text-[#485550]/60 text-center py-4">
                                                    {unscheduledCourses.length === 0 ? 'All scheduled! 🎉' : 'No matches'}
                                                </p>
                                            ) : (
                                                filteredUnscheduled.map(course => (
                                                    <div
                                                        key={course.id}
                                                        draggable
                                                        onDragStart={(e) => handleDragStart(e, course)}
                                                        className={`p-2 rounded-lg cursor-grab active:cursor-grabbing border-2 border-transparent hover:border-[#C0EB6A] transition-all ${getCourseColor(course.id)} text-white`}
                                                    >
                                                        <div className="flex items-center gap-2">
                                                            <GripVertical className="w-3 h-3 opacity-60" />
                                                            <div className="flex-1 min-w-0">
                                                                <p className="font-bold text-sm">{course.code}</p>
                                                                <p className="text-[10px] opacity-80 truncate">{course.title}</p>
                                                            </div>
                                                        </div>
                                                    </div>
                                                ))
                                            )}
                                        </div>
                                    </CardContent>
                                </Card>
                            </div>

                            {/* Right Panel - Timetable */}
                            <div className="flex-1">
                                <Card className="border-[#F4F6F0]">
                                    <CardHeader className="pb-2">
                                        <div className="flex items-center justify-between">
                                            <div className="flex items-center gap-2">
                                                {/* Week Tabs */}
                                                {weeks.map(week => (
                                                    <Button
                                                        key={week.id}
                                                        variant={activeWeekId === week.id ? 'default' : 'outline'}
                                                        size="sm"
                                                        onClick={() => setActiveWeekId(week.id)}
                                                        className={activeWeekId === week.id ? 'bg-[#485550]' : 'border-[#485550]/20'}
                                                    >
                                                        {week.name}
                                                    </Button>
                                                ))}
                                                <Button variant="outline" size="sm" onClick={handleAddWeek} className="border-dashed border-[#485550]/30">
                                                    <Plus className="w-4 h-4 mr-1" /> Week
                                                </Button>
                                            </div>
                                            <div className="flex items-center gap-2">
                                                <Button variant="outline" size="sm" onClick={() => setAddDayDialogOpen(true)} className="border-[#485550]/20">
                                                    <CalendarPlus className="w-4 h-4 mr-1" /> Add Day
                                                </Button>
                                                <Button
                                                    variant="outline"
                                                    size="sm"
                                                    onClick={() => setIsFullscreen(!isFullscreen)}
                                                    className="border-[#485550]/20"
                                                    title={isFullscreen ? 'Exit Fullscreen' : 'Fullscreen'}
                                                >
                                                    {isFullscreen ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
                                                </Button>
                                            </div>
                                        </div>
                                    </CardHeader>
                                    <CardContent>
                                        {/* Time Ruler */}
                                        <div className="flex border-b border-[#F4F6F0] mb-2">
                                            <div className="w-24 flex-shrink-0"></div>
                                            <div className="flex-1 flex">
                                                {timeHours.map(hour => (
                                                    <div key={hour} className="flex-1 text-center text-[10px] text-[#485550]/60 py-1 border-l border-[#F4F6F0]">
                                                        {parseInt(hour) > 12 ? `${parseInt(hour) - 12}PM` : `${parseInt(hour)}${parseInt(hour) === 12 ? 'PM' : 'AM'}`}
                                                    </div>
                                                ))}
                                            </div>
                                        </div>

                                        {/* Days */}
                                        <div className="space-y-2">
                                            {activeWeek.days.map(day => {
                                                const dayExams = getExamsForDay(day.id);
                                                const trackHeight = 36; // Height per exam track
                                                const minHeight = Math.max(50, dayExams.length * trackHeight + 10);

                                                return (
                                                    <div
                                                        key={day.id}
                                                        className={`flex rounded-lg transition-colors border ${draggedCourse ? 'bg-[#C0EB6A]/10 border-[#C0EB6A]' : 'bg-[#F4F6F0]/30 border-transparent'}`}
                                                        onDragOver={handleDragOver}
                                                        onDrop={(e) => handleDrop(e, day.id)}
                                                        style={{ minHeight: `${minHeight}px` }}
                                                    >
                                                        {/* Day Label */}
                                                        <div className="w-24 flex-shrink-0 p-2 flex flex-col justify-center border-r border-[#F4F6F0]">
                                                            <span className="font-medium text-[#485550] text-sm">{day.name.slice(0, 3)}</span>
                                                            <span className="text-[10px] text-[#485550]/50">{dayExams.length} exam{dayExams.length !== 1 ? 's' : ''}</span>
                                                            <button
                                                                onClick={() => handleRemoveDay(day.id)}
                                                                className="mt-1 text-red-400 hover:text-red-600 text-[10px] hover:underline"
                                                            >
                                                                Remove
                                                            </button>
                                                        </div>

                                                        {/* Exam Tracks */}
                                                        <div className="flex-1 relative">
                                                            {/* Background grid lines */}
                                                            <div className="absolute inset-0 flex pointer-events-none">
                                                                {timeHours.map(hour => (
                                                                    <div key={hour} className="flex-1 border-l border-[#F4F6F0]/50"></div>
                                                                ))}
                                                            </div>

                                                            {/* Stacked exam tracks */}
                                                            <div className="relative py-1">
                                                                {dayExams.length === 0 ? (
                                                                    <div className="h-10 flex items-center justify-center text-[#485550]/40 text-sm">
                                                                        Drop course here
                                                                    </div>
                                                                ) : (
                                                                    dayExams.map((exam, idx) => {
                                                                        const style = getExamStyle(exam);
                                                                        return (
                                                                            <div
                                                                                key={exam.id}
                                                                                className="relative h-8 mb-1"
                                                                            >
                                                                                <div
                                                                                    className={`absolute top-0 h-full rounded-md px-2 text-white text-xs cursor-pointer hover:shadow-lg transition-all group flex items-center ${getCourseColor(exam.courseId)}`}
                                                                                    style={{ left: style.left, width: style.width, minWidth: '80px' }}
                                                                                    onClick={() => handleEditExam(exam)}
                                                                                >
                                                                                    <div className="flex items-center justify-between w-full">
                                                                                        <div className="flex items-center gap-2 truncate">
                                                                                            <span className="font-bold">{exam.courseCode}</span>
                                                                                            <span className="opacity-70 text-[10px] hidden sm:inline">• {exam.venueName}</span>
                                                                                            <span className="opacity-60 text-[10px]">{exam.startTime}-{exam.endTime}</span>
                                                                                        </div>
                                                                                        <button
                                                                                            onClick={(e) => { e.stopPropagation(); handleRemoveSchedule(exam.id); }}
                                                                                            className="opacity-0 group-hover:opacity-100 ml-1 bg-white/20 rounded p-0.5"
                                                                                        >
                                                                                            <X className="w-3 h-3" />
                                                                                        </button>
                                                                                    </div>
                                                                                </div>
                                                                            </div>
                                                                        );
                                                                    })
                                                                )}
                                                            </div>
                                                        </div>
                                                    </div>
                                                );
                                            })}
                                        </div>

                                        {activeWeek.days.length === 0 && (
                                            <div className="text-center py-8 text-[#485550]/60">
                                                <Calendar className="w-12 h-12 mx-auto mb-2 opacity-30" />
                                                <p>No days in this week. Add a day to start scheduling.</p>
                                            </div>
                                        )}
                                    </CardContent>
                                </Card>
                            </div>
                        </div>
                    </div>
                </TabsContent>

                {/* Venues Tab */}
                <TabsContent value="venues" className="space-y-4 mt-4">
                    <div className="flex justify-between items-center">
                        <h2 className="text-lg font-semibold text-[#485550]">Examination Venues</h2>
                        <Button onClick={handleCreateVenue} className="bg-[#485550] hover:bg-[#6b7c6f]">
                            <Plus className="w-4 h-4 mr-2" /> Add Venue
                        </Button>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                        {venues.map(venue => (
                            <Card key={venue.id} className={`border-[#F4F6F0] ${!venue.isAvailable ? 'opacity-50' : ''}`}>
                                <CardHeader className="pb-2">
                                    <div className="flex items-start justify-between">
                                        <div>
                                            <CardTitle className="text-[#485550] text-base">{venue.name}</CardTitle>
                                            <CardDescription className="flex items-center gap-2 mt-1">
                                                <MapPin className="w-3 h-3" /> Capacity: {venue.capacity}
                                            </CardDescription>
                                        </div>
                                        {getVenueTypeBadge(venue.type)}
                                    </div>
                                </CardHeader>
                                <CardContent>
                                    <div className="flex items-center justify-between">
                                        <Badge className={venue.isAvailable ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}>
                                            {venue.isAvailable ? 'Available' : 'Unavailable'}
                                        </Badge>
                                        <div className="flex gap-1">
                                            <Button size="sm" variant="ghost" onClick={() => handleEditVenue(venue)}>
                                                <Edit className="w-4 h-4 text-[#485550]" />
                                            </Button>
                                            <Button size="sm" variant="ghost" onClick={() => handleDeleteVenue(venue.id)}>
                                                <Trash2 className="w-4 h-4 text-red-500" />
                                            </Button>
                                        </div>
                                    </div>
                                </CardContent>
                            </Card>
                        ))}
                    </div>
                </TabsContent>

                {/* Invigilators Tab */}
                <TabsContent value="invigilators" className="space-y-4 mt-4">
                    <Card className="border-[#F4F6F0]">
                        <CardHeader>
                            <CardTitle className="text-[#485550]">Invigilator Assignments</CardTitle>
                            <CardDescription>Click on scheduled exams to assign invigilators</CardDescription>
                        </CardHeader>
                        <CardContent>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                <div className="space-y-3">
                                    <h3 className="font-medium text-[#485550]">Available Invigilators</h3>
                                    {invigilators.map(inv => (
                                        <div key={inv.id} className="p-3 bg-[#F4F6F0] rounded-lg flex items-center justify-between">
                                            <div className="flex items-center gap-3">
                                                <div className="w-10 h-10 rounded-full bg-[#485550] flex items-center justify-center text-white font-bold">
                                                    {inv.name.split(' ').map(n => n[0]).join('')}
                                                </div>
                                                <div>
                                                    <p className="font-medium text-[#485550]">{inv.name}</p>
                                                    <p className="text-xs text-[#485550]/60">{inv.department}</p>
                                                </div>
                                            </div>
                                            <Badge variant="outline">{schedules.filter(s => s.invigilators.includes(inv.name)).length} exams</Badge>
                                        </div>
                                    ))}
                                </div>
                                <div className="space-y-3">
                                    <h3 className="font-medium text-[#485550]">Scheduled Exams</h3>
                                    {schedules.map(exam => (
                                        <div key={exam.id} className="p-3 bg-[#F4F6F0] rounded-lg">
                                            <div className="flex items-center justify-between">
                                                <div>
                                                    <p className="font-bold text-[#485550]">{exam.courseCode}</p>
                                                    <p className="text-xs text-[#485550]/60">{exam.startTime}-{exam.endTime} • {exam.venueName}</p>
                                                </div>
                                                <Button size="sm" variant="outline" onClick={() => handleEditExam(exam)}>
                                                    <Users className="w-4 h-4 mr-1" />
                                                    {exam.invigilators.length}
                                                </Button>
                                            </div>
                                            {exam.invigilators.length > 0 && (
                                                <div className="flex flex-wrap gap-1 mt-2">
                                                    {exam.invigilators.map(name => (
                                                        <Badge key={name} variant="outline" className="text-xs">{name}</Badge>
                                                    ))}
                                                </div>
                                            )}
                                        </div>
                                    ))}
                                </div>
                            </div>
                        </CardContent>
                    </Card>
                </TabsContent>

                {/* CA Entry Tab */}
                <TabsContent value="ca" className="space-y-4 mt-4">
                    <Card className="border-[#F4F6F0]">
                        <CardHeader>
                            <CardTitle className="text-[#485550]">Continuous Assessment Entry</CardTitle>
                            <CardDescription>Enter CA scores for students</CardDescription>
                        </CardHeader>
                        <CardContent>
                            <div className="flex items-center gap-4 mb-6">
                                <Select>
                                    <SelectTrigger className="w-[250px] border-[#485550]/20">
                                        <SelectValue placeholder="Select Course" />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {courses.map(c => (
                                            <SelectItem key={c.id} value={c.id}>{c.code} - {c.title}</SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                                <Button variant="outline" className="border-[#485550]">
                                    <Download className="w-4 h-4 mr-2" /> Import CSV
                                </Button>
                            </div>
                            <div className="text-center py-12 text-[#485550]/60">
                                <FileText className="w-16 h-16 mx-auto mb-4 opacity-30" />
                                <p>Select a course to enter CA scores</p>
                            </div>
                        </CardContent>
                    </Card>
                </TabsContent>

                {/* Exam Cards Tab */}
                <TabsContent value="cards" className="space-y-4 mt-4">
                    <Card className="border-[#F4F6F0]">
                        <CardHeader>
                            <CardTitle className="text-[#485550]">Exam Card Generation</CardTitle>
                            <CardDescription>Generate and print exam cards</CardDescription>
                        </CardHeader>
                        <CardContent>
                            <div className="flex items-center gap-4 mb-6">
                                <Select>
                                    <SelectTrigger className="w-[200px] border-[#485550]/20">
                                        <SelectValue placeholder="Department" />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {departments.map(d => (
                                            <SelectItem key={d} value={d}>{d}</SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                                <Select>
                                    <SelectTrigger className="w-[150px] border-[#485550]/20">
                                        <SelectValue placeholder="Level" />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="100">100 Level</SelectItem>
                                        <SelectItem value="200">200 Level</SelectItem>
                                        <SelectItem value="300">300 Level</SelectItem>
                                        <SelectItem value="400">400 Level</SelectItem>
                                    </SelectContent>
                                </Select>
                                <Button className="bg-[#485550] hover:bg-[#6b7c6f]">
                                    <Printer className="w-4 h-4 mr-2" /> Generate
                                </Button>
                            </div>
                            <div className="text-center py-12 text-[#485550]/60">
                                <CreditCard className="w-16 h-16 mx-auto mb-4 opacity-30" />
                                <p>Select department and level to generate exam cards</p>
                            </div>
                        </CardContent>
                    </Card>
                </TabsContent>
            </Tabs>

            {/* Schedule Dialog */}
            <Dialog open={scheduleDialogOpen} onOpenChange={setScheduleDialogOpen}>
                <DialogContent className="max-w-md">
                    <DialogHeader>
                        <DialogTitle className="text-[#485550]">Schedule Exam</DialogTitle>
                        <DialogDescription>
                            {pendingSchedule?.course.code} - {pendingSchedule?.course.title}
                        </DialogDescription>
                    </DialogHeader>
                    <div className="space-y-4 py-4">
                        <div className="grid grid-cols-2 gap-4">
                            <div className="space-y-2">
                                <Label>Start Time <span className="text-red-500">*</span></Label>
                                <Input
                                    type="time"
                                    value={scheduleForm.startTime}
                                    onChange={(e) => setScheduleForm({ ...scheduleForm, startTime: e.target.value })}
                                    className="border-[#485550]/20"
                                />
                            </div>
                            <div className="space-y-2">
                                <Label>End Time <span className="text-red-500">*</span></Label>
                                <Input
                                    type="time"
                                    value={scheduleForm.endTime}
                                    onChange={(e) => setScheduleForm({ ...scheduleForm, endTime: e.target.value })}
                                    className="border-[#485550]/20"
                                />
                            </div>
                        </div>
                        <div className="space-y-2">
                            <Label>Venue <span className="text-red-500">*</span></Label>
                            <Select value={scheduleForm.venueId} onValueChange={(v) => setScheduleForm({ ...scheduleForm, venueId: v })}>
                                <SelectTrigger className="border-[#485550]/20">
                                    <SelectValue placeholder="Select venue..." />
                                </SelectTrigger>
                                <SelectContent>
                                    {venues.filter(v => v.isAvailable).map(v => (
                                        <SelectItem key={v.id} value={v.id}>
                                            {v.name} ({v.capacity} seats)
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                    </div>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setScheduleDialogOpen(false)}>Cancel</Button>
                        <Button onClick={handleConfirmSchedule} className="bg-[#485550] hover:bg-[#6b7c6f]">Schedule</Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* Add Day Dialog */}
            <Dialog open={addDayDialogOpen} onOpenChange={setAddDayDialogOpen}>
                <DialogContent className="max-w-sm">
                    <DialogHeader>
                        <DialogTitle className="text-[#485550]">Add Day</DialogTitle>
                        <DialogDescription>Add a day to {activeWeek.name}</DialogDescription>
                    </DialogHeader>
                    <div className="py-4">
                        <Select value={newDayName} onValueChange={setNewDayName}>
                            <SelectTrigger className="border-[#485550]/20">
                                <SelectValue placeholder="Select day..." />
                            </SelectTrigger>
                            <SelectContent>
                                {allDaysOfWeek.filter(d => !activeWeek.days.some(ed => ed.name === d)).map(d => (
                                    <SelectItem key={d} value={d}>{d}</SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setAddDayDialogOpen(false)}>Cancel</Button>
                        <Button onClick={handleAddDay} className="bg-[#485550] hover:bg-[#6b7c6f]">Add</Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* Venue Dialog */}
            <Dialog open={venueDialogOpen} onOpenChange={setVenueDialogOpen}>
                <DialogContent className="max-w-md">
                    <DialogHeader>
                        <DialogTitle className="text-[#485550]">{editingVenue ? 'Edit' : 'Add'} Venue</DialogTitle>
                    </DialogHeader>
                    <div className="space-y-4 py-4">
                        <div className="space-y-2">
                            <Label>Venue Name <span className="text-red-500">*</span></Label>
                            <Input
                                value={venueForm.name}
                                onChange={(e) => setVenueForm({ ...venueForm, name: e.target.value })}
                                placeholder="e.g. Main Hall A"
                                className="border-[#485550]/20"
                            />
                        </div>
                        <div className="grid grid-cols-2 gap-4">
                            <div className="space-y-2">
                                <Label>Capacity <span className="text-red-500">*</span></Label>
                                <Input
                                    type="number"
                                    value={venueForm.capacity}
                                    onChange={(e) => setVenueForm({ ...venueForm, capacity: e.target.value })}
                                    placeholder="500"
                                    className="border-[#485550]/20"
                                />
                            </div>
                            <div className="space-y-2">
                                <Label>Type</Label>
                                <Select value={venueForm.type} onValueChange={(v) => setVenueForm({ ...venueForm, type: v })}>
                                    <SelectTrigger className="border-[#485550]/20"><SelectValue /></SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="HALL">Hall</SelectItem>
                                        <SelectItem value="LAB">Lab</SelectItem>
                                        <SelectItem value="CLASSROOM">Classroom</SelectItem>
                                    </SelectContent>
                                </Select>
                            </div>
                        </div>
                    </div>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setVenueDialogOpen(false)}>Cancel</Button>
                        <Button onClick={handleSaveVenue} disabled={submitting} className="bg-[#485550] hover:bg-[#6b7c6f]">
                            {submitting && <Loader2 className="w-4 h-4 animate-spin mr-2" />}Save
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* Edit Exam Dialog */}
            <Dialog open={editExamDialogOpen} onOpenChange={setEditExamDialogOpen}>
                <DialogContent className="max-w-lg">
                    <DialogHeader>
                        <DialogTitle className="text-[#485550]">Edit Exam</DialogTitle>
                        <DialogDescription>
                            {selectedExam?.courseCode} - {selectedExam?.courseTitle}
                        </DialogDescription>
                    </DialogHeader>
                    <div className="space-y-5 py-4">
                        {/* Time and Venue Section */}
                        <div className="p-4 bg-[#F4F6F0] rounded-lg space-y-4">
                            <h4 className="font-medium text-[#485550] text-sm">Schedule Details</h4>
                            <div className="grid grid-cols-2 gap-4">
                                <div className="space-y-2">
                                    <Label>Start Time</Label>
                                    <Input
                                        type="time"
                                        value={editExamForm.startTime}
                                        onChange={(e) => setEditExamForm({ ...editExamForm, startTime: e.target.value })}
                                        className="border-[#485550]/20"
                                    />
                                </div>
                                <div className="space-y-2">
                                    <Label>End Time</Label>
                                    <Input
                                        type="time"
                                        value={editExamForm.endTime}
                                        onChange={(e) => setEditExamForm({ ...editExamForm, endTime: e.target.value })}
                                        className="border-[#485550]/20"
                                    />
                                </div>
                            </div>
                            <div className="space-y-2">
                                <Label>Venue</Label>
                                <Select value={editExamForm.venueId} onValueChange={(v) => setEditExamForm({ ...editExamForm, venueId: v })}>
                                    <SelectTrigger className="border-[#485550]/20">
                                        <SelectValue placeholder="Select venue..." />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {venues.filter(v => v.isAvailable).map(v => (
                                            <SelectItem key={v.id} value={v.id}>
                                                {v.name} ({v.capacity} seats)
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </div>
                            <Button
                                size="sm"
                                onClick={handleSaveExamChanges}
                                className="bg-[#485550] hover:bg-[#6b7c6f]"
                            >
                                <Check className="w-4 h-4 mr-1" /> Save Changes
                            </Button>
                        </div>

                        {/* Invigilators Section */}
                        <div className="space-y-3">
                            <h4 className="font-medium text-[#485550] text-sm">Invigilators</h4>

                            {/* Currently Assigned */}
                            {selectedExam && selectedExam.invigilators.length > 0 && (
                                <div className="flex flex-wrap gap-2">
                                    {selectedExam.invigilators.map(name => (
                                        <Badge key={name} className="bg-green-100 text-green-700 pr-1">
                                            {name}
                                            <button
                                                onClick={() => handleRemoveInvigilatorFromExam(name)}
                                                className="ml-1 hover:bg-green-200 rounded"
                                            >
                                                <X className="w-3 h-3" />
                                            </button>
                                        </Badge>
                                    ))}
                                </div>
                            )}

                            {/* Available Invigilators */}
                            <div className="space-y-2 max-h-[150px] overflow-y-auto">
                                {invigilators
                                    .filter(inv => !selectedExam?.invigilators.includes(inv.name))
                                    .map(inv => (
                                        <div
                                            key={inv.id}
                                            className="p-2 bg-[#F4F6F0] rounded flex items-center justify-between cursor-pointer hover:bg-[#C0EB6A]/20"
                                            onClick={() => handleAddInvigilatorToExam(inv.name)}
                                        >
                                            <div className="flex items-center gap-2">
                                                <div className="w-7 h-7 rounded-full bg-[#485550] flex items-center justify-center text-white text-[10px] font-bold">
                                                    {inv.name.split(' ').map(n => n[0]).join('')}
                                                </div>
                                                <div>
                                                    <p className="text-sm font-medium text-[#485550]">{inv.name}</p>
                                                    <p className="text-[10px] text-[#485550]/60">{inv.department}</p>
                                                </div>
                                            </div>
                                            <Plus className="w-4 h-4 text-[#485550]" />
                                        </div>
                                    ))}
                            </div>
                        </div>
                    </div>
                    <DialogFooter>
                        <Button onClick={() => setEditExamDialogOpen(false)} className="bg-[#485550] hover:bg-[#6b7c6f]">Done</Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}
