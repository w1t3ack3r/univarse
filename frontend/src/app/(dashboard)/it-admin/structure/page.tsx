'use client';

import { useEffect, useState } from 'react';
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
  Building2,
  Users,
  Edit,
  Trash2,
  Save,
  X,
  Search,
  CheckCircle,
  Loader2,
  Download,
  GraduationCap,
  BookOpen,
} from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';

interface Faculty {
  id: string;
  name: string;
  code: string;
  description: string;
  dean: string;
  isActive: boolean;
  createdAt: string;
}

interface Department {
  id: string;
  name: string;
  code: string;
  facultyId: string;
  facultyName: string;
  description: string;
  head: string;
  isActive: boolean;
  createdAt: string;
}

// Mock data
const mockFaculties: Faculty[] = [
  { id: 'f1', name: 'Faculty of Science', code: 'SCI', description: 'Natural and Applied Sciences', dean: 'Prof. Adebayo', isActive: true, createdAt: '2020-01-01' },
  { id: 'f2', name: 'Faculty of Engineering', code: 'ENG', description: 'Engineering and Technology', dean: 'Prof. Okonkwo', isActive: true, createdAt: '2020-01-01' },
  { id: 'f3', name: 'Faculty of Arts', code: 'ART', description: 'Humanities and Social Sciences', dean: 'Prof. Nwosu', isActive: true, createdAt: '2020-01-01' },
  { id: 'f4', name: 'Faculty of Management', code: 'MGT', description: 'Business and Management Sciences', dean: 'Prof. Ibrahim', isActive: true, createdAt: '2020-01-01' },
];

const mockDepartments: Department[] = [
  { id: 'd1', name: 'Computer Science', code: 'CSC', facultyId: 'f1', facultyName: 'Faculty of Science', description: 'Computing and Information Technology', head: 'Dr. Ajayi', isActive: true, createdAt: '2020-01-01' },
  { id: 'd2', name: 'Mathematics', code: 'MTH', facultyId: 'f1', facultyName: 'Faculty of Science', description: 'Pure and Applied Mathematics', head: 'Dr. Bello', isActive: true, createdAt: '2020-01-01' },
  { id: 'd3', name: 'Civil Engineering', code: 'CVE', facultyId: 'f2', facultyName: 'Faculty of Engineering', description: 'Civil and Structural Engineering', head: 'Dr. Chukwu', isActive: true, createdAt: '2020-01-01' },
  { id: 'd4', name: 'Electrical Engineering', code: 'EEE', facultyId: 'f2', facultyName: 'Faculty of Engineering', description: 'Electrical and Electronics', head: 'Dr. Danjuma', isActive: true, createdAt: '2020-01-01' },
  { id: 'd5', name: 'English', code: 'ENG', facultyId: 'f3', facultyName: 'Faculty of Arts', description: 'English Language and Literature', head: 'Dr. Emeka', isActive: true, createdAt: '2020-01-01' },
];

