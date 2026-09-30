'use client';

import { useState, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import {
  Plus,
  BookOpen,
  Edit,
  Trash2,
  Save,
  Search,
  CheckCircle,
  Clock,
  X,
  List,
  Grid3X3,
  Loader2,
  GraduationCap
} from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';

interface Course {
  id: string;
  courseCode: string;
  courseName: string;
  creditUnits: number;
  level: number;
  semester: string;
  departmentId: string;
  departmentName: string;
  isCore: boolean;
  prerequisites: string[];
  description: string;
}

interface Department {
  id: string;
  name: string;
  code: string;
}

// Mock data
const mockCourses: Course[] = [
  { id: 'c1', courseCode: 'CSC101', courseName: 'Introduction to Computer Science', creditUnits: 3, level: 1, semester: 'first', departmentId: 'd1', departmentName: 'Computer Science', isCore: true, prerequisites: [], description: 'Basic computing concepts' },
  { id: 'c2', courseCode: 'CSC201', courseName: 'Data Structures and Algorithms', creditUnits: 4, level: 2, semester: 'first', departmentId: 'd1', departmentName: 'Computer Science', isCore: true, prerequisites: ['CSC101'], description: 'Arrays, linked lists, trees, and graphs' },
  { id: 'c3', courseCode: 'MTH101', courseName: 'Calculus I', creditUnits: 3, level: 1, semester: 'first', departmentId: 'd2', departmentName: 'Mathematics', isCore: true, prerequisites: [], description: 'Limits, derivatives, and integrals' },
  { id: 'c4', courseCode: 'MTH201', courseName: 'Linear Algebra', creditUnits: 3, level: 2, semester: 'second', departmentId: 'd2', departmentName: 'Mathematics', isCore: true, prerequisites: ['MTH101'], description: 'Matrices, vectors, and linear transformations' },
  { id: 'c5', courseCode: 'CSC301', courseName: 'Database Systems', creditUnits: 3, level: 3, semester: 'first', departmentId: 'd1', departmentName: 'Computer Science', isCore: true, prerequisites: ['CSC201'], description: 'Relational databases and SQL' },
  { id: 'c6', courseCode: 'CSC401', courseName: 'Artificial Intelligence', creditUnits: 3, level: 4, semester: 'first', departmentId: 'd1', departmentName: 'Computer Science', isCore: false, prerequisites: ['CSC301'], description: 'Machine learning and AI concepts' },
];

const mockDepartments: Department[] = [
  { id: 'd1', name: 'Computer Science', code: 'CSC' },
  { id: 'd2', name: 'Mathematics', code: 'MTH' },
  { id: 'd3', name: 'Physics', code: 'PHY' },
  { id: 'd4', name: 'Electrical Engineering', code: 'EEE' },
];

export default function CourseManagement() {
  const [isCreatingCourse, setIsCreatingCourse] = useState(false);
  const [editingCourse, setEditingCourse] = useState<Course | null>(null);
  const [viewMode, setViewMode] = useState<'list' | 'grid'>('list');
  const [searchTerm, setSearchTerm] = useState('');
  const [departmentFilter, setDepartmentFilter] = useState('all');
  const [levelFilter, setLevelFilter] = useState('all');
  const [semesterFilter, setSemesterFilter] = useState('all');
  const [courses, setCourses] = useState<Course[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  const [courseForm, setCourseForm] = useState({
    courseCode: '',
    courseName: '',
    creditUnits: '',
    level: '',
    semester: '',
    departmentId: '',
    isCore: true,
    prerequisites: '',
    description: ''
  });

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    setIsLoading(true);
    try {
      if (api.isAuthenticated()) {
        const [coursesData, deptsData] = await Promise.all([
          api.getAdminCourses(),
          api.getAdminDepartments(),
        ]);
        setCourses(coursesData.map((c: any) => ({
          id: c.id,
          courseCode: c.code || '',
          courseName: c.title || c.name || '',
          creditUnits: c.creditUnits || c.credit_units || 3,
          level: c.level || 1,
          semester: c.semester || 'first',
          departmentId: c.departmentId || '',
          departmentName: c.departmentName || 'Unknown',
          isCore: c.isCore !== undefined ? c.isCore : true,
          prerequisites: c.prerequisites || [],
          description: c.description || ''
        })));
        setDepartments(deptsData.map((d: any) => ({ id: d.id, name: d.name, code: d.code || '' })));
      } else {
        setCourses(mockCourses);
        setDepartments(mockDepartments);
      }
    } catch (error) {
      console.error('Failed to fetch data:', error);
      setCourses(mockCourses);
      setDepartments(mockDepartments);
    } finally {
      setIsLoading(false);
    }
  };

  // Filter courses
  const filteredCourses = courses.filter(course => {
    const matchesSearch = course.courseName.toLowerCase().includes(searchTerm.toLowerCase()) ||
      course.courseCode.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesDepartment = departmentFilter === 'all' || course.departmentId === departmentFilter;
    const matchesLevel = levelFilter === 'all' || course.level.toString() === levelFilter;
    const matchesSemester = semesterFilter === 'all' || course.semester === semesterFilter;
    return matchesSearch && matchesDepartment && matchesLevel && matchesSemester;
  });

  const resetForm = () => setCourseForm({ courseCode: '', courseName: '', creditUnits: '', level: '', semester: '', departmentId: '', isCore: true, prerequisites: '', description: '' });

  const handleCreateCourse = async () => {
    if (!courseForm.courseCode || !courseForm.courseName || !courseForm.creditUnits || !courseForm.level || !courseForm.semester || !courseForm.departmentId) {
      toast.error('Please fill in all required fields');
      return;
    }
    setSubmitting(true);
    try {
      const payload = {
        code: courseForm.courseCode,
        title: courseForm.courseName,
        creditUnits: parseInt(courseForm.creditUnits),
        level: parseInt(courseForm.level),
        semester: courseForm.semester,
        departmentId: courseForm.departmentId,
        isCore: courseForm.isCore,
        description: courseForm.description,
        prerequisites: courseForm.prerequisites ? courseForm.prerequisites.split(',').map(p => p.trim()) : []
      };

      if (api.isAuthenticated()) {
        if (editingCourse) {
          await api.updateAdminCourse(editingCourse.id, payload);
          toast.success('Course updated successfully!');
        } else {
          await api.createAdminCourse(payload);
          toast.success('Course created successfully!');
        }
        await fetchData();
      } else {
        toast.success(editingCourse ? 'Course updated!' : 'Course created!');
      }
      setIsCreatingCourse(false);
      resetForm();
      setEditingCourse(null);
    } catch (error: any) {
      toast.error(error.message || 'Failed to save course');
    } finally {
      setSubmitting(false);
    }
  };

  const handleEditCourse = (course: Course) => {
    setEditingCourse(course);
    setCourseForm({
      courseCode: course.courseCode,
      courseName: course.courseName,
      creditUnits: course.creditUnits.toString(),
      level: course.level.toString(),
      semester: course.semester,
      departmentId: course.departmentId,
      isCore: course.isCore,
      prerequisites: course.prerequisites?.join(', ') || '',
      description: course.description || ''
    });
    setIsCreatingCourse(true);
  };

  const handleDeleteCourse = async (courseId: string) => {
    try {
      if (api.isAuthenticated()) {
        await api.deleteAdminCourse(courseId);
      }
      setCourses(courses.filter(c => c.id !== courseId));
      toast.success('Course deleted successfully!');
    } catch (error: any) {
      toast.error(error.message || 'Failed to delete course');
    }
  };

  const handleCancelEdit = () => {
    setIsCreatingCourse(false);
    setEditingCourse(null);
    resetForm();
  };

  const getSemesterBadge = (semester: string) => (
    <Badge variant="outline" className={semester === 'first' ? 'bg-blue-50 text-blue-600 border-blue-200' : 'bg-green-50 text-green-600 border-green-200'}>
      {semester === 'first' ? '1st Semester' : '2nd Semester'}
    </Badge>
  );

  const getLevelBadge = (level: number) => {
    const colors = ['bg-red-50 text-red-600', 'bg-blue-50 text-blue-600', 'bg-green-50 text-green-600', 'bg-purple-50 text-purple-600', 'bg-amber-50 text-amber-600', 'bg-pink-50 text-pink-600'];
    return <Badge className={colors[(level - 1) % colors.length]}>Level {level}</Badge>;
  };

  // Statistics
  const totalCourses = courses.length;
  const coreCourses = courses.filter(c => c.isCore).length;
  const electiveCourses = courses.filter(c => !c.isCore).length;

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
        <h1 className="text-3xl font-bold text-[#485550]">Course Management</h1>
        <p className="text-[#485550]/60 mt-1">Create and manage courses that can be assigned to programmes</p>
      </div>

      {/* Statistics Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card className="border-[#F4F6F0]">
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-[#F4F6F0] flex items-center justify-center">
                <BookOpen className="w-5 h-5 text-[#485550]" />
              </div>
              <div>
                <p className="text-2xl font-bold text-[#485550]">{totalCourses}</p>
                <p className="text-sm text-[#485550]/60">Total Courses</p>
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
                <p className="text-2xl font-bold text-[#485550]">{coreCourses}</p>
                <p className="text-sm text-[#485550]/60">Core Courses</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card className="border-[#F4F6F0]">
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-[#F4F6F0] flex items-center justify-center">
                <Clock className="w-5 h-5 text-[#485550]" />
              </div>
              <div>
                <p className="text-2xl font-bold text-[#485550]">{electiveCourses}</p>
                <p className="text-sm text-[#485550]/60">Elective Courses</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card className="border-[#F4F6F0]">
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-[#C0EB6A]/20 flex items-center justify-center">
                <GraduationCap className="w-5 h-5 text-[#485550]" />
              </div>
              <div>
                <p className="text-2xl font-bold text-[#485550]">{departments.length}</p>
                <p className="text-sm text-[#485550]/60">Departments</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Quick Actions */}
      <Button onClick={() => setIsCreatingCourse(true)} disabled={isCreatingCourse} className="bg-[#485550] hover:bg-[#6b7c6f]">
        <Plus className="w-4 h-4 mr-2" /> Create New Course
      </Button>

      {/* Create/Edit Course Form */}
      {isCreatingCourse && (
        <Card className="border-[#C0EB6A]">
          <CardHeader>
            <CardTitle className="text-[#485550]">{editingCourse ? 'Edit Course' : 'Create New Course'}</CardTitle>
            <CardDescription>{editingCourse ? 'Update course information' : 'Create a course that can be assigned to programmes'}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Course Code <span className="text-red-500">*</span></Label>
                <Input placeholder="e.g., CSC101" value={courseForm.courseCode} onChange={(e) => setCourseForm({ ...courseForm, courseCode: e.target.value.toUpperCase() })} className="border-[#485550]/20" />
              </div>
              <div className="space-y-2">
                <Label>Course Name <span className="text-red-500">*</span></Label>
                <Input placeholder="e.g., Introduction to Programming" value={courseForm.courseName} onChange={(e) => setCourseForm({ ...courseForm, courseName: e.target.value })} className="border-[#485550]/20" />
              </div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <div className="space-y-2">
                <Label>Department <span className="text-red-500">*</span></Label>
                <Select value={courseForm.departmentId} onValueChange={(val) => setCourseForm({ ...courseForm, departmentId: val })}>
                  <SelectTrigger className="border-[#485550]/20"><SelectValue placeholder="Select Department" /></SelectTrigger>
                  <SelectContent>{departments.map(d => <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Level <span className="text-red-500">*</span></Label>
                <Select value={courseForm.level} onValueChange={(val) => setCourseForm({ ...courseForm, level: val })}>
                  <SelectTrigger className="border-[#485550]/20"><SelectValue placeholder="Select Level" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="1">Level 1</SelectItem>
                    <SelectItem value="2">Level 2</SelectItem>
                    <SelectItem value="3">Level 3</SelectItem>
                    <SelectItem value="4">Level 4</SelectItem>
                    <SelectItem value="5">Level 5</SelectItem>
                    <SelectItem value="6">Level 6</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Semester <span className="text-red-500">*</span></Label>
                <Select value={courseForm.semester} onValueChange={(val) => setCourseForm({ ...courseForm, semester: val })}>
                  <SelectTrigger className="border-[#485550]/20"><SelectValue placeholder="Select Semester" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="first">First Semester</SelectItem>
                    <SelectItem value="second">Second Semester</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Credit Units <span className="text-red-500">*</span></Label>
                <Input type="number" placeholder="3" value={courseForm.creditUnits} onChange={(e) => setCourseForm({ ...courseForm, creditUnits: e.target.value })} className="border-[#485550]/20" />
              </div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Course Type</Label>
                <Select value={courseForm.isCore ? 'core' : 'elective'} onValueChange={(val) => setCourseForm({ ...courseForm, isCore: val === 'core' })}>
                  <SelectTrigger className="border-[#485550]/20"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="core">Core Course</SelectItem>
                    <SelectItem value="elective">Elective Course</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Prerequisites (comma-separated)</Label>
                <Input placeholder="e.g., CSC101, MTH101" value={courseForm.prerequisites} onChange={(e) => setCourseForm({ ...courseForm, prerequisites: e.target.value })} className="border-[#485550]/20" />
              </div>
            </div>
            <div className="space-y-2">
              <Label>Description</Label>
              <Textarea placeholder="Brief description of the course..." value={courseForm.description} onChange={(e) => setCourseForm({ ...courseForm, description: e.target.value })} rows={3} className="border-[#485550]/20" />
            </div>
            <div className="flex gap-3">
              <Button onClick={handleCreateCourse} disabled={submitting} className="bg-[#485550] hover:bg-[#6b7c6f]">
                {submitting ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
                {editingCourse ? 'Update Course' : 'Create Course'}
              </Button>
              <Button variant="outline" onClick={handleCancelEdit} className="border-[#485550]">
                <X className="w-4 h-4 mr-2" /> Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Filters and View Toggle */}
      <Card className="border-[#F4F6F0]">
        <CardHeader>
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div>
              <CardTitle className="text-[#485550]">Course Library</CardTitle>
              <CardDescription>Browse and manage all available courses</CardDescription>
            </div>
            <div className="flex gap-2">
              <Button variant={viewMode === 'list' ? 'default' : 'outline'} size="sm" onClick={() => setViewMode('list')} className={viewMode === 'list' ? 'bg-[#485550]' : 'border-[#485550]'}>
                <List className="w-4 h-4" />
              </Button>
              <Button variant={viewMode === 'grid' ? 'default' : 'outline'} size="sm" onClick={() => setViewMode('grid')} className={viewMode === 'grid' ? 'bg-[#485550]' : 'border-[#485550]'}>
                <Grid3X3 className="w-4 h-4" />
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-col md:flex-row gap-4">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-[#485550]/40 w-4 h-4" />
              <Input placeholder="Search courses..." value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} className="pl-10 border-[#485550]/20" />
            </div>
            <Select value={departmentFilter} onValueChange={setDepartmentFilter}>
              <SelectTrigger className="w-full md:w-48 border-[#485550]/20"><SelectValue placeholder="All Departments" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Departments</SelectItem>
                {departments.map(d => <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={levelFilter} onValueChange={setLevelFilter}>
              <SelectTrigger className="w-full md:w-32 border-[#485550]/20"><SelectValue placeholder="All Levels" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Levels</SelectItem>
                <SelectItem value="1">Level 1</SelectItem>
                <SelectItem value="2">Level 2</SelectItem>
                <SelectItem value="3">Level 3</SelectItem>
                <SelectItem value="4">Level 4</SelectItem>
                <SelectItem value="5">Level 5</SelectItem>
                <SelectItem value="6">Level 6</SelectItem>
              </SelectContent>
            </Select>
            <Select value={semesterFilter} onValueChange={setSemesterFilter}>
              <SelectTrigger className="w-full md:w-36 border-[#485550]/20"><SelectValue placeholder="All Semesters" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Semesters</SelectItem>
                <SelectItem value="first">1st Semester</SelectItem>
                <SelectItem value="second">2nd Semester</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {(searchTerm || departmentFilter !== 'all' || levelFilter !== 'all' || semesterFilter !== 'all') && (
            <Button variant="outline" size="sm" onClick={() => { setSearchTerm(''); setDepartmentFilter('all'); setLevelFilter('all'); setSemesterFilter('all'); }} className="border-[#485550]">
              <X className="w-4 h-4 mr-2" /> Clear Filters
            </Button>
          )}
        </CardContent>
      </Card>

      <p className="text-sm text-[#485550]/60">Showing {filteredCourses.length} of {totalCourses} courses</p>

      {/* List View */}
      {viewMode === 'list' && (
        <Card className="border-[#F4F6F0]">
          <CardContent className="p-0">
            {/* Header */}
            <div className="hidden lg:grid grid-cols-12 gap-4 p-4 bg-[#F4F6F0] font-medium text-sm text-[#485550]">
              <div className="col-span-1">Course Code</div>
              <div className="col-span-3">Course Name</div>
              <div className="col-span-2">Department</div>
              <div className="col-span-1">Level</div>
              <div className="col-span-2">Semester</div>
              <div className="col-span-1">Credits</div>
              <div className="col-span-1">Type</div>
              <div className="col-span-1">Actions</div>
            </div>
            {filteredCourses.length === 0 ? (
              <div className="p-8 text-center">
                <BookOpen className="w-12 h-12 mx-auto mb-4 text-[#485550]/30" />
                <h3 className="text-lg font-medium text-[#485550] mb-2">No courses found</h3>
                <p className="text-[#485550]/60">Try adjusting your search or filters.</p>
              </div>
            ) : (
              <div className="divide-y divide-[#F4F6F0]">
                {filteredCourses.map((course) => (
                  <div key={course.id} className="p-4 hover:bg-[#F4F6F0]/50 cursor-pointer transition-colors" onClick={() => handleEditCourse(course)}>
                    {/* Desktop */}
                    <div className="hidden lg:grid grid-cols-12 gap-4 items-center">
                      <div className="col-span-1 font-semibold text-[#485550]">{course.courseCode}</div>
                      <div className="col-span-3">
                        <div className="font-medium text-[#485550]">{course.courseName}</div>
                        {course.description && <div className="text-sm text-[#485550]/60 line-clamp-1">{course.description}</div>}
                      </div>
                      <div className="col-span-2 text-sm text-[#485550]/80">{course.departmentName}</div>
                      <div className="col-span-1">{getLevelBadge(course.level)}</div>
                      <div className="col-span-2">{getSemesterBadge(course.semester)}</div>
                      <div className="col-span-1"><Badge variant="outline" className="border-[#485550]/30">{course.creditUnits}</Badge></div>
                      <div className="col-span-1"><Badge variant="outline" className={course.isCore ? 'bg-blue-50 text-blue-600 border-blue-200' : 'bg-purple-50 text-purple-600 border-purple-200'}>{course.isCore ? 'Core' : 'Elective'}</Badge></div>
                      <div className="col-span-1 flex gap-1">
                        <Button variant="ghost" size="sm" onClick={(e) => { e.stopPropagation(); handleEditCourse(course); }}><Edit className="w-4 h-4 text-[#485550]" /></Button>
                        <Dialog>
                          <DialogTrigger asChild>
                            <Button variant="ghost" size="sm" className="text-red-500 hover:text-red-600" onClick={(e) => e.stopPropagation()}><Trash2 className="w-4 h-4" /></Button>
                          </DialogTrigger>
                          <DialogContent>
                            <DialogHeader>
                              <DialogTitle>Delete Course</DialogTitle>
                              <DialogDescription>Are you sure you want to delete "{course.courseCode} - {course.courseName}"? This cannot be undone.</DialogDescription>
                            </DialogHeader>
                            <div className="flex gap-3 justify-end">
                              <Button variant="outline">Cancel</Button>
                              <Button variant="destructive" onClick={() => handleDeleteCourse(course.id)}>Delete Course</Button>
                            </div>
                          </DialogContent>
                        </Dialog>
                      </div>
                    </div>
                    {/* Mobile */}
                    <div className="lg:hidden space-y-2">
                      <div className="flex items-center justify-between">
                        <div>
                          <span className="font-semibold text-[#485550]">{course.courseCode}</span>
                          <span className="text-[#485550]/40 mx-2">•</span>
                          <span className="text-[#485550]">{course.courseName}</span>
                        </div>
                        <div className="flex gap-1">
                          <Button variant="ghost" size="sm" onClick={(e) => { e.stopPropagation(); handleEditCourse(course); }}><Edit className="w-4 h-4" /></Button>
                          <Dialog>
                            <DialogTrigger asChild><Button variant="ghost" size="sm" className="text-red-500" onClick={(e) => e.stopPropagation()}><Trash2 className="w-4 h-4" /></Button></DialogTrigger>
                            <DialogContent>
                              <DialogHeader>
                                <DialogTitle>Delete Course</DialogTitle>
                                <DialogDescription>Delete "{course.courseCode}"?</DialogDescription>
                              </DialogHeader>
                              <div className="flex gap-3 justify-end">
                                <Button variant="outline">Cancel</Button>
                                <Button variant="destructive" onClick={() => handleDeleteCourse(course.id)}>Delete</Button>
                              </div>
                            </DialogContent>
                          </Dialog>
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {getLevelBadge(course.level)}
                        {getSemesterBadge(course.semester)}
                        <Badge variant="outline">{course.creditUnits} CR</Badge>
                        <Badge variant="outline" className={course.isCore ? 'text-blue-600' : 'text-purple-600'}>{course.isCore ? 'Core' : 'Elective'}</Badge>
                      </div>
                      <div className="text-sm text-[#485550]/60">{course.departmentName}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Grid View */}
      {viewMode === 'grid' && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filteredCourses.length === 0 ? (
            <Card className="col-span-full border-[#F4F6F0]">
              <CardContent className="p-8 text-center">
                <BookOpen className="w-12 h-12 text-[#485550]/30 mx-auto mb-4" />
                <h3 className="text-lg font-medium text-[#485550] mb-2">No courses found</h3>
                <p className="text-[#485550]/60">Try adjusting your search or filters.</p>
              </CardContent>
            </Card>
          ) : (
            filteredCourses.map((course) => (
              <Card key={course.id} className="border-[#F4F6F0] hover:shadow-md hover:border-[#C0EB6A] transition-all cursor-pointer" onClick={() => handleEditCourse(course)}>
                <CardContent className="p-4 space-y-3">
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <h3 className="font-semibold text-[#485550]">{course.courseCode}</h3>
                      <p className="text-sm text-[#485550]/80 line-clamp-2">{course.courseName}</p>
                    </div>
                    <div className="flex gap-1">
                      <Button variant="ghost" size="sm" onClick={(e) => { e.stopPropagation(); handleEditCourse(course); }}><Edit className="w-4 h-4 text-[#485550]" /></Button>
                      <Dialog>
                        <DialogTrigger asChild>
                          <Button variant="ghost" size="sm" className="text-red-500" onClick={(e) => e.stopPropagation()}><Trash2 className="w-4 h-4" /></Button>
                        </DialogTrigger>
                        <DialogContent>
                          <DialogHeader>
                            <DialogTitle>Delete Course</DialogTitle>
                            <DialogDescription>Delete "{course.courseCode}"?</DialogDescription>
                          </DialogHeader>
                          <div className="flex gap-3 justify-end">
                            <Button variant="outline">Cancel</Button>
                            <Button variant="destructive" onClick={() => handleDeleteCourse(course.id)}>Delete</Button>
                          </div>
                        </DialogContent>
                      </Dialog>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {getLevelBadge(course.level)}
                    {getSemesterBadge(course.semester)}
                    <Badge variant="outline" className={course.isCore ? 'bg-blue-50 text-blue-600' : 'bg-purple-50 text-purple-600'}>{course.isCore ? 'Core' : 'Elective'}</Badge>
                  </div>
                  <div className="space-y-1 text-sm text-[#485550]/70">
                    <p><strong>Department:</strong> {course.departmentName}</p>
                    <p><strong>Credits:</strong> {course.creditUnits}</p>
                    {course.prerequisites && course.prerequisites.length > 0 && (
                      <p><strong>Prerequisites:</strong> {course.prerequisites.join(', ')}</p>
                    )}
                  </div>
                  {course.description && (
                    <p className="text-sm text-[#485550]/60 line-clamp-2">{course.description}</p>
                  )}
                  <div className="pt-2 border-t border-[#F4F6F0]">
                    <p className="text-xs text-[#485550]/50 flex items-center gap-1"><Edit className="w-3 h-3" /> Click to edit</p>
                  </div>
                </CardContent>
              </Card>
            ))
          )}
        </div>
      )}
    </div>
  );
}
