'use client';

import { useState, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import {
  ArrowLeft,
  GraduationCap,
  Clock,
  Award,
  BookOpen,
  Library,
  Calendar,
  Edit,
  Trash2,
  Plus,
  Search,
  CheckCircle,
  Users,
  Building
} from 'lucide-react';
import { toast } from 'sonner';
import type { Programme, Course, ProgramLevel } from '@/types/program';

// Helper function to calculate total credit units for a programme
const calculateTotalCreditUnits = (levels: ProgramLevel[]): number => {
  return levels.reduce((total, level) => total + level.courses.reduce((levelTotal, course) => levelTotal + course.creditUnits, 0), 0);
};

const ProgrammeDetail = () => {
  const { id: programmeId } = useParams<{ id: string }>();
  const router = useRouter();
  const [programme, setProgramme] = useState<Programme | null>(null);
  const [selectedLevel, setSelectedLevel] = useState<number>(1);
  const [isAddCoursesDialogOpen, setIsAddCoursesDialogOpen] = useState(false);
  const [courseSearchTerm, setCourseSearchTerm] = useState('');
  const [selectedCourses, setSelectedCourses] = useState<string[]>([]);

  // Mock data - in real app this would come from API based on programmeId
  const mockProgramme: Programme = {
    id: programmeId || 'prog_001',
    name: 'Bachelor of Science in Cybersecurity',
    code: 'BSC-CYB',
    departmentId: 'dept_001',
    departmentName: 'Computer Science',
    degreeType: 'bachelor',
    duration: 4,
    description: 'Comprehensive cybersecurity program covering network security, ethical hacking, and digital forensics.',
    levels: [
      {
        level: 1,
        courses: [
          {
            id: 'course_001',
            courseCode: 'CSC101',
            courseName: 'Introduction to Computer Science',
            creditUnits: 3,
            semester: 'first',
            level: 1,
            isCore: true,
            departmentId: 'dept_001',
            departmentName: 'Computer Science',
            description: 'Basic concepts of computer science and programming fundamentals'
          },
          {
            id: 'course_002',
            courseCode: 'CSC102',
            courseName: 'Programming Fundamentals',
            creditUnits: 4,
            semester: 'second',
            level: 1,
            isCore: true,
            departmentId: 'dept_001',
            departmentName: 'Computer Science',
            description: 'Introduction to programming concepts and problem solving'
          },
          {
            id: 'course_003',
            courseCode: 'CSC101',
            courseName: 'Cybersecurity Fundamentals',
            creditUnits: 4,
            semester: 'first',
            level: 1,
            isCore: true,
            departmentId: 'dept_001',
            departmentName: 'Computer Science',
            description: 'Introduction to programming concepts and problem solving'
          }
        ]
      },
      {
        level: 2,
        courses: [
          {
            id: 'course_003',
            courseCode: 'CSC201',
            courseName: 'Data Structures and Algorithms',
            creditUnits: 3,
            semester: 'first',
            level: 2,
            isCore: true,
            departmentId: 'dept_001',
            departmentName: 'Computer Science',
            prerequisites: ['CSC102'],
            description: 'Advanced data structures and algorithmic problem solving'
          }
        ]
      }
    ],
    totalCreditUnits: 10,
    isActive: true,
    createdAt: '2024-09-01T10:00:00Z',
    createdBy: 'Admin User'
  };

  // Available courses from Course Management
  const availableCourses: Course[] = [
    {
      id: 'course_004',
      courseCode: 'MTH101',
      courseName: 'Mathematics I',
      creditUnits: 3,
      semester: 'first',
      level: 1,
      isCore: true,
      departmentId: 'dept_001',
      departmentName: 'Computer Science',
      description: 'Fundamental mathematics for computer science students'
    },
    {
      id: 'course_005',
      courseCode: 'PHY101',
      courseName: 'Physics I',
      creditUnits: 3,
      semester: 'first',
      level: 1,
      isCore: true,
      departmentId: 'dept_001',
      departmentName: 'Computer Science',
      description: 'Basic physics concepts for engineering students'
    }
  ];

  useEffect(() => {
    // In real app, fetch programme data based on programmeId
    setProgramme(mockProgramme);
  }, [programmeId]);

  // Filter available courses for selection
  const filteredAvailableCourses = availableCourses.filter(course => {
    const matchesSearch = course.courseName.toLowerCase().includes(courseSearchTerm.toLowerCase()) ||
      course.courseCode.toLowerCase().includes(courseSearchTerm.toLowerCase());
    const matchesProgramLevel = course.level === selectedLevel;

    return matchesSearch && matchesProgramLevel;
  });

  const handleAddSelectedCourses = () => {
    if (selectedCourses.length === 0) {
      toast.error('Please select at least one course');
      return;
    }

    const coursesToAdd = availableCourses.filter(course => selectedCourses.includes(course.id));

    // Check for duplicates in the selected level
    const existingCourses = programme?.levels.find(l => l.level === selectedLevel)?.courses || [];
    const duplicates = coursesToAdd.filter(course =>
      existingCourses.some(existing => existing.id === course.id)
    );

    if (duplicates.length > 0) {
      toast.error(`Some courses are already added to this level: ${duplicates.map(c => c.courseCode).join(', ')}`);
      return;
    }

    // Update the programme with new courses
    if (programme) {
      const updatedProgramme = {
        ...programme,
        levels: programme.levels.map(level =>
          level.level === selectedLevel
            ? { ...level, courses: [...level.courses, ...coursesToAdd] }
            : level
        )
      };

      // Update total credit units
      updatedProgramme.totalCreditUnits = calculateTotalCreditUnits(updatedProgramme.levels);

      setProgramme(updatedProgramme);
    }

    toast.success(`Added ${coursesToAdd.length} courses to Level ${selectedLevel}`);
    setIsAddCoursesDialogOpen(false);
    setSelectedCourses([]);
    setCourseSearchTerm('');
  };

  const handleRemoveCourseFromProgram = (courseId: string) => {
    if (programme) {
      const updatedProgramme = {
        ...programme,
        levels: programme.levels.map(level =>
          level.level === selectedLevel
            ? { ...level, courses: level.courses.filter(c => c.id !== courseId) }
            : level
        )
      };

      // Update total credit units
      updatedProgramme.totalCreditUnits = calculateTotalCreditUnits(updatedProgramme.levels);

      setProgramme(updatedProgramme);

      const removedCourse = programme.levels
        .find(l => l.level === selectedLevel)?.courses
        .find(c => c.id === courseId);

      if (removedCourse) {
        toast.success(`Removed ${removedCourse.courseCode} from Level ${selectedLevel}`);
      }
    }
  };

  const handleCourseSelection = (courseId: string, checked: boolean) => {
    if (checked) {
      setSelectedCourses([...selectedCourses, courseId]);
    } else {
      setSelectedCourses(selectedCourses.filter(id => id !== courseId));
    }
  };

  const getDegreeTypeBadge = (type: string) => {
    const colors = {
      bachelor: 'bg-blue-50 text-blue-600',
      master: 'bg-purple-50 text-purple-600',
      phd: 'bg-red-50 text-red-600',
      diploma: 'bg-green-50 text-green-600',
      certificate: 'bg-yellow-50 text-yellow-600'
    };
    return <Badge variant='outline' className={colors[type as keyof typeof colors] || 'bg-gray-50 text-gray-600'}>
      {type.toUpperCase()}
    </Badge>;
  };

  const getSemesterBadge = (semester: string) => {
    return <Badge variant="outline" className={semester === 'first' ? 'text-blue-600' : 'text-green-600'}>
      {semester === 'first' ? '1st Semester' : '2nd Semester'}
    </Badge>;
  };

  if (!programme) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="text-center">
          <GraduationCap className="w-12 h-12 text-gray-400 mx-auto mb-4" />
          <p className="text-gray-500">Loading programme details...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header with Back Button */}
      <div className="flex items-center space-x-4">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => router.push('/it-admin/programmes')}
          className="flex items-center space-x-2"
        >
          <ArrowLeft className="h-4 w-4" />
          <span>Back to Programmes</span>
        </Button>
      </div>

      {/* Programme Overview Card */}
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between">
            <div className="flex-1">
              <CardTitle className="gap-3">
                <div className=' text-2xl text-brand flex items-center gap-2'>
                  <div className="w-12 h-12 bg-[#C0EB6A]/10 rounded-lg flex items-center justify-center">
                    <GraduationCap className="w-7 h-7 text-[#485550]" />
                  </div>
                  <div>
                    {programme.name}
                    <div className='font-normal text-base'>
                      {programme.code} • {programme.departmentName}
                    </div>
                  </div>
                </div>
              </CardTitle>
            </div>
            <div className="flex gap-2 flex-wrap">
              {getDegreeTypeBadge(programme.degreeType)}
              <Badge variant="outline" className="text-green-600">
                <CheckCircle className="w-3 h-3 mr-1" />
                Active
              </Badge>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
            <div className="flex items-center p-4 bg-gray-50 rounded-lg gap-3">
              <div className='w-10 h-10 rounded-lg bg-blue-50 flex items-center justify-center'>
                <Clock className="w-5 h-5 text-blue-600" />
              </div>
              <div>
                <p className="text-2xl font-bold text-gray-900">{programme.duration}</p>
                <p className="text-sm text-gray-600">Years</p>
              </div>
            </div>
            <div className="flex items-center p-4 bg-gray-50 rounded-lg gap-3">
              <div className='w-10 h-10 rounded-lg bg-green-50 flex items-center justify-center'>
                <Award className="w-5 h-5 text-green-600" />
              </div>
              <div>
                <p className="text-2xl font-bold text-gray-900">{programme.totalCreditUnits}</p>
                <p className="text-sm text-gray-600">Total Credits</p>
              </div>
            </div>
            <div className="flex items-center p-4 bg-gray-50 rounded-lg gap-3">
              <div className='w-10 h-10 rounded-lg bg-purple-50 flex items-center justify-center'>
                <BookOpen className="w-5 h-5 text-purple-600" />
              </div>
              <div>
                <p className="text-2xl font-bold text-gray-900">{programme.levels.reduce((total, level) => total + level.courses.length, 0)}</p>
                <p className="text-sm text-gray-600">Total Courses</p>
              </div>
            </div>
            <div className="flex items-center p-4 bg-gray-50 rounded-lg gap-3">
              <div className='w-10 h-10 rounded-lg bg-purple-50 flex items-center justify-center'>
                <GraduationCap className="w-5 h-5 text-purple-600" />
              </div>
              <div>
                <p className="text-2xl font-bold text-gray-900">{programme.levels.reduce((total, level) => total + level.courses.length, 0)}</p>
                <p className="text-sm text-gray-600">Student Enrolled</p>
              </div>
            </div>
          </div>

          {programme.description && (
            <div className="mt-6 p-4 bg-blue-50 rounded-lg">
              <h4 className="font-medium text-gray-900 mb-2">Programme Description</h4>
              <p className="text-gray-700">{programme.description}</p>
            </div>
          )}

          <div className="mt-6 flex items-center justify-between text-sm text-gray-500">
            <span>Created on {new Date(programme.createdAt).toLocaleDateString()}</span>
            <span>by {programme.createdBy}</span>
          </div>
        </CardContent>
      </Card>

      {/* Course Structure */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2">
              <Library className="w-5 h-5" />
              Course Structure
            </CardTitle>
            <div className="flex gap-2">
              {Array.from({ length: programme.duration }, (_, i) => (
                <Button
                  key={i + 1}
                  variant={selectedLevel === i + 1 ? "default" : "outline"}
                  size="sm"
                  onClick={() => setSelectedLevel(i + 1)}
                >
                  Level {i + 1}
                </Button>
              ))}
            </div>
          </div>
          <CardDescription>
            Courses assigned to Level {selectedLevel} of the programme
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-4">
              <h3 className="text-lg font-semibold">Level {selectedLevel} Courses</h3>
              <Dialog open={isAddCoursesDialogOpen} onOpenChange={setIsAddCoursesDialogOpen}>
                <DialogTrigger asChild>
                  <Button variant="outline" size="sm">
                    <Plus className="w-4 h-4 mr-2" />
                    Add Courses
                  </Button>
                </DialogTrigger>
                <DialogContent className="max-w-5xl max-h-[90vh] overflow-y-auto">
                  <DialogHeader>
                    <DialogTitle>Add Courses to {programme.name} - Level {selectedLevel}</DialogTitle>
                    <DialogDescription>
                      Select courses from the course library to add to this programme level
                    </DialogDescription>
                  </DialogHeader>
                  <div className="space-y-4">
                    {/* Search */}
                    <div className="relative">
                      <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-4 h-4" />
                      <input
                        type="text"
                        placeholder="Search courses..."
                        value={courseSearchTerm}
                        onChange={(e) => setCourseSearchTerm(e.target.value)}
                        className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-[#C0EB6A] focus:border-transparent"
                      />
                    </div>

                    {/* Available Courses */}
                    <div className="max-h-96 overflow-y-auto space-y-3">
                      {filteredAvailableCourses.length === 0 ? (
                        <div className="text-center py-8 text-gray-500">
                          <BookOpen className="w-12 h-12 mx-auto mb-4 text-gray-300" />
                          <p>No courses available for Level {selectedLevel}</p>
                          <p className="text-sm">Try adjusting your search or create courses in Course Management first</p>
                        </div>
                      ) : (
                        filteredAvailableCourses.map((course) => (
                          <div key={course.id} className="flex items-start space-x-3 p-3 border border-gray-200 rounded-lg">
                            <input
                              type="checkbox"
                              id={course.id}
                              checked={selectedCourses.includes(course.id)}
                              onChange={(e) => handleCourseSelection(course.id, e.target.checked)}
                              className="mt-1"
                            />
                            <div className="flex-1">
                              <div className="flex items-start justify-between">
                                <div>
                                  <h4 className="font-medium text-gray-900">{course.courseCode} - {course.courseName}</h4>
                                  <p className="text-sm text-gray-600 mt-1">{course.description}</p>
                                </div>
                                <div className="flex gap-2 ml-4">
                                  {getSemesterBadge(course.semester)}
                                  <Badge variant="outline">{course.creditUnits} Credits</Badge>
                                  <Badge variant="outline" className={course.isCore ? 'text-blue-600' : 'text-purple-600'}>
                                    {course.isCore ? 'Core' : 'Elective'}
                                  </Badge>
                                </div>
                              </div>
                              {course.prerequisites && course.prerequisites.length > 0 && (
                                <p className="text-sm text-gray-500 mt-2">
                                  <strong>Prerequisites:</strong> {course.prerequisites.join(', ')}
                                </p>
                              )}
                            </div>
                          </div>
                        ))
                      )}
                    </div>

                    {/* Actions */}
                    <div className="flex items-center justify-between pt-4 border-t">
                      <p className="text-sm text-gray-600">
                        {selectedCourses.length} course{selectedCourses.length !== 1 ? 's' : ''} selected
                      </p>
                      <div className="flex gap-3">
                        <Button onClick={handleAddSelectedCourses} disabled={selectedCourses.length === 0}>
                          <Plus className="w-4 h-4 mr-2" />
                          Add Selected Courses
                        </Button>
                        <Button
                          variant="outline"
                          onClick={() => {
                            setIsAddCoursesDialogOpen(false);
                            setSelectedCourses([]);
                            setCourseSearchTerm('');
                          }}
                        >
                          Cancel
                        </Button>
                      </div>
                    </div>
                  </div>
                </DialogContent>
              </Dialog>
            </div>
          </div>

          {programme.levels.find(l => l.level === selectedLevel)?.courses.length === 0 ? (
            <div className="text-center py-12">
              <BookOpen className="w-16 h-16 text-gray-300 mx-auto mb-4" />
              <h3 className="text-lg font-medium text-gray-900 mb-2">No courses in Level {selectedLevel}</h3>
              <p className="text-gray-500 mb-4">Start building your programme by adding courses from the library</p>
            </div>
          ) : (
            <div className="space-y-6">
              {/* Group by semester */}
              {['first', 'second'].map(semester => {
                const semesterCourses = programme.levels
                  .find(l => l.level === selectedLevel)?.courses
                  .filter(c => c.semester === semester) || [];

                if (semesterCourses.length === 0) return null;

                return (
                  <div key={semester} className="space-y-4">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 bg-[#C0EB6A]/10 rounded-lg flex items-center justify-center">
                        <Calendar className="w-4 h-4 text-[#485550]" />
                      </div>
                      <h3 className="text-lg font-semibold text-gray-900">
                        {semester === 'first' ? 'First Semester' : 'Second Semester'}
                      </h3>
                      <Badge variant="outline" className="ml-auto">
                        {semesterCourses.length} course{semesterCourses.length !== 1 ? 's' : ''}
                      </Badge>
                    </div>

                    <div className="grid gap-4 ml-11">
                      {semesterCourses.map((course) => (
                        <Card key={course.id} className="border-l-4 border-l-[#C0EB6A]">
                          <CardContent className="p-4">
                            <div className="flex items-start justify-between">
                              <div className="flex-1">
                                <div className="flex items-center gap-3 mb-2">
                                  <h4 className="font-semibold text-gray-900">{course.courseCode}</h4>
                                  <Badge variant="outline" className={course.isCore ? 'text-blue-600' : 'text-purple-600'}>
                                    {course.isCore ? 'Core' : 'Elective'}
                                  </Badge>
                                  <Badge variant="outline">{course.creditUnits} Credits</Badge>
                                </div>
                                <h5 className="font-medium text-gray-800 mb-2">{course.courseName}</h5>
                                <p className="text-sm text-gray-600 mb-3">{course.description}</p>

                                {course.prerequisites && course.prerequisites.length > 0 && (
                                  <div className="text-sm text-gray-500">
                                    <strong>Prerequisites:</strong> {course.prerequisites.join(', ')}
                                  </div>
                                )}
                              </div>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="text-red-600 hover:text-red-700 hover:bg-red-50"
                                onClick={() => handleRemoveCourseFromProgram(course.id)}
                              >
                                <Trash2 className="w-4 h-4" />
                              </Button>
                            </div>
                          </CardContent>
                        </Card>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
};

export default ProgrammeDetail;
