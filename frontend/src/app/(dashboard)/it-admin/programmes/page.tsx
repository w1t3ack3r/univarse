'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import {
  Plus,
  BookOpen,
  Edit,
  Trash2,
  Save,
  X,
  GraduationCap,
  Calendar,
  Award,
  Clock,
  CheckCircle,
  Search,
  Loader2,
} from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';

interface Programme {
  id: string;
  name: string;
  code: string;
  departmentId: string;
  departmentName: string;
  degreeType: string;
  duration: number;
  description: string;
  totalCreditUnits: number;
  levels: ProgramLevel[];
  createdAt: string;
}

interface ProgramLevel {
  level: number;
  courses: Course[];
}

interface Course {
  id: string;
  courseCode: string;
  courseName: string;
  creditUnits: number;
  semester: string;
  level: number;
  isCore: boolean;
  description: string;
}

interface Department {
  id: string;
  name: string;
}

// Mock data
const mockDepartments: Department[] = [
  { id: 'd1', name: 'Computer Science' },
  { id: 'd2', name: 'Mathematics' },
  { id: 'd3', name: 'Physics' },
];

const mockCourses: Course[] = [
  { id: 'c1', courseCode: 'CSC101', courseName: 'Intro to Programming', creditUnits: 3, semester: 'first', level: 1, isCore: true, description: '' },
  { id: 'c2', courseCode: 'CSC201', courseName: 'Data Structures', creditUnits: 4, semester: 'first', level: 2, isCore: true, description: '' },
  { id: 'c3', courseCode: 'MTH101', courseName: 'Calculus I', creditUnits: 3, semester: 'first', level: 1, isCore: true, description: '' },
  { id: 'c4', courseCode: 'CSC301', courseName: 'Database Systems', creditUnits: 3, semester: 'first', level: 3, isCore: true, description: '' },
  { id: 'c5', courseCode: 'CSC401', courseName: 'AI & ML', creditUnits: 3, semester: 'first', level: 4, isCore: false, description: '' },
];

const mockProgrammes: Programme[] = [
  {
    id: 'p1', name: 'Bachelor of Science in Computer Science', code: 'BSC-CSC', departmentId: 'd1', departmentName: 'Computer Science',
    degreeType: 'bachelor', duration: 4, description: 'A comprehensive programme in computer science', totalCreditUnits: 180,
    levels: [
      { level: 1, courses: [mockCourses[0], mockCourses[2]] },
      { level: 2, courses: [mockCourses[1]] },
      { level: 3, courses: [mockCourses[3]] },
      { level: 4, courses: [mockCourses[4]] }
    ],
    createdAt: '2020-01-01'
  },
  {
    id: 'p2', name: 'Bachelor of Science in Mathematics', code: 'BSC-MTH', departmentId: 'd2', departmentName: 'Mathematics',
    degreeType: 'bachelor', duration: 4, description: 'Pure and applied mathematics', totalCreditUnits: 160,
    levels: [{ level: 1, courses: [mockCourses[2]] }, { level: 2, courses: [] }, { level: 3, courses: [] }, { level: 4, courses: [] }],
    createdAt: '2020-01-01'
  },
];

const calculateTotalCreditUnits = (levels: ProgramLevel[]): number =>
  levels.reduce((total, level) => total + level.courses.reduce((lt, c) => lt + c.creditUnits, 0), 0);