export default function AcademicStructure() {
  const [activeTab, setActiveTab] = useState<'faculties' | 'departments'>('faculties');
  const [isCreatingFaculty, setIsCreatingFaculty] = useState(false);
  const [isCreatingDepartment, setIsCreatingDepartment] = useState(false);
  const [editingFaculty, setEditingFaculty] = useState<Faculty | null>(null);
  const [editingDepartment, setEditingDepartment] = useState<Department | null>(null);
  const [facultySearchTerm, setFacultySearchTerm] = useState('');
  const [departmentSearchTerm, setDepartmentSearchTerm] = useState('');
  const [departmentFacultyFilter, setDepartmentFacultyFilter] = useState('all');
  const [faculties, setFaculties] = useState<Faculty[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  const [facultyForm, setFacultyForm] = useState({ name: '', code: '', description: '', dean: '' });
  const [departmentForm, setDepartmentForm] = useState({ name: '', code: '', facultyId: '', description: '', head: '' });

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    setIsLoading(true);
    try {
      if (api.isAuthenticated()) {
        const [facsData, deptsData] = await Promise.all([
          api.getAdminFaculties(),
          api.getAdminDepartments(),
        ]);
        setFaculties(facsData.map((f: any) => ({
          id: f.id,
          name: f.name,
          code: f.code || '',
          description: f.description || '',
          dean: f.deanName || 'N/A',
          isActive: true,
          createdAt: f.createdAt
        })));
        setDepartments(deptsData.map((d: any) => ({
          id: d.id,
          name: d.name,
          code: d.code || '',
          facultyId: d.facultyId,
          facultyName: d.facultyName || 'Unknown',
          description: d.description || '',
          head: d.hodName || 'N/A',
          isActive: true,
          createdAt: d.createdAt
        })));
      } else {
        setFaculties(mockFaculties);
        setDepartments(mockDepartments);
      }
    } catch (error) {
      console.error('Failed to fetch data:', error);
      setFaculties(mockFaculties);
      setDepartments(mockDepartments);
    } finally {
      setIsLoading(false);
    }
  };

  // Filter data
  const filteredFaculties = faculties.filter(f =>
    f.name.toLowerCase().includes(facultySearchTerm.toLowerCase()) ||
    f.code.toLowerCase().includes(facultySearchTerm.toLowerCase()) ||
    f.dean.toLowerCase().includes(facultySearchTerm.toLowerCase())
  );

  const filteredDepartments = departments.filter(d => {
    const matchesSearch = d.name.toLowerCase().includes(departmentSearchTerm.toLowerCase()) ||
      d.code.toLowerCase().includes(departmentSearchTerm.toLowerCase()) ||
      d.head.toLowerCase().includes(departmentSearchTerm.toLowerCase());
    const matchesFaculty = departmentFacultyFilter === 'all' || d.facultyId === departmentFacultyFilter;
    return matchesSearch && matchesFaculty;
  });

  // Form handlers
  const resetFacultyForm = () => setFacultyForm({ name: '', code: '', description: '', dean: '' });
  const resetDepartmentForm = () => setDepartmentForm({ name: '', code: '', facultyId: '', description: '', head: '' });

  const handleCreateFaculty = async () => {
    if (!facultyForm.name || !facultyForm.code) {
      toast.error('Please fill in all required fields');
      return;
    }
    setSubmitting(true);
    try {
      if (api.isAuthenticated()) {
        if (editingFaculty) {
          await api.updateAdminFaculty(editingFaculty.id, {
            name: facultyForm.name,
            code: facultyForm.code,
            description: facultyForm.description,
            deanName: facultyForm.dean
          });
          toast.success('Faculty updated successfully!');
        } else {
          await api.createAdminFaculty({
            name: facultyForm.name,
            code: facultyForm.code,
            description: facultyForm.description,
            deanName: facultyForm.dean
          });
          toast.success('Faculty created successfully!');
        }
        await fetchData();
      } else {
        toast.success(editingFaculty ? 'Faculty updated!' : 'Faculty created!');
      }
      setIsCreatingFaculty(false);
      resetFacultyForm();
      setEditingFaculty(null);
    } catch (error: any) {
      toast.error(error.message || 'Failed to save faculty');
    } finally {
      setSubmitting(false);
    }
  };

  const handleCreateDepartment = async () => {
    if (!departmentForm.name || !departmentForm.code || !departmentForm.facultyId) {
      toast.error('Please fill in all required fields');
      return;
    }
    setSubmitting(true);
    try {
      if (api.isAuthenticated()) {
        if (editingDepartment) {
          await api.updateAdminDepartment(editingDepartment.id, {
            name: departmentForm.name,
            code: departmentForm.code,
            facultyId: departmentForm.facultyId,
            description: departmentForm.description,
            hodName: departmentForm.head
          });
          toast.success('Department updated successfully!');
        } else {
          await api.createAdminDepartment({
            name: departmentForm.name,
            code: departmentForm.code,
            facultyId: departmentForm.facultyId,
            description: departmentForm.description,
            hodName: departmentForm.head
          });
          toast.success('Department created successfully!');
        }
        await fetchData();
      } else {
        toast.success(editingDepartment ? 'Department updated!' : 'Department created!');
      }
      setIsCreatingDepartment(false);
      resetDepartmentForm();
      setEditingDepartment(null);
    } catch (error: any) {
      toast.error(error.message || 'Failed to save department');
    } finally {
      setSubmitting(false);
    }
  };

  const handleEditFaculty = (faculty: Faculty) => {
    setEditingFaculty(faculty);
    setFacultyForm({ name: faculty.name, code: faculty.code, description: faculty.description, dean: faculty.dean });
    setIsCreatingFaculty(true);
  };

  const handleEditDepartment = (department: Department) => {
    setEditingDepartment(department);
    setDepartmentForm({ name: department.name, code: department.code, facultyId: department.facultyId, description: department.description, head: department.head });
    setIsCreatingDepartment(true);
  };

  const handleDeleteFaculty = async (facultyId: string) => {
    const relatedDepts = departments.filter(d => d.facultyId === facultyId);
    if (relatedDepts.length > 0) {
      toast.error(`Cannot delete faculty. It has ${relatedDepts.length} department(s) associated.`);
      return;
    }
    try {
      if (api.isAuthenticated()) {
        await api.deleteAdminFaculty(facultyId);
      }
      setFaculties(faculties.filter(f => f.id !== facultyId));
      toast.success('Faculty deleted successfully!');
    } catch (error: any) {
      toast.error(error.message || 'Failed to delete faculty');
    }
  };

  const handleDeleteDepartment = async (departmentId: string) => {
    try {
      if (api.isAuthenticated()) {
        await api.deleteAdminDepartment(departmentId);
      }
      setDepartments(departments.filter(d => d.id !== departmentId));
      toast.success('Department deleted successfully!');
    } catch (error: any) {
      toast.error(error.message || 'Failed to delete department');
    }
  };

  const handleCancelFacultyEdit = () => {
    setIsCreatingFaculty(false);
    setEditingFaculty(null);
    resetFacultyForm();
  };

  const handleCancelDepartmentEdit = () => {
    setIsCreatingDepartment(false);
    setEditingDepartment(null);
    resetDepartmentForm();
  };

  // Export functions
  const exportToCSV = (data: any[], filename: string, headers: string[]) => {
    const csvRows = [headers.join(',')];
    data.forEach(item => {
      const values = headers.map(header => {
        const key = header.toLowerCase().replace(/ /g, '');
        const val = item[key] || item[header] || '';
        return `"${String(val).replace(/"/g, '""')}"`;
      });
      csvRows.push(values.join(','));
    });
    const csvContent = csvRows.join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `${filename}_${new Date().toISOString().split('T')[0]}.csv`;
    link.click();
    toast.success(`Exported ${data.length} ${filename} to CSV`);
  };

  const handleExportFaculties = () => {
    const data = faculties.map(f => ({
      name: f.name,
      code: f.code,
      description: f.description,
      dean: f.dean,
      departments: departments.filter(d => d.facultyId === f.id).length
    }));
    exportToCSV(data, 'faculties', ['Name', 'Code', 'Description', 'Dean', 'Departments']);
  };

  const handleExportDepartments = () => {
    const data = departments.map(d => ({
      name: d.name,
      code: d.code,
      facultyname: d.facultyName,
      description: d.description,
      head: d.head
    }));
    exportToCSV(data, 'departments', ['Name', 'Code', 'FacultyName', 'Description', 'Head']);
  };

  // Stats
  const totalFaculties = faculties.length;
  const totalDepartments = departments.length;
  const avgDepartmentsPerFaculty = totalFaculties > 0 ? Math.round(totalDepartments / totalFaculties * 10) / 10 : 0;

  // Get department count for each faculty
  const getDepartmentCount = (facultyId: string) => departments.filter(d => d.facultyId === facultyId).length;

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
        <h1 className="text-3xl font-bold text-[#485550]">Academic Structure</h1>
        <p className="text-[#485550]/60 mt-1">Manage faculties and departments of your institution</p>
      </div>

      {/* Statistics Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card className="border-[#F4F6F0]">
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-[#F4F6F0] flex items-center justify-center">
                <Building2 className="w-5 h-5 text-[#485550]" />
              </div>
              <div>
                <p className="text-2xl font-bold text-[#485550]">{totalFaculties}</p>
                <p className="text-sm text-[#485550]/60">Total Faculties</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card className="border-[#F4F6F0]">
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-[#C0EB6A]/20 flex items-center justify-center">
                <Users className="w-5 h-5 text-[#485550]" />
              </div>
              <div>
                <p className="text-2xl font-bold text-[#485550]">{totalDepartments}</p>
                <p className="text-sm text-[#485550]/60">Total Departments</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card className="border-[#F4F6F0]">
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-[#F4F6F0] flex items-center justify-center">
                <BookOpen className="w-5 h-5 text-[#485550]" />
              </div>
              <div>
                <p className="text-2xl font-bold text-[#485550]">{avgDepartmentsPerFaculty}</p>
                <p className="text-sm text-[#485550]/60">Avg Depts/Faculty</p>
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
                <p className="text-2xl font-bold text-[#485550]">{faculties.filter(f => f.isActive).length}</p>
                <p className="text-sm text-[#485550]/60">Active Faculties</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Navigation Tabs */}
      <div className="flex space-x-1 bg-[#F4F6F0] p-1 rounded-lg">
        <button
          onClick={() => setActiveTab('faculties')}
          className={`flex-1 px-4 py-2.5 text-sm font-medium rounded-lg transition-colors ${activeTab === 'faculties' ? 'bg-[#485550] text-white shadow-sm' : 'text-[#485550] hover:bg-white'}`}
        >
          <Building2 className="w-4 h-4 inline mr-2" /> Faculties ({totalFaculties})
        </button>
        <button
          onClick={() => setActiveTab('departments')}
          className={`flex-1 px-4 py-2.5 text-sm font-medium rounded-lg transition-colors ${activeTab === 'departments' ? 'bg-[#485550] text-white shadow-sm' : 'text-[#485550] hover:bg-white'}`}
        >
          <Users className="w-4 h-4 inline mr-2" /> Departments ({totalDepartments})
        </button>
      </div>

      {/* Quick Actions */}
      <div className="flex flex-wrap gap-3">
        {activeTab === 'faculties' ? (
          <>
            <Button onClick={() => setIsCreatingFaculty(true)} disabled={isCreatingFaculty} className="bg-[#485550] hover:bg-[#6b7c6f]">
              <Plus className="w-4 h-4 mr-2" /> Create New Faculty
            </Button>
            <Button variant="outline" onClick={handleExportFaculties} className="border-[#485550] text-[#485550]">
              <Download className="w-4 h-4 mr-2" /> Export to CSV
            </Button>
          </>
        ) : (
          <>
            <Button onClick={() => setIsCreatingDepartment(true)} disabled={isCreatingDepartment} className="bg-[#485550] hover:bg-[#6b7c6f]">
              <Plus className="w-4 h-4 mr-2" /> Create New Department
            </Button>
            <Button variant="outline" onClick={handleExportDepartments} className="border-[#485550] text-[#485550]">
              <Download className="w-4 h-4 mr-2" /> Export to CSV
            </Button>
          </>
        )}
      </div>

      {/* Create/Edit Faculty Form */}
      {isCreatingFaculty && (
        <Card className="border-[#C0EB6A]">
          <CardHeader>
            <CardTitle className="text-[#485550]">{editingFaculty ? 'Edit Faculty' : 'Create New Faculty'}</CardTitle>
            <CardDescription>{editingFaculty ? 'Update faculty information' : 'Set up a new faculty within your institution'}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Faculty Name <span className="text-red-500">*</span></Label>
                <Input placeholder="e.g., Faculty of Engineering" value={facultyForm.name} onChange={(e) => setFacultyForm({ ...facultyForm, name: e.target.value })} className="border-[#485550]/20" />
              </div>
              <div className="space-y-2">
                <Label>Faculty Code <span className="text-red-500">*</span></Label>
                <Input placeholder="e.g., ENG" value={facultyForm.code} onChange={(e) => setFacultyForm({ ...facultyForm, code: e.target.value.toUpperCase() })} className="border-[#485550]/20" />
              </div>
            </div>
            <div className="space-y-2">
              <Label>Dean</Label>
              <Input placeholder="e.g., Prof. Dr. John Smith" value={facultyForm.dean} onChange={(e) => setFacultyForm({ ...facultyForm, dean: e.target.value })} className="border-[#485550]/20" />
            </div>
            <div className="space-y-2">
              <Label>Description</Label>
              <Textarea placeholder="Brief description of the faculty..." value={facultyForm.description} onChange={(e) => setFacultyForm({ ...facultyForm, description: e.target.value })} rows={3} className="border-[#485550]/20" />
            </div>
            <div className="flex gap-3">
              <Button onClick={handleCreateFaculty} disabled={submitting} className="bg-[#485550] hover:bg-[#6b7c6f]">
                {submitting ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
                {editingFaculty ? 'Update Faculty' : 'Create Faculty'}
              </Button>
              <Button variant="outline" onClick={handleCancelFacultyEdit} className="border-[#485550]">
                <X className="w-4 h-4 mr-2" /> Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Create/Edit Department Form */}
      {isCreatingDepartment && (
        <Card className="border-[#C0EB6A]">
          <CardHeader>
            <CardTitle className="text-[#485550]">{editingDepartment ? 'Edit Department' : 'Create New Department'}</CardTitle>
            <CardDescription>{editingDepartment ? 'Update department information' : 'Set up a new department within a faculty'}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Department Name <span className="text-red-500">*</span></Label>
                <Input placeholder="e.g., Computer Science" value={departmentForm.name} onChange={(e) => setDepartmentForm({ ...departmentForm, name: e.target.value })} className="border-[#485550]/20" />
              </div>
              <div className="space-y-2">
                <Label>Department Code <span className="text-red-500">*</span></Label>
                <Input placeholder="e.g., CSC" value={departmentForm.code} onChange={(e) => setDepartmentForm({ ...departmentForm, code: e.target.value.toUpperCase() })} className="border-[#485550]/20" />
              </div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Faculty <span className="text-red-500">*</span></Label>
                <Select value={departmentForm.facultyId} onValueChange={(val) => setDepartmentForm({ ...departmentForm, facultyId: val })}>
                  <SelectTrigger className="border-[#485550]/20">
                    <SelectValue placeholder="Select Faculty" />
                  </SelectTrigger>
                  <SelectContent>
                    {faculties.map(f => (
                      <SelectItem key={f.id} value={f.id}>{f.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Head of Department</Label>
                <Input placeholder="e.g., Dr. Alice Wilson" value={departmentForm.head} onChange={(e) => setDepartmentForm({ ...departmentForm, head: e.target.value })} className="border-[#485550]/20" />
              </div>
            </div>
            <div className="space-y-2">
              <Label>Description</Label>
              <Textarea placeholder="Brief description of the department..." value={departmentForm.description} onChange={(e) => setDepartmentForm({ ...departmentForm, description: e.target.value })} rows={3} className="border-[#485550]/20" />
            </div>
            <div className="flex gap-3">
              <Button onClick={handleCreateDepartment} disabled={submitting} className="bg-[#485550] hover:bg-[#6b7c6f]">
                {submitting ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
                {editingDepartment ? 'Update Department' : 'Create Department'}
              </Button>
              <Button variant="outline" onClick={handleCancelDepartmentEdit} className="border-[#485550]">
                <X className="w-4 h-4 mr-2" /> Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Faculties Tab Content */}
      {activeTab === 'faculties' && (
        <div className="space-y-4">
          <Card className="border-[#F4F6F0]">
            <CardHeader>
              <CardTitle className="text-lg text-[#485550]">Search Faculties</CardTitle>
              <CardDescription>Find faculties by name, code, or dean</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-[#485550]/40 w-4 h-4" />
                <Input placeholder="Search faculties..." value={facultySearchTerm} onChange={(e) => setFacultySearchTerm(e.target.value)} className="pl-10 border-[#485550]/20" />
              </div>
            </CardContent>
          </Card>

          <p className="text-sm text-[#485550]/60">Showing {filteredFaculties.length} of {totalFaculties} faculties</p>

          <Card className="border-[#F4F6F0]">
            <CardContent className="p-0">
              {filteredFaculties.length === 0 ? (
                <div className="p-8 text-center">
                  <Building2 className="w-12 h-12 text-[#485550]/30 mx-auto mb-4" />
                  <h3 className="text-lg font-medium text-[#485550] mb-2">No faculties found</h3>
                  <p className="text-[#485550]/60">{faculties.length === 0 ? 'Create your first faculty to get started.' : 'Try adjusting your search.'}</p>
                </div>
              ) : (
                <div className="divide-y divide-[#F4F6F0]">
                  {filteredFaculties.map((faculty) => (
                    <div key={faculty.id} className="p-4 hover:bg-[#F4F6F0]/50 transition-colors">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-4 flex-1 min-w-0">
                          <div className="w-10 h-10 bg-[#F4F6F0] rounded-lg flex items-center justify-center flex-shrink-0">
                            <Building2 className="w-5 h-5 text-[#485550]" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-1">
                              <span className="text-sm font-semibold text-[#485550]">{faculty.code}</span>
                              <span className="text-[#485550]/30">•</span>
                              <span className="text-sm font-medium text-[#485550] truncate">{faculty.name}</span>
                            </div>
                            <div className="flex items-center gap-4 text-xs text-[#485550]/60">
                              <span><strong>Dean:</strong> {faculty.dean}</span>
                              <span><strong>Depts:</strong> {departments.filter(d => d.facultyId === faculty.id).length}</span>
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center gap-3">
                          <Badge variant="outline" className="bg-[#C0EB6A]/20 text-[#485550] border-[#C0EB6A]">
                            <CheckCircle className="w-3 h-3 mr-1" /> Active
                          </Badge>
                          <div className="flex gap-1">
                            <Button variant="ghost" size="sm" onClick={() => handleEditFaculty(faculty)}>
                              <Edit className="w-4 h-4 text-[#485550]" />
                            </Button>
                            <Dialog>
                              <DialogTrigger asChild>
                                <Button variant="ghost" size="sm" className="text-red-500 hover:text-red-600">
                                  <Trash2 className="w-4 h-4" />
                                </Button>
                              </DialogTrigger>
                              <DialogContent>
                                <DialogHeader>
                                  <DialogTitle>Delete Faculty</DialogTitle>
                                  <DialogDescription>Are you sure you want to delete "{faculty.name}"? This action cannot be undone.</DialogDescription>
                                </DialogHeader>
                                <div className="flex gap-3 justify-end">
                                  <Button variant="outline">Cancel</Button>
                                  <Button variant="destructive" onClick={() => handleDeleteFaculty(faculty.id)}>Delete Faculty</Button>
                                </div>
                              </DialogContent>
                            </Dialog>
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {/* Departments Tab Content */}
      {activeTab === 'departments' && (
        <div className="space-y-4">
          <Card className="border-[#F4F6F0]">
            <CardHeader>
              <CardTitle className="text-lg text-[#485550]">Search & Filter Departments</CardTitle>
              <CardDescription>Find departments by name, code, head, or faculty</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-[#485550]/40 w-4 h-4" />
                <Input placeholder="Search departments..." value={departmentSearchTerm} onChange={(e) => setDepartmentSearchTerm(e.target.value)} className="pl-10 border-[#485550]/20" />
              </div>
              <div className="flex gap-4">
                <Select value={departmentFacultyFilter} onValueChange={setDepartmentFacultyFilter}>
                  <SelectTrigger className="w-64 border-[#485550]/20">
                    <SelectValue placeholder="All Faculties" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Faculties</SelectItem>
                    {faculties.map(f => (
                      <SelectItem key={f.id} value={f.id}>{f.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {(departmentSearchTerm || departmentFacultyFilter !== 'all') && (
                  <Button variant="outline" size="sm" onClick={() => { setDepartmentSearchTerm(''); setDepartmentFacultyFilter('all'); }} className="border-[#485550]">
                    <X className="w-4 h-4 mr-2" /> Clear Filters
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>

          <p className="text-sm text-[#485550]/60">Showing {filteredDepartments.length} of {totalDepartments} departments</p>

          <Card className="border-[#F4F6F0]">
            <CardContent className="p-0">
              {filteredDepartments.length === 0 ? (
                <div className="p-8 text-center">
                  <Users className="w-12 h-12 text-[#485550]/30 mx-auto mb-4" />
                  <h3 className="text-lg font-medium text-[#485550] mb-2">No departments found</h3>
                  <p className="text-[#485550]/60">{departments.length === 0 ? 'Create your first department to get started.' : 'Try adjusting your search or filters.'}</p>
                </div>
              ) : (
                <div className="divide-y divide-[#F4F6F0]">
                  {filteredDepartments.map((department) => (
                    <div key={department.id} className="p-4 hover:bg-[#F4F6F0]/50 transition-colors">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-4 flex-1 min-w-0">
                          <div className="w-10 h-10 bg-[#C0EB6A]/20 rounded-lg flex items-center justify-center flex-shrink-0">
                            <Users className="w-5 h-5 text-[#485550]" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-1">
                              <span className="text-sm font-semibold text-[#485550]">{department.code}</span>
                              <span className="text-[#485550]/30">•</span>
                              <span className="text-sm font-medium text-[#485550] truncate">{department.name}</span>
                            </div>
                            <div className="flex items-center gap-4 text-xs text-[#485550]/60">
                              <span><strong>Faculty:</strong> {department.facultyName}</span>
                              <span><strong>Head:</strong> {department.head}</span>
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center gap-3">
                          <Badge variant="outline" className="bg-[#C0EB6A]/20 text-[#485550] border-[#C0EB6A]">
                            <CheckCircle className="w-3 h-3 mr-1" /> Active
                          </Badge>
                          <div className="flex gap-1">
                            <Button variant="ghost" size="sm" onClick={() => handleEditDepartment(department)}>
                              <Edit className="w-4 h-4 text-[#485550]" />
                            </Button>
                            <Dialog>
                              <DialogTrigger asChild>
                                <Button variant="ghost" size="sm" className="text-red-500 hover:text-red-600">
                                  <Trash2 className="w-4 h-4" />
                                </Button>
                              </DialogTrigger>
                              <DialogContent>
                                <DialogHeader>
                                  <DialogTitle>Delete Department</DialogTitle>
                                  <DialogDescription>Are you sure you want to delete "{department.name}"? This action cannot be undone.</DialogDescription>
                                </DialogHeader>
                                <div className="flex gap-3 justify-end">
                                  <Button variant="outline">Cancel</Button>
                                  <Button variant="destructive" onClick={() => handleDeleteDepartment(department.id)}>Delete Department</Button>
                                </div>
                              </DialogContent>
                            </Dialog>
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