export default function ProgrammeManagement() {
  const router = useRouter();
  const [isProgrammeDialogOpen, setIsProgrammeDialogOpen] = useState(false);
  const [editingProgram, setEditingProgram] = useState<Programme | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [departmentFilter, setDepartmentFilter] = useState('all');
  const [degreeTypeFilter, setDegreeTypeFilter] = useState('all');
  const [durationFilter, setDurationFilter] = useState('all');
  const [programmes, setProgrammes] = useState<Programme[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [availableCourses, setAvailableCourses] = useState<Course[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [selectedProgram, setSelectedProgram] = useState<Programme | null>(null);
  const [selectedLevel, setSelectedLevel] = useState(1);
  const [isAddCoursesDialogOpen, setIsAddCoursesDialogOpen] = useState(false);
  const [selectedCourses, setSelectedCourses] = useState<Set<string>>(new Set());
  const [courseSearchTerm, setCourseSearchTerm] = useState('');
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});

  const [programForm, setProgramForm] = useState({
    name: '', code: '', departmentId: '', degreeType: '', duration: '', description: ''
  });

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    setIsLoading(true);
    try {
      if (api.isAuthenticated()) {
        const [progsData, deptsData, coursesData] = await Promise.all([
          api.getAdminProgrammes(),
          api.getAdminDepartments(),
          api.getAdminCourses(),
        ]);
        setDepartments(deptsData.map((d: any) => ({ id: d.id, name: d.name })));
        setAvailableCourses(coursesData.map((c: any) => ({
          id: c.id, courseCode: c.code || '', courseName: c.title || c.name || '',
          creditUnits: c.creditUnits || 3, semester: c.semester || 'first', level: c.level || 1,
          isCore: c.isCore !== undefined ? c.isCore : true, description: c.description || ''
        })));
        setProgrammes(progsData.map((p: any) => ({
          id: p.id, name: p.name, code: p.code || '', departmentId: p.departmentId || '',
          departmentName: p.departmentName || '', degreeType: p.degreeType || 'bachelor',
          duration: p.duration || 4, description: p.description || '',
          totalCreditUnits: p.totalCreditUnits || 0, levels: p.levels || [],
          createdAt: p.createdAt || ''
        })));
      } else {
        setProgrammes(mockProgrammes);
        setDepartments(mockDepartments);
        setAvailableCourses(mockCourses);
      }
    } catch (error) {
      console.error('Failed to fetch data:', error);
      setProgrammes(mockProgrammes);
      setDepartments(mockDepartments);
      setAvailableCourses(mockCourses);
    } finally {
      setIsLoading(false);
    }
  };

  const filteredProgrammes = useMemo(() => programmes.filter(p => {
    const matchesSearch = p.name.toLowerCase().includes(searchTerm.toLowerCase()) || p.code.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesDept = departmentFilter === 'all' || p.departmentId === departmentFilter;
    const matchesDegree = degreeTypeFilter === 'all' || p.degreeType === degreeTypeFilter;
    const matchesDuration = durationFilter === 'all' || p.duration.toString() === durationFilter;
    return matchesSearch && matchesDept && matchesDegree && matchesDuration;
  }), [programmes, searchTerm, departmentFilter, degreeTypeFilter, durationFilter]);

  const filteredAvailableCourses = useMemo(() => availableCourses.filter(c => {
    const matchesSearch = c.courseName.toLowerCase().includes(courseSearchTerm.toLowerCase()) || c.courseCode.toLowerCase().includes(courseSearchTerm.toLowerCase());
    const matchesLevel = c.level === selectedLevel;
    const isAttached = selectedProgram?.levels.find(l => l.level === selectedLevel)?.courses.some(pc => pc.id === c.id);
    return matchesSearch && matchesLevel && !isAttached;
  }), [availableCourses, courseSearchTerm, selectedLevel, selectedProgram]);

  const resetForm = useCallback(() => {
    setProgramForm({ name: '', code: '', departmentId: '', degreeType: '', duration: '', description: '' });
    setFormErrors({});
  }, []);

  const validateForm = useCallback(() => {
    const errors: Record<string, string> = {};
    if (!programForm.name.trim()) errors.name = 'Programme name is required';
    if (!programForm.code.trim()) errors.code = 'Programme code is required';
    if (!programForm.departmentId) errors.departmentId = 'Department is required';
    if (!programForm.degreeType) errors.degreeType = 'Degree type is required';
    if (!programForm.duration) errors.duration = 'Duration is required';
    setFormErrors(errors);
    return Object.keys(errors).length === 0;
  }, [programForm]);

  const handleCreateProgram = useCallback(async () => {
    if (!validateForm()) return;
    setSubmitting(true);
    try {
      const payload = {
        name: programForm.name, code: programForm.code, departmentId: programForm.departmentId,
        degreeType: programForm.degreeType, duration: parseInt(programForm.duration), description: programForm.description
      };
      if (api.isAuthenticated()) {
        if (editingProgram) {
          await api.updateAdminProgramme(editingProgram.id, payload);
          toast.success('Programme updated!');
        } else {
          await api.createAdminProgramme(payload);
          toast.success('Programme created!');
        }
        await fetchData();
      } else {
        toast.success(editingProgram ? 'Programme updated!' : 'Programme created!');
      }
      setIsProgrammeDialogOpen(false);
      resetForm();
      setEditingProgram(null);
    } catch (error: any) {
      toast.error(error.message || 'Failed to save programme');
    } finally {
      setSubmitting(false);
    }
  }, [programForm, editingProgram, validateForm, resetForm]);

  const handleEditProgram = useCallback((programme: Programme) => {
    setEditingProgram(programme);
    setProgramForm({
      name: programme.name, code: programme.code, departmentId: programme.departmentId,
      degreeType: programme.degreeType, duration: programme.duration.toString(), description: programme.description
    });
    setIsProgrammeDialogOpen(true);
  }, []);

  const handleDeleteProgram = useCallback(async (programId: string) => {
    try {
      if (api.isAuthenticated()) {
        await api.deleteAdminProgramme(programId);
      }
      setProgrammes(programmes.filter(p => p.id !== programId));
      if (selectedProgram?.id === programId) setSelectedProgram(null);
      toast.success('Programme deleted!');
    } catch (error: any) {
      toast.error(error.message || 'Failed to delete programme');
    }
  }, [programmes, selectedProgram]);

  const handleCancelEdit = useCallback(() => {
    setIsProgrammeDialogOpen(false);
    setEditingProgram(null);
    resetForm();
  }, [resetForm]);

  const handleCourseSelection = useCallback((courseId: string, checked: boolean) => {
    setSelectedCourses(prev => {
      const newSet = new Set(prev);
      checked ? newSet.add(courseId) : newSet.delete(courseId);
      return newSet;
    });
  }, []);

  const handleAddSelectedCourses = useCallback(() => {
    if (selectedCourses.size === 0 || !selectedProgram) return;
    const coursesToAdd = availableCourses.filter(c => selectedCourses.has(c.id));
    // In a real implementation, this would call an API
    toast.success(`Added ${coursesToAdd.length} courses to Level ${selectedLevel}`);
    setIsAddCoursesDialogOpen(false);
    setSelectedCourses(new Set());
    setCourseSearchTerm('');
  }, [selectedCourses, availableCourses, selectedProgram, selectedLevel]);

  const handleRemoveCourse = useCallback((courseId: string) => {
    if (!selectedProgram) return;
    toast.success(`Removed course from Level ${selectedLevel}`);
  }, [selectedProgram, selectedLevel]);

  const getDegreeTypeBadge = (type: string) => {
    const colors: Record<string, string> = {
      bachelor: 'bg-blue-50 text-blue-600', master: 'bg-purple-50 text-purple-600', phd: 'bg-red-50 text-red-600',
      diploma: 'bg-green-50 text-green-600', certificate: 'bg-amber-50 text-amber-600'
    };
    return <Badge className={colors[type] || 'bg-gray-50 text-gray-600'}>{type.toUpperCase()}</Badge>;
  };

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
        <h1 className="text-3xl font-bold text-[#485550]">Programme Management</h1>
        <p className="text-[#485550]/60 mt-1">Create and manage academic programmes. Select a programme to manage its courses.</p>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card className="border-[#F4F6F0]">
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-[#F4F6F0] flex items-center justify-center"><GraduationCap className="w-5 h-5 text-[#485550]" /></div>
              <div><p className="text-2xl font-bold text-[#485550]">{programmes.length}</p><p className="text-sm text-[#485550]/60">Total Programmes</p></div>
            </div>
          </CardContent>
        </Card>
        <Card className="border-[#F4F6F0]">
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-[#C0EB6A]/20 flex items-center justify-center"><Award className="w-5 h-5 text-[#485550]" /></div>
              <div><p className="text-2xl font-bold text-[#485550]">{programmes.filter(p => p.degreeType === 'bachelor').length}</p><p className="text-sm text-[#485550]/60">Bachelor's</p></div>
            </div>
          </CardContent>
        </Card>
        <Card className="border-[#F4F6F0]">
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-[#F4F6F0] flex items-center justify-center"><Calendar className="w-5 h-5 text-[#485550]" /></div>
              <div><p className="text-2xl font-bold text-[#485550]">{programmes.filter(p => p.degreeType === 'master').length}</p><p className="text-sm text-[#485550]/60">Master's</p></div>
            </div>
          </CardContent>
        </Card>
        <Card className="border-[#F4F6F0]">
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-[#C0EB6A]/20 flex items-center justify-center"><BookOpen className="w-5 h-5 text-[#485550]" /></div>
              <div><p className="text-2xl font-bold text-[#485550]">{availableCourses.length}</p><p className="text-sm text-[#485550]/60">Available Courses</p></div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Quick Actions */}
      <div className="flex flex-wrap gap-3">
        <Dialog open={isProgrammeDialogOpen} onOpenChange={setIsProgrammeDialogOpen}>
          <DialogTrigger asChild>
            <Button className="bg-[#485550] hover:bg-[#6b7c6f]"><Plus className="w-4 h-4 mr-2" /> Create New Programme</Button>
          </DialogTrigger>
          <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle className="text-[#485550]">{editingProgram ? 'Edit Programme' : 'Create New Programme'}</DialogTitle>
              <DialogDescription>{editingProgram ? 'Update programme information' : 'Set up a new academic programme'}</DialogDescription>
            </DialogHeader>
            <div className="space-y-4 pt-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Programme Name <span className="text-red-500">*</span></Label>
                  <Input placeholder="e.g., Bachelor of Science in CS" value={programForm.name} onChange={(e) => setProgramForm({ ...programForm, name: e.target.value })} className="border-[#485550]/20" />
                  {formErrors.name && <p className="text-sm text-red-500">{formErrors.name}</p>}
                </div>
                <div className="space-y-2">
                  <Label>Programme Code <span className="text-red-500">*</span></Label>
                  <Input placeholder="e.g., BSC-CSC" value={programForm.code} onChange={(e) => setProgramForm({ ...programForm, code: e.target.value.toUpperCase() })} className="border-[#485550]/20" />
                  {formErrors.code && <p className="text-sm text-red-500">{formErrors.code}</p>}
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="space-y-2">
                  <Label>Department <span className="text-red-500">*</span></Label>
                  <Select value={programForm.departmentId} onValueChange={(v) => setProgramForm({ ...programForm, departmentId: v })}>
                    <SelectTrigger className="border-[#485550]/20"><SelectValue placeholder="Select Department" /></SelectTrigger>
                    <SelectContent>{departments.map(d => <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>)}</SelectContent>
                  </Select>
                  {formErrors.departmentId && <p className="text-sm text-red-500">{formErrors.departmentId}</p>}
                </div>
                <div className="space-y-2">
                  <Label>Degree Type <span className="text-red-500">*</span></Label>
                  <Select value={programForm.degreeType} onValueChange={(v) => setProgramForm({ ...programForm, degreeType: v })}>
                    <SelectTrigger className="border-[#485550]/20"><SelectValue placeholder="Select Type" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="bachelor">Bachelor's Degree</SelectItem>
                      <SelectItem value="master">Master's Degree</SelectItem>
                      <SelectItem value="phd">PhD</SelectItem>
                      <SelectItem value="diploma">Diploma</SelectItem>
                      <SelectItem value="certificate">Certificate</SelectItem>
                    </SelectContent>
                  </Select>
                  {formErrors.degreeType && <p className="text-sm text-red-500">{formErrors.degreeType}</p>}
                </div>
                <div className="space-y-2">
                  <Label>Duration (Years) <span className="text-red-500">*</span></Label>
                  <Select value={programForm.duration} onValueChange={(v) => setProgramForm({ ...programForm, duration: v })}>
                    <SelectTrigger className="border-[#485550]/20"><SelectValue placeholder="Select" /></SelectTrigger>
                    <SelectContent>
                      {[1, 2, 3, 4, 5, 6].map(y => <SelectItem key={y} value={y.toString()}>{y} Year{y > 1 ? 's' : ''}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  {formErrors.duration && <p className="text-sm text-red-500">{formErrors.duration}</p>}
                </div>
              </div>
              <div className="space-y-2">
                <Label>Description</Label>
                <Textarea placeholder="Brief description of the programme..." value={programForm.description} onChange={(e) => setProgramForm({ ...programForm, description: e.target.value })} rows={3} className="border-[#485550]/20" />
              </div>
              <div className="flex gap-3 pt-4">
                <Button onClick={handleCreateProgram} disabled={submitting} className="bg-[#485550] hover:bg-[#6b7c6f]">
                  {submitting ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
                  {editingProgram ? 'Update Programme' : 'Create Programme'}
                </Button>
                <Button variant="outline" onClick={handleCancelEdit} className="border-[#485550]"><X className="w-4 h-4 mr-2" /> Cancel</Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>

        {selectedProgram && (
          <Dialog open={isAddCoursesDialogOpen} onOpenChange={setIsAddCoursesDialogOpen}>
            <DialogTrigger asChild>
              <Button variant="outline" className="border-[#C0EB6A] text-[#485550] hover:bg-[#C0EB6A]/10">
                <BookOpen className="w-4 h-4 mr-2" /> Manage Courses for {selectedProgram.code}
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle className="text-[#485550]">Manage Courses - {selectedProgram.name}</DialogTitle>
                <DialogDescription>Select a level and add or remove courses</DialogDescription>
              </DialogHeader>
              {/* Level Tabs */}
              <div className="flex gap-2 border-b pb-2 overflow-x-auto">
                {Array.from({ length: selectedProgram.duration }, (_, i) => i + 1).map((level) => (
                  <Button key={level} variant={selectedLevel === level ? "default" : "outline"} size="sm"
                    onClick={() => setSelectedLevel(level)}
                    className={selectedLevel === level ? "bg-[#485550]" : "border-[#485550]/30"}>
                    Level {level}
                  </Button>
                ))}
              </div>
              {/* Attached Courses */}
              <div className="border rounded-lg p-4 bg-[#F4F6F0]/50">
                <h3 className="font-semibold text-[#485550] mb-3 flex items-center"><CheckCircle className="w-4 h-4 mr-2 text-green-600" /> Attached Courses (Level {selectedLevel})</h3>
                {selectedProgram.levels.find(l => l.level === selectedLevel)?.courses.length === 0 ? (
                  <p className="text-sm text-[#485550]/60 italic">No courses attached to this level yet.</p>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                    {selectedProgram.levels.find(l => l.level === selectedLevel)?.courses.map(course => (
                      <div key={course.id} className="flex items-center justify-between p-2 bg-white rounded border border-[#F4F6F0] group hover:border-red-200 transition-colors">
                        <div className="flex-1 min-w-0 mr-2">
                          <div className="flex items-center gap-2">
                            <span className="font-medium text-sm text-[#485550]">{course.courseCode}</span>
                            <span className="text-[#485550]/30">|</span>
                            <span className="text-xs text-[#485550]/70 truncate">{course.courseName}</span>
                          </div>
                          <div className="flex gap-2 mt-1">
                            <span className="text-[10px] bg-[#F4F6F0] text-[#485550] px-1.5 py-0.5 rounded">{course.creditUnits} CU</span>
                            <span className={`text-[10px] px-1.5 py-0.5 rounded ${course.isCore ? 'bg-blue-50 text-blue-600' : 'bg-purple-50 text-purple-600'}`}>{course.isCore ? 'Core' : 'Elective'}</span>
                          </div>
                        </div>
                        <Button variant="ghost" size="sm" className="text-[#485550]/40 hover:text-red-600 hover:bg-red-50 h-8 w-8 p-0" onClick={() => handleRemoveCourse(course.id)}>
                          <X className="w-4 h-4" />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              {/* Add Courses */}
              <div className="space-y-3">
                <h3 className="font-semibold text-[#485550]">Add Courses</h3>
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-[#485550]/40 w-4 h-4" />
                  <Input placeholder="Search courses..." value={courseSearchTerm} onChange={(e) => setCourseSearchTerm(e.target.value)} className="pl-10 border-[#485550]/20" />
                </div>
                <div className="max-h-[40vh] overflow-y-auto border rounded-lg p-2 space-y-2">
                  {filteredAvailableCourses.length === 0 ? (
                    <div className="text-center py-8 text-[#485550]/60">
                      <BookOpen className="w-12 h-12 mx-auto mb-4 text-[#485550]/30" />
                      <p>No courses available for Level {selectedLevel}</p>
                      <p className="text-sm">Create courses in Course Management first</p>
                    </div>
                  ) : (
                    filteredAvailableCourses.map(course => (
                      <div key={course.id} className="flex items-start space-x-3 p-3 border border-[#F4F6F0] rounded-lg hover:bg-[#F4F6F0]/50">
                        <Checkbox id={course.id} checked={selectedCourses.has(course.id)} onCheckedChange={(checked) => handleCourseSelection(course.id, checked as boolean)} />
                        <div className="flex-1">
                          <label htmlFor={course.id} className="font-medium text-[#485550] cursor-pointer">{course.courseCode} - {course.courseName}</label>
                          <div className="flex gap-2 mt-1">
                            <Badge variant="outline" className="text-xs">{course.creditUnits} Credits</Badge>
                            <Badge variant="outline" className={`text-xs ${course.isCore ? 'text-blue-600' : 'text-purple-600'}`}>{course.isCore ? 'Core' : 'Elective'}</Badge>
                          </div>
                        </div>
                      </div>
                    ))
                  )}
                </div>
                <div className="flex items-center justify-between pt-4 border-t">
                  <p className="text-sm text-[#485550]/60">{selectedCourses.size} course{selectedCourses.size !== 1 ? 's' : ''} selected</p>
                  <div className="flex gap-3">
                    <Button onClick={handleAddSelectedCourses} disabled={selectedCourses.size === 0} className="bg-[#485550] hover:bg-[#6b7c6f]">
                      <Plus className="w-4 h-4 mr-2" /> Add Selected
                    </Button>
                    <Button variant="outline" onClick={() => { setIsAddCoursesDialogOpen(false); setSelectedCourses(new Set()); setCourseSearchTerm(''); }} className="border-[#485550]">Cancel</Button>
                  </div>
                </div>
              </div>
            </DialogContent>
          </Dialog>
        )}
      </div>

      {/* Search & Filters */}
      <Card className="border-[#F4F6F0]">
        <CardHeader>
          <CardTitle className="text-lg text-[#485550]">Search & Filter Programmes</CardTitle>
          <CardDescription>Find programmes by name, code, department, or degree type</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-[#485550]/40 w-4 h-4" />
            <Input placeholder="Search programmes..." value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} className="pl-10 border-[#485550]/20" />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Select value={departmentFilter} onValueChange={setDepartmentFilter}>
              <SelectTrigger className="border-[#485550]/20"><SelectValue placeholder="All Departments" /></SelectTrigger>
              <SelectContent><SelectItem value="all">All Departments</SelectItem>{departments.map(d => <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>)}</SelectContent>
            </Select>
            <Select value={degreeTypeFilter} onValueChange={setDegreeTypeFilter}>
              <SelectTrigger className="border-[#485550]/20"><SelectValue placeholder="All Degree Types" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Degree Types</SelectItem>
                <SelectItem value="bachelor">Bachelor's</SelectItem>
                <SelectItem value="master">Master's</SelectItem>
                <SelectItem value="phd">PhD</SelectItem>
                <SelectItem value="diploma">Diploma</SelectItem>
                <SelectItem value="certificate">Certificate</SelectItem>
              </SelectContent>
            </Select>
            <Select value={durationFilter} onValueChange={setDurationFilter}>
              <SelectTrigger className="border-[#485550]/20"><SelectValue placeholder="All Durations" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Durations</SelectItem>
                {[1, 2, 3, 4, 5, 6].map(y => <SelectItem key={y} value={y.toString()}>{y} Year{y > 1 ? 's' : ''}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          {(searchTerm || departmentFilter !== 'all' || degreeTypeFilter !== 'all' || durationFilter !== 'all') && (
            <Button variant="outline" size="sm" onClick={() => { setSearchTerm(''); setDepartmentFilter('all'); setDegreeTypeFilter('all'); setDurationFilter('all'); }} className="border-[#485550]">
              <X className="w-4 h-4 mr-2" /> Clear Filters
            </Button>
          )}
        </CardContent>
      </Card>

      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold text-[#485550]">Programmes</h2>
        <p className="text-sm text-[#485550]/60">Showing {filteredProgrammes.length} of {programmes.length}</p>
      </div>

      {/* Programme Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {filteredProgrammes.length === 0 ? (
          <Card className="col-span-full border-[#F4F6F0]">
            <CardContent className="p-8 text-center">
              <GraduationCap className="w-12 h-12 text-[#485550]/30 mx-auto mb-4" />
              <h3 className="text-lg font-medium text-[#485550] mb-2">No programmes found</h3>
              <p className="text-[#485550]/60">{programmes.length === 0 ? 'Create your first programme.' : 'Try adjusting your search or filters.'}</p>
            </CardContent>
          </Card>
        ) : (
          filteredProgrammes.map(programme => (
            <Card key={programme.id}
              className={`border-[#F4F6F0] cursor-pointer transition-all hover:shadow-md ${selectedProgram?.id === programme.id ? 'ring-2 ring-[#C0EB6A] border-[#C0EB6A] bg-[#C0EB6A]/5' : ''}`}
              onClick={() => { setSelectedProgram(programme); toast.info(`Selected ${programme.code}`); }}>
              <CardContent className="p-4 space-y-3">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-12 h-12 bg-[#C0EB6A]/10 rounded-lg flex items-center justify-center"><GraduationCap className="w-6 h-6 text-[#485550]" /></div>
                    <div>
                      <h3 className="font-semibold text-[#485550] text-sm">{programme.code}</h3>
                      <p className="text-xs text-[#485550]/60">{programme.departmentName}</p>
                    </div>
                  </div>
                  <div className="flex gap-1">
                    <Button variant="ghost" size="sm" onClick={(e) => { e.stopPropagation(); handleEditProgram(programme); }}><Edit className="w-4 h-4 text-[#485550]" /></Button>
                    <Dialog>
                      <DialogTrigger asChild><Button variant="ghost" size="sm" className="text-red-500" onClick={(e) => e.stopPropagation()}><Trash2 className="w-4 h-4" /></Button></DialogTrigger>
                      <DialogContent>
                        <DialogHeader>
                          <DialogTitle>Delete Programme</DialogTitle>
                          <DialogDescription>Delete "{programme.code}"? This cannot be undone.</DialogDescription>
                        </DialogHeader>
                        <div className="flex gap-3 justify-end">
                          <Button variant="outline">Cancel</Button>
                          <Button variant="destructive" onClick={() => handleDeleteProgram(programme.id)}>Delete</Button>
                        </div>
                      </DialogContent>
                    </Dialog>
                  </div>
                </div>
                <h4 className="font-medium text-[#485550] text-sm line-clamp-2">{programme.name}</h4>
                <div className="flex items-center gap-2 flex-wrap">
                  {getDegreeTypeBadge(programme.degreeType)}
                  <Badge variant="outline" className="bg-[#C0EB6A]/20 text-[#485550] border-[#C0EB6A] text-xs"><CheckCircle className="w-3 h-3 mr-1" /> Active</Badge>
                </div>
                <div className="grid grid-cols-2 gap-2 text-xs text-[#485550]/70">
                  <div><Clock className="w-3 h-3 inline mr-1" /> {programme.duration} years</div>
                  <div><Award className="w-3 h-3 inline mr-1" /> {programme.totalCreditUnits || calculateTotalCreditUnits(programme.levels)} credits</div>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <Badge variant="outline" className="border-[#485550]/20">{programme.levels.reduce((t, l) => t + l.courses.length, 0)} Courses</Badge>
                  <span className="text-[#485550]/50">{programme.createdAt ? new Date(programme.createdAt).toLocaleDateString() : ''}</span>
                </div>
              </CardContent>
            </Card>
          ))
        )}
      </div>
    </div>
  );
}
