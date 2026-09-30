'use client';

import { useState, useEffect, useRef } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from '@/components/ui/dialog';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api } from '@/lib/api';
import Papa from 'papaparse';
import {
  Users,
  GraduationCap,
  UserPlus,
  Search,
  Filter,
  Edit,
  Trash2,
  Eye,
  ArrowLeft,
  Mail,
  Phone,
  Building,
  School,
  Loader2,
  Upload,
  Calendar,
  Key,
  FileSpreadsheet,
  CheckCircle,
  XCircle,
  AlertCircle,
  User,
  Copy,
  Camera,
  ImagePlus,
} from 'lucide-react';


interface User {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string | null;
  role: string;
  status: string;
  departmentName: string | null;
  facultyName: string | null;
  studentProfile: any;
  lecturerProfile: any;
  createdAt: string;
  profilePhoto?: string | null;
}

// Titles/Designations
const titles = ['Dr.', 'Prof.', 'Mr.', 'Mrs.', 'Ms.', 'Associate Prof.', 'Assistant Prof.'];
const levels = ['100 Level', '200 Level', '300 Level', '400 Level', '500 Level', '600 Level'];

// Mock data
const mockUsers: User[] = [
  { id: '1', firstName: 'John', lastName: 'Doe', email: 'john.doe@uni.edu.ng', role: 'STUDENT', status: 'ACTIVE', phone: '+234 801 234 5678', departmentName: 'Computer Science', facultyName: 'Science', studentProfile: { level: 200, matricNumber: 'STU/2023/001' }, lecturerProfile: null, createdAt: '2024-01-15' },
  { id: '2', firstName: 'Adewale', lastName: 'Johnson', email: 'dr.adewale@uni.edu.ng', role: 'LECTURER', status: 'ACTIVE', phone: '+234 802 345 6789', departmentName: 'Computer Science', facultyName: 'Science', studentProfile: null, lecturerProfile: { title: 'Dr.', staffId: 'LEC/001' }, createdAt: '2022-09-01' },
  { id: '3', firstName: 'Jane', lastName: 'Smith', email: 'jane.smith@uni.edu.ng', role: 'STUDENT', status: 'ACTIVE', phone: '+234 803 456 7890', departmentName: 'Mathematics', facultyName: 'Science', studentProfile: { level: 300, matricNumber: 'STU/2022/045' }, lecturerProfile: null, createdAt: '2023-09-01' },
  { id: '4', firstName: 'Prof. Okonkwo', lastName: 'Emmanuel', email: 'okonkwo@uni.edu.ng', role: 'HOD', status: 'ACTIVE', phone: '+234 804 567 8901', departmentName: 'Computer Science', facultyName: 'Science', studentProfile: null, lecturerProfile: { title: 'Prof.', staffId: 'HOD/001' }, createdAt: '2020-01-01' },
];

const mockDepartments = [
  { id: 'd1', name: 'Computer Science' },
  { id: 'd2', name: 'Mathematics' },
  { id: 'd3', name: 'Physics' },
  { id: 'd4', name: 'Chemistry' },
];

const mockFaculties = [
  { id: 'f1', name: 'Faculty of Science' },
  { id: 'f2', name: 'Faculty of Engineering' },
  { id: 'f3', name: 'Faculty of Arts' },
];

const mockProgrammes = [
  'Computer Science', 'Software Engineering', 'Information Technology',
  'Mathematics', 'Statistics', 'Physics', 'Chemistry', 'Biology',
  'Engineering', 'Mechanical Engineering', 'Civil Engineering',
  'Business Administration', 'Economics', 'Accounting'
];

export default function UserManagement() {
  const [activeTab, setActiveTab] = useState('overview');
  const [searchTerm, setSearchTerm] = useState('');
  const [userTypeFilter, setUserTypeFilter] = useState('all');
  const [selectedUser, setSelectedUser] = useState<User | null>(null);
  const [showUserDetail, setShowUserDetail] = useState(false);
  const [users, setUsers] = useState<User[]>([]);
  const [departments, setDepartments] = useState<any[]>([]);
  const [faculties, setFaculties] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [pagination, setPagination] = useState({ page: 1, limit: 50, total: 0, totalPages: 0 });

  // New state for dialogs
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [editForm, setEditForm] = useState<any>({});
  const [passwordResetOpen, setPasswordResetOpen] = useState(false);
  const [tempPassword, setTempPassword] = useState<string | null>(null);
  const [csvDialogOpen, setCsvDialogOpen] = useState(false);
  const [csvData, setCsvData] = useState<any[]>([]);
  const [csvUploading, setCsvUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Profile photo state
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const photoInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (api.isAuthenticated()) {
      fetchData();
    } else {
      setUsers(mockUsers);
      setDepartments(mockDepartments);
      setFaculties(mockFaculties);
      setPagination({ page: 1, limit: 50, total: mockUsers.length, totalPages: 1 });
      setLoading(false);
    }
  }, []);

  const fetchData = async () => {
    setLoading(true);
    try {
      const [usersData, deptsData, facsData] = await Promise.all([
        api.getAdminUsers({ limit: 50 }),
        api.getAdminDepartments(),
        api.getAdminFaculties(),
      ]);
      setUsers(usersData.users);
      setPagination(usersData.pagination);
      setDepartments(deptsData);
      setFaculties(facsData);
    } catch (error: any) {
      console.error('Failed to fetch data:', error);
      setUsers(mockUsers);
      setDepartments(mockDepartments);
      setFaculties(mockFaculties);
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteUser = async (userId: string) => {
    if (!confirm('Are you sure you want to delete this user?')) return;
    try {
      if (api.isAuthenticated()) {
        await api.deleteAdminUser(userId);
      }
      setUsers(users.filter(u => u.id !== userId));
      toast.success('User deleted successfully');
      setShowUserDetail(false);
      setSelectedUser(null);
    } catch (error: any) {
      toast.error(error.message || 'Failed to delete user');
    }
  };

  const handleUserClick = (user: User) => {
    setSelectedUser(user);
    setShowUserDetail(true);
  };

  // Edit user handler
  const handleEditUser = (user: User) => {
    setEditForm({
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      phone: user.phone || '',
      status: user.status,
      departmentId: '',
      profilePhoto: user.profilePhoto || null,
    });
    setPhotoFile(null);
    setPhotoPreview(null);
    setSelectedUser(user);
    setEditDialogOpen(true);
  };

  const handleSaveEdit = async () => {
    if (!selectedUser) return;
    setSubmitting(true);
    try {
      // Include photo in update if changed
      const updateData = { ...editForm };
      if (photoPreview) {
        updateData.profilePhoto = photoPreview; // In real app, would upload to server first
      }

      if (api.isAuthenticated()) {
        await api.updateAdminUser(selectedUser.id, updateData);
        await fetchData();
      } else {
        setUsers(users.map(u => u.id === selectedUser.id ? { ...u, ...updateData } : u));
      }
      toast.success('User updated successfully!');
      setEditDialogOpen(false);
      setPhotoFile(null);
      setPhotoPreview(null);
    } catch (error: any) {
      toast.error(error.message || 'Failed to update user');
    } finally {
      setSubmitting(false);
    }
  };

  // Password reset handler
  const handlePasswordReset = async () => {
    if (!selectedUser) return;
    setSubmitting(true);
    try {
      if (api.isAuthenticated()) {
        const result = await api.resetUserPassword(selectedUser.id);
        setTempPassword(result.temporaryPassword);
      } else {
        setTempPassword('TempPass@' + Math.random().toString(36).slice(-8));
      }
      toast.success('Password reset successfully!');
    } catch (error: any) {
      toast.error(error.message || 'Failed to reset password');
    } finally {
      setSubmitting(false);
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    toast.success('Copied to clipboard!');
  };

  // CSV handlers
  const handleCSVFile = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: (results) => {
        setCsvData(results.data);
        setCsvDialogOpen(true);
      },
      error: (error) => {
        toast.error('Failed to parse CSV: ' + error.message);
      }
    });
  };

  const handleBulkUpload = async () => {
    if (csvData.length === 0) return;
    setCsvUploading(true);
    try {
      const usersToCreate = csvData.map((row: any) => ({
        firstName: row.firstName || row['First Name'] || '',
        lastName: row.lastName || row['Last Name'] || '',
        email: row.email || row.Email || '',
        phone: row.phone || row.Phone || '',
        role: (row.role || row.Role || 'STUDENT').toUpperCase(),
        password: 'Welcome@123',
      }));

      if (api.isAuthenticated()) {
        const result = await api.bulkCreateUsers(usersToCreate);
        toast.success(`Created ${result.created} users. ${result.failed} failed.`);
      } else {
        toast.success(`Would create ${usersToCreate.length} users (demo mode)`);
      }
      setCsvDialogOpen(false);
      setCsvData([]);
      if (fileInputRef.current) fileInputRef.current.value = '';
    } catch (error: any) {
      toast.error(error.message || 'Bulk upload failed');
    } finally {
      setCsvUploading(false);
    }
  };

  // Filter users
  const filteredUsers = users.filter(user => {
    const fullName = `${user.firstName} ${user.lastName}`;
    const matchesSearch = fullName.toLowerCase().includes(searchTerm.toLowerCase()) ||
      user.email.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesType = userTypeFilter === 'all' || user.role === userTypeFilter;
    return matchesSearch && matchesType;
  });

  // Stats
  const stats = [
    { title: 'Total Users', value: pagination.total || users.length, icon: Users, color: 'text-[#485550]', bgColor: 'bg-[#F4F6F0]' },
    { title: 'Students', value: users.filter(u => u.role === 'STUDENT').length, icon: GraduationCap, color: 'text-[#485550]', bgColor: 'bg-[#C0EB6A]/20' },
    { title: 'Lecturers', value: users.filter(u => u.role === 'LECTURER').length, icon: Users, color: 'text-[#485550]', bgColor: 'bg-[#F4F6F0]' },
    { title: 'Administrators', value: users.filter(u => ['HOD', 'DEAN', 'ICT_ADMIN'].includes(u.role)).length, icon: UserPlus, color: 'text-[#485550]', bgColor: 'bg-[#C0EB6A]/20' }
  ];

  // User Detail View Component
  const UserDetailView = ({ user }: { user: User }) => {
    const fullName = `${user.firstName} ${user.lastName}`;

    return (
      <div className="space-y-6">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setShowUserDetail(false)}
          className="flex items-center gap-2 text-[#485550] hover:bg-[#F4F6F0]"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Overview
        </Button>

        <Card className="border-[#F4F6F0]">
          <CardHeader>
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div>
                <CardTitle className="text-2xl text-[#485550]">{fullName}</CardTitle>
                <div className="flex items-center gap-2 mt-2">
                  <Badge variant="outline" className="border-[#485550] text-[#485550]">{user.role}</Badge>
                  <Badge variant="outline" className={user.status === 'ACTIVE' ? 'bg-[#C0EB6A]/20 text-[#485550] border-[#C0EB6A]' : 'bg-red-100 text-red-800'}>
                    {user.status}
                  </Badge>
                </div>
              </div>
              <div className="flex gap-2 flex-wrap">
                <Button size="sm" variant="outline" className="border-[#485550] text-[#485550]" onClick={() => handleEditUser(user)}>
                  <Edit className="h-4 w-4 mr-2" /> Edit
                </Button>
                <Button size="sm" variant="outline" className="border-amber-500 text-amber-600 hover:bg-amber-50" onClick={() => { setSelectedUser(user); setPasswordResetOpen(true); setTempPassword(null); }}>
                  <Key className="h-4 w-4 mr-2" /> Reset Password
                </Button>
                <Button size="sm" variant="outline" className="text-red-600 border-red-300 hover:bg-red-50" onClick={() => handleDeleteUser(user.id)}>
                  <Trash2 className="h-4 w-4 mr-2" /> Delete
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* Basic Information */}
            <div>
              <h3 className="text-lg font-semibold mb-4 text-[#485550]">Basic Information</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="flex items-center gap-3">
                  <Mail className="h-5 w-5 text-[#485550]/60" />
                  <div>
                    <p className="text-sm font-medium text-[#485550]">Email</p>
                    <p className="text-sm text-[#485550]/70">{user.email}</p>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <Phone className="h-5 w-5 text-[#485550]/60" />
                  <div>
                    <p className="text-sm font-medium text-[#485550]">Phone</p>
                    <p className="text-sm text-[#485550]/70">{user.phone || 'N/A'}</p>
                  </div>
                </div>
                {user.departmentName && (
                  <div className="flex items-center gap-3">
                    <Building className="h-5 w-5 text-[#485550]/60" />
                    <div>
                      <p className="text-sm font-medium text-[#485550]">Department</p>
                      <p className="text-sm text-[#485550]/70">{user.departmentName}</p>
                    </div>
                  </div>
                )}
                {user.facultyName && (
                  <div className="flex items-center gap-3">
                    <School className="h-5 w-5 text-[#485550]/60" />
                    <div>
                      <p className="text-sm font-medium text-[#485550]">Faculty</p>
                      <p className="text-sm text-[#485550]/70">{user.facultyName}</p>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Academic Information (for Students) */}
            {user.studentProfile && (
              <div>
                <h3 className="text-lg font-semibold mb-4 text-[#485550]">Academic Information</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="flex items-center gap-3">
                    <GraduationCap className="h-5 w-5 text-[#485550]/60" />
                    <div>
                      <p className="text-sm font-medium text-[#485550]">Level</p>
                      <p className="text-sm text-[#485550]/70">{user.studentProfile.level} Level</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <Users className="h-5 w-5 text-[#485550]/60" />
                    <div>
                      <p className="text-sm font-medium text-[#485550]">Matric Number</p>
                      <p className="text-sm text-[#485550]/70">{user.studentProfile.matricNumber}</p>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Professional Information (for Lecturers) */}
            {user.lecturerProfile && (
              <div>
                <h3 className="text-lg font-semibold mb-4 text-[#485550]">Professional Information</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="flex items-center gap-3">
                    <Users className="h-5 w-5 text-[#485550]/60" />
                    <div>
                      <p className="text-sm font-medium text-[#485550]">Title</p>
                      <p className="text-sm text-[#485550]/70">{user.lecturerProfile.title || 'N/A'}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <Users className="h-5 w-5 text-[#485550]/60" />
                    <div>
                      <p className="text-sm font-medium text-[#485550]">Staff ID</p>
                      <p className="text-sm text-[#485550]/70">{user.lecturerProfile.staffId}</p>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* System Information */}
            <div>
              <h3 className="text-lg font-semibold mb-4 text-[#485550]">System Information</h3>
              <div className="flex items-center gap-3">
                <Calendar className="h-5 w-5 text-[#485550]/60" />
                <div>
                  <p className="text-sm font-medium text-[#485550]">Join Date</p>
                  <p className="text-sm text-[#485550]/70">{new Date(user.createdAt).toLocaleDateString()}</p>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  };

  // Student Form Component - Enhanced with Nigerian university fields
  const StudentForm = () => {
    const [form, setForm] = useState<any>({});
    const nigerianStates = ['Abia', 'Adamawa', 'Akwa Ibom', 'Anambra', 'Bauchi', 'Bayelsa', 'Benue', 'Borno', 'Cross River', 'Delta', 'Ebonyi', 'Edo', 'Ekiti', 'Enugu', 'FCT', 'Gombe', 'Imo', 'Jigawa', 'Kaduna', 'Kano', 'Katsina', 'Kebbi', 'Kogi', 'Kwara', 'Lagos', 'Nasarawa', 'Niger', 'Ogun', 'Ondo', 'Osun', 'Oyo', 'Plateau', 'Rivers', 'Sokoto', 'Taraba', 'Yobe', 'Zamfara'];
    const genders = ['Male', 'Female'];
    const admissionModes = ['UTME', 'Direct Entry', 'JUPEB', 'IJMB', 'Pre-Degree', 'Transfer'];
    const currentYear = new Date().getFullYear();
    const entryYears = Array.from({ length: 10 }, (_, i) => currentYear - i);

    const handleSubmit = async () => {
      if (!form.firstName || !form.lastName || !form.email) {
        toast.error('Please fill all required fields');
        return;
      }
      setSubmitting(true);
      try {
        if (api.isAuthenticated()) {
          await api.createAdminUser({ ...form, role: 'STUDENT' });
          await fetchData();
        }
        toast.success('Student created successfully!');
        setForm({});
        setActiveTab('overview');
      } catch (error: any) {
        toast.error(error.message || 'Failed to create student');
      } finally {
        setSubmitting(false);
      }
    };

    return (
      <Card className="border-[#F4F6F0]">
        <CardHeader>
          <CardTitle className="text-[#485550]">Onboard New Student</CardTitle>
          <CardDescription>Add a new student to the system with complete bio-data</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Personal Information */}
          <div>
            <h3 className="text-sm font-semibold text-[#485550] mb-3 flex items-center gap-2"><User className="w-4 h-4" /> Personal Information</h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label>First Name <span className='text-red-500'>*</span></Label>
                <Input placeholder="Enter first name" value={form.firstName || ''} onChange={(e) => setForm({ ...form, firstName: e.target.value })} className="border-[#485550]/20" />
              </div>
              <div className="space-y-2">
                <Label>Last Name <span className='text-red-500'>*</span></Label>
                <Input placeholder="Enter last name" value={form.lastName || ''} onChange={(e) => setForm({ ...form, lastName: e.target.value })} className="border-[#485550]/20" />
              </div>
              <div className="space-y-2">
                <Label>Other Names</Label>
                <Input placeholder="Middle name (optional)" value={form.middleName || ''} onChange={(e) => setForm({ ...form, middleName: e.target.value })} className="border-[#485550]/20" />
              </div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-4">
              <div className="space-y-2">
                <Label>Date of Birth</Label>
                <Input type="date" value={form.dateOfBirth || ''} onChange={(e) => setForm({ ...form, dateOfBirth: e.target.value })} className="border-[#485550]/20" />
              </div>
              <div className="space-y-2">
                <Label>Gender</Label>
                <Select onValueChange={(val) => setForm({ ...form, gender: val })} value={form.gender}>
                  <SelectTrigger className="border-[#485550]/20"><SelectValue placeholder="Select gender" /></SelectTrigger>
                  <SelectContent>
                    {genders.map((g) => (<SelectItem key={g} value={g}>{g}</SelectItem>))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>State of Origin</Label>
                <Select onValueChange={(val) => setForm({ ...form, stateOfOrigin: val })} value={form.stateOfOrigin}>
                  <SelectTrigger className="border-[#485550]/20"><SelectValue placeholder="Select state" /></SelectTrigger>
                  <SelectContent>
                    {nigerianStates.map((s) => (<SelectItem key={s} value={s}>{s}</SelectItem>))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
              <div className="space-y-2">
                <Label>LGA (Local Government Area)</Label>
                <Input placeholder="Enter LGA" value={form.lga || ''} onChange={(e) => setForm({ ...form, lga: e.target.value })} className="border-[#485550]/20" />
              </div>
              <div className="space-y-2">
                <Label>Home Address</Label>
                <Input placeholder="Enter address" value={form.address || ''} onChange={(e) => setForm({ ...form, address: e.target.value })} className="border-[#485550]/20" />
              </div>
            </div>
          </div>

          {/* Contact Information */}
          <div>
            <h3 className="text-sm font-semibold text-[#485550] mb-3 flex items-center gap-2"><Mail className="w-4 h-4" /> Contact Information</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Email Address <span className='text-red-500'>*</span></Label>
                <Input type="email" placeholder="student@example.com" value={form.email || ''} onChange={(e) => setForm({ ...form, email: e.target.value })} className="border-[#485550]/20" />
              </div>
              <div className="space-y-2">
                <Label>Phone Number <span className='text-red-500'>*</span></Label>
                <Input placeholder="+2348012345678" value={form.phone || ''} onChange={(e) => setForm({ ...form, phone: e.target.value })} className="border-[#485550]/20" />
              </div>
            </div>
          </div>

          {/* Guardian/Next of Kin */}
          <div>
            <h3 className="text-sm font-semibold text-[#485550] mb-3 flex items-center gap-2"><Users className="w-4 h-4" /> Guardian / Next of Kin</h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label>Guardian Name</Label>
                <Input placeholder="Full name" value={form.guardianName || ''} onChange={(e) => setForm({ ...form, guardianName: e.target.value })} className="border-[#485550]/20" />
              </div>
              <div className="space-y-2">
                <Label>Guardian Phone</Label>
                <Input placeholder="+2348012345678" value={form.guardianPhone || ''} onChange={(e) => setForm({ ...form, guardianPhone: e.target.value })} className="border-[#485550]/20" />
              </div>
              <div className="space-y-2">
                <Label>Relationship</Label>
                <Input placeholder="e.g. Father, Mother, Uncle" value={form.guardianRelationship || ''} onChange={(e) => setForm({ ...form, guardianRelationship: e.target.value })} className="border-[#485550]/20" />
              </div>
            </div>
          </div>

          {/* Academic Information */}
          <div>
            <h3 className="text-sm font-semibold text-[#485550] mb-3 flex items-center gap-2"><GraduationCap className="w-4 h-4" /> Academic Information</h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label>Matric Number</Label>
                <Input placeholder="e.g. UNI/2024/CSC/001" value={form.matricNumber || ''} onChange={(e) => setForm({ ...form, matricNumber: e.target.value })} className="border-[#485550]/20" />
              </div>
              <div className="space-y-2">
                <Label>Admission Mode</Label>
                <Select onValueChange={(val) => setForm({ ...form, admissionMode: val })} value={form.admissionMode}>
                  <SelectTrigger className="border-[#485550]/20"><SelectValue placeholder="Select mode" /></SelectTrigger>
                  <SelectContent>
                    {admissionModes.map((m) => (<SelectItem key={m} value={m}>{m}</SelectItem>))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Entry Year</Label>
                <Select onValueChange={(val) => setForm({ ...form, entryYear: val })} value={form.entryYear}>
                  <SelectTrigger className="border-[#485550]/20"><SelectValue placeholder="Select year" /></SelectTrigger>
                  <SelectContent>
                    {entryYears.map((y) => (<SelectItem key={y} value={y.toString()}>{y}</SelectItem>))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-4">
              <div className="space-y-2">
                <Label>Programme <span className='text-red-500'>*</span></Label>
                <Select onValueChange={(val) => setForm({ ...form, programme: val })} value={form.programme}>
                  <SelectTrigger className="border-[#485550]/20"><SelectValue placeholder="Select programme" /></SelectTrigger>
                  <SelectContent>
                    {mockProgrammes.map((prog) => (<SelectItem key={prog} value={prog}>{prog}</SelectItem>))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Level <span className='text-red-500'>*</span></Label>
                <Select onValueChange={(val) => setForm({ ...form, level: val })} value={form.level}>
                  <SelectTrigger className="border-[#485550]/20"><SelectValue placeholder="Select level" /></SelectTrigger>
                  <SelectContent>
                    {levels.map((level) => (<SelectItem key={level} value={level}>{level}</SelectItem>))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Department</Label>
                <Select onValueChange={(val) => setForm({ ...form, departmentId: val })} value={form.departmentId}>
                  <SelectTrigger className="border-[#485550]/20"><SelectValue placeholder="Select department" /></SelectTrigger>
                  <SelectContent>
                    {departments.map((dept: any) => (<SelectItem key={dept.id} value={dept.id}>{dept.name}</SelectItem>))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-4 border-t">
            <Button variant="outline" onClick={() => setForm({})} className="border-[#485550]">Clear Form</Button>
            <Button onClick={handleSubmit} disabled={submitting} className="bg-[#485550] hover:bg-[#6b7c6f]">
              {submitting ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Creating...</> : 'Create Student Account'}
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  };

  // Lecturer Form Component
  const LecturerForm = () => {
    const [form, setForm] = useState<any>({});

    const handleSubmit = async () => {
      if (!form.firstName || !form.lastName || !form.email) {
        toast.error('Please fill all required fields');
        return;
      }
      setSubmitting(true);
      try {
        if (api.isAuthenticated()) {
          await api.createAdminUser({ ...form, role: 'LECTURER' });
          await fetchData();
        }
        toast.success('Lecturer created successfully!');
        setForm({});
        setActiveTab('overview');
      } catch (error: any) {
        toast.error(error.message || 'Failed to create lecturer');
      } finally {
        setSubmitting(false);
      }
    };

    return (
      <Card className="border-[#F4F6F0]">
        <CardHeader>
          <CardTitle className="text-[#485550]">Onboard New Lecturer</CardTitle>
          <CardDescription>Add a new lecturer to the system</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="space-y-2">
              <Label>Title <span className='text-red-500'>*</span></Label>
              <Select onValueChange={(val) => setForm({ ...form, title: val })} value={form.title}>
                <SelectTrigger className="border-[#485550]/20">
                  <SelectValue placeholder="Select title" />
                </SelectTrigger>
                <SelectContent>
                  {titles.map((title) => (
                    <SelectItem key={title} value={title}>{title}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>First Name <span className='text-red-500'>*</span></Label>
              <Input placeholder="Enter first name" value={form.firstName || ''} onChange={(e) => setForm({ ...form, firstName: e.target.value })} className="border-[#485550]/20" />
            </div>
            <div className="space-y-2">
              <Label>Last Name <span className='text-red-500'>*</span></Label>
              <Input placeholder="Enter last name" value={form.lastName || ''} onChange={(e) => setForm({ ...form, lastName: e.target.value })} className="border-[#485550]/20" />
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Email Address <span className='text-red-500'>*</span></Label>
              <Input type="email" placeholder="lecturer@university.edu" value={form.email || ''} onChange={(e) => setForm({ ...form, email: e.target.value })} className="border-[#485550]/20" />
            </div>
            <div className="space-y-2">
              <Label>Phone Number <span className='text-red-500'>*</span></Label>
              <Input placeholder="+2348053599566" value={form.phone || ''} onChange={(e) => setForm({ ...form, phone: e.target.value })} className="border-[#485550]/20" />
            </div>
          </div>

          <div className='grid grid-cols-1 md:grid-cols-2 gap-4'>
            <div className="space-y-2">
              <Label>Department <span className='text-red-500'>*</span></Label>
              <Select onValueChange={(val) => setForm({ ...form, departmentId: val })} value={form.departmentId}>
                <SelectTrigger className="border-[#485550]/20">
                  <SelectValue placeholder="Select department" />
                </SelectTrigger>
                <SelectContent>
                  {departments.map((dept: any) => (
                    <SelectItem key={dept.id} value={dept.id}>{dept.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Staff ID <span className='text-red-500'>*</span></Label>
              <Input placeholder="LEC/001" value={form.staffId || ''} onChange={(e) => setForm({ ...form, staffId: e.target.value })} className="border-[#485550]/20" />
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-4">
            <Button variant="outline" onClick={() => setForm({})} className="border-[#485550]">Cancel</Button>
            <Button onClick={handleSubmit} disabled={submitting} className="bg-[#485550] hover:bg-[#6b7c6f]">
              {submitting ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Creating...</> : 'Create Lecturer Account'}
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  };

  // HOD Form Component
  const HODForm = () => {
    const [form, setForm] = useState<any>({});

    const handleSubmit = async () => {
      if (!form.firstName || !form.lastName || !form.email || !form.departmentId) {
        toast.error('Please fill all required fields');
        return;
      }
      setSubmitting(true);
      try {
        if (api.isAuthenticated()) {
          await api.createAdminUser({ ...form, role: 'HOD' });
          await fetchData();
        }
        toast.success('HOD created successfully!');
        setForm({});
        setActiveTab('overview');
      } catch (error: any) {
        toast.error(error.message || 'Failed to create HOD');
      } finally {
        setSubmitting(false);
      }
    };

    return (
      <Card className="border-[#F4F6F0]">
        <CardHeader>
          <CardTitle className="text-[#485550]">Onboard New HOD</CardTitle>
          <CardDescription>Add a new Head of Department to the system</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="space-y-2">
              <Label>Title <span className='text-red-500'>*</span></Label>
              <Select onValueChange={(val) => setForm({ ...form, title: val })} value={form.title}>
                <SelectTrigger className="border-[#485550]/20">
                  <SelectValue placeholder="Select title" />
                </SelectTrigger>
                <SelectContent>
                  {titles.map((title) => (
                    <SelectItem key={title} value={title}>{title}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>First Name <span className='text-red-500'>*</span></Label>
              <Input placeholder="Enter first name" value={form.firstName || ''} onChange={(e) => setForm({ ...form, firstName: e.target.value })} className="border-[#485550]/20" />
            </div>
            <div className="space-y-2">
              <Label>Last Name <span className='text-red-500'>*</span></Label>
              <Input placeholder="Enter last name" value={form.lastName || ''} onChange={(e) => setForm({ ...form, lastName: e.target.value })} className="border-[#485550]/20" />
            </div>
          </div>

          <div className='grid grid-cols-1 md:grid-cols-2 gap-4'>
            <div className="space-y-2">
              <Label>Email Address <span className='text-red-500'>*</span></Label>
              <Input type="email" placeholder="hod@university.edu" value={form.email || ''} onChange={(e) => setForm({ ...form, email: e.target.value })} className="border-[#485550]/20" />
            </div>
            <div className="space-y-2">
              <Label>Phone Number</Label>
              <Input placeholder="+2348053599566" value={form.phone || ''} onChange={(e) => setForm({ ...form, phone: e.target.value })} className="border-[#485550]/20" />
            </div>
          </div>

          <div className="space-y-2">
            <Label>Department <span className='text-red-500'>*</span></Label>
            <Select onValueChange={(val) => setForm({ ...form, departmentId: val })} value={form.departmentId}>
              <SelectTrigger className="border-[#485550]/20">
                <SelectValue placeholder="Select department" />
              </SelectTrigger>
              <SelectContent>
                {departments.map((dept: any) => (
                  <SelectItem key={dept.id} value={dept.id}>{dept.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex justify-end gap-2 pt-4">
            <Button variant="outline" onClick={() => setForm({})} className="border-[#485550]">Cancel</Button>
            <Button onClick={handleSubmit} disabled={submitting} className="bg-[#485550] hover:bg-[#6b7c6f]">
              {submitting ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Creating...</> : 'Create HOD Account'}
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  };

  // Dean Form Component
  const DeanForm = () => {
    const [form, setForm] = useState<any>({});

    const handleSubmit = async () => {
      if (!form.firstName || !form.lastName || !form.email || !form.facultyId) {
        toast.error('Please fill all required fields');
        return;
      }
      setSubmitting(true);
      try {
        if (api.isAuthenticated()) {
          await api.createAdminUser({ ...form, role: 'DEAN' });
          await fetchData();
        }
        toast.success('Dean created successfully!');
        setForm({});
        setActiveTab('overview');
      } catch (error: any) {
        toast.error(error.message || 'Failed to create Dean');
      } finally {
        setSubmitting(false);
      }
    };

    return (
      <Card className="border-[#F4F6F0]">
        <CardHeader>
          <CardTitle className="text-[#485550]">Onboard New Dean</CardTitle>
          <CardDescription>Add a new Dean to the system</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="space-y-2">
              <Label>Title <span className='text-red-500'>*</span></Label>
              <Select onValueChange={(val) => setForm({ ...form, title: val })} value={form.title}>
                <SelectTrigger className="border-[#485550]/20">
                  <SelectValue placeholder="Select title" />
                </SelectTrigger>
                <SelectContent>
                  {titles.map((title) => (
                    <SelectItem key={title} value={title}>{title}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>First Name <span className='text-red-500'>*</span></Label>
              <Input placeholder="Enter first name" value={form.firstName || ''} onChange={(e) => setForm({ ...form, firstName: e.target.value })} className="border-[#485550]/20" />
            </div>
            <div className="space-y-2">
              <Label>Last Name <span className='text-red-500'>*</span></Label>
              <Input placeholder="Enter last name" value={form.lastName || ''} onChange={(e) => setForm({ ...form, lastName: e.target.value })} className="border-[#485550]/20" />
            </div>
          </div>

          <div className='grid grid-cols-1 md:grid-cols-2 gap-4'>
            <div className="space-y-2">
              <Label>Email Address <span className='text-red-500'>*</span></Label>
              <Input type="email" placeholder="dean@university.edu" value={form.email || ''} onChange={(e) => setForm({ ...form, email: e.target.value })} className="border-[#485550]/20" />
            </div>
            <div className="space-y-2">
              <Label>Phone Number</Label>
              <Input placeholder="+2348053599566" value={form.phone || ''} onChange={(e) => setForm({ ...form, phone: e.target.value })} className="border-[#485550]/20" />
            </div>
          </div>

          <div className="space-y-2">
            <Label>Faculty <span className='text-red-500'>*</span></Label>
            <Select onValueChange={(val) => setForm({ ...form, facultyId: val })} value={form.facultyId}>
              <SelectTrigger className="border-[#485550]/20">
                <SelectValue placeholder="Select faculty" />
              </SelectTrigger>
              <SelectContent>
                {faculties.map((fac: any) => (
                  <SelectItem key={fac.id} value={fac.id}>{fac.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex justify-end gap-2 pt-4">
            <Button variant="outline" onClick={() => setForm({})} className="border-[#485550]">Cancel</Button>
            <Button onClick={handleSubmit} disabled={submitting} className="bg-[#485550] hover:bg-[#6b7c6f]">
              {submitting ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Creating...</> : 'Create Dean Account'}
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  };

  // Show User Detail if selected
  if (showUserDetail && selectedUser) {
    return <UserDetailView user={selectedUser} />;
  }

  // Loading state
  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin text-[#485550]" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-4">
        <div>
          <h2 className="text-3xl font-bold text-[#485550]">User Management</h2>
          <p className="text-[#485550]/60">Manage students, lecturers, and administrators</p>
        </div>
        <div className="flex gap-2">
          <input
            type="file"
            ref={fileInputRef}
            id="bulk-import"
            className="hidden"
            accept=".csv"
            onChange={handleCSVFile}
          />
          <Button onClick={() => fileInputRef.current?.click()} className="bg-[#485550] hover:bg-[#6b7c6f]">
            <FileSpreadsheet className="h-4 w-4 mr-2" /> Bulk Upload (CSV)
          </Button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {stats.map((stat, index) => {
          const Icon = stat.icon;
          return (
            <Card key={index} className="hover:shadow-lg transition-shadow border-[#F4F6F0] cursor-pointer">
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium text-[#485550]/70">{stat.title}</CardTitle>
                <div className={`p-2 rounded-full ${stat.bgColor}`}>
                  <Icon className={`h-4 w-4 ${stat.color}`} />
                </div>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold text-[#485550]">{stat.value}</div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="grid w-full grid-cols-2 sm:grid-cols-5 bg-[#485550]">
          <TabsTrigger value="overview" className="text-white data-[state=active]:bg-[#C0EB6A] data-[state=active]:text-[#485550]">Overview</TabsTrigger>
          <TabsTrigger value="student" className="text-white data-[state=active]:bg-[#C0EB6A] data-[state=active]:text-[#485550]">Add Student</TabsTrigger>
          <TabsTrigger value="lecturer" className="text-white data-[state=active]:bg-[#C0EB6A] data-[state=active]:text-[#485550]">Add Lecturer</TabsTrigger>
          <TabsTrigger value="hod" className="text-white data-[state=active]:bg-[#C0EB6A] data-[state=active]:text-[#485550]">Add HOD</TabsTrigger>
          <TabsTrigger value="dean" className="text-white data-[state=active]:bg-[#C0EB6A] data-[state=active]:text-[#485550]">Add Dean</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-4 mt-4">
          <Card className="border-[#F4F6F0]">
            <CardHeader>
              <CardTitle className="text-[#485550]">All Users</CardTitle>
              <CardDescription>View and manage all system users</CardDescription>
            </CardHeader>
            <CardContent>
              {/* Search and Filter */}
              <div className="flex flex-col sm:flex-row gap-2 mb-4">
                <div className="relative flex-1">
                  <Search className="absolute left-3 top-2.5 h-4 w-4 text-[#485550]/40" />
                  <Input placeholder="Search users..." value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} className="pl-10 border-[#485550]/20" />
                </div>
                <Select value={userTypeFilter} onValueChange={setUserTypeFilter}>
                  <SelectTrigger className="w-full sm:w-48 border-[#485550]/20">
                    <Filter className="h-4 w-4 mr-2" />
                    <SelectValue placeholder="Filter by type" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Users</SelectItem>
                    <SelectItem value="STUDENT">Students</SelectItem>
                    <SelectItem value="LECTURER">Lecturers</SelectItem>
                    <SelectItem value="HOD">HODs</SelectItem>
                    <SelectItem value="DEAN">Deans</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* Desktop Table */}
              <div className="hidden md:block rounded-lg border border-[#F4F6F0] overflow-hidden">
                <div className="grid grid-cols-4 gap-4 p-4 font-medium bg-[#F4F6F0] text-[#485550]">
                  <div>Name</div>
                  <div>Role</div>
                  <div>Status</div>
                  <div>Actions</div>
                </div>
                {filteredUsers.map((user) => (
                  <div key={user.id} className="grid grid-cols-4 gap-4 p-4 border-b border-[#F4F6F0] hover:bg-[#F4F6F0]/50 cursor-pointer transition-colors" onClick={() => handleUserClick(user)}>
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-full bg-[#485550] flex items-center justify-center text-white font-bold flex-shrink-0 overflow-hidden">
                        {user.profilePhoto ? (
                          <img src={user.profilePhoto} alt="" className="w-full h-full object-cover" />
                        ) : (
                          <span>{user.firstName?.[0]}{user.lastName?.[0]}</span>
                        )}
                      </div>
                      <div className="min-w-0">
                        <div className="font-medium text-[#485550] truncate">{user.firstName} {user.lastName}</div>
                        <div className="text-xs text-[#485550]/60 truncate">{user.email}</div>
                      </div>
                    </div>
                    <div className="text-[#485550] flex items-center">{user.role}</div>
                    <div className="flex items-center">
                      <Badge variant="outline" className={user.status === 'ACTIVE' ? 'bg-[#C0EB6A]/20 text-[#485550] border-[#C0EB6A]' : 'bg-red-100 text-red-800'}>{user.status}</Badge>
                    </div>
                    <div className="flex gap-1 items-center" onClick={(e) => e.stopPropagation()}>
                      <Button size="sm" variant="ghost" onClick={() => handleUserClick(user)}><Eye className="h-4 w-4 text-[#485550]" /></Button>
                      <Button size="sm" variant="ghost" onClick={() => handleEditUser(user)}><Edit className="h-4 w-4 text-[#485550]" /></Button>
                      <Button size="sm" variant="ghost" onClick={() => handleDeleteUser(user.id)}><Trash2 className="h-4 w-4 text-red-500" /></Button>
                    </div>
                  </div>
                ))}
              </div>

              {/* Mobile Cards */}
              <div className="md:hidden space-y-3">
                {filteredUsers.map((user) => (
                  <Card key={user.id} className="cursor-pointer hover:shadow-md transition-shadow border-[#F4F6F0]" onClick={() => handleUserClick(user)}>
                    <CardContent className="p-4">
                      <div className="flex justify-between items-start">
                        <div>
                          <h3 className="font-medium text-[#485550]">{user.firstName} {user.lastName}</h3>
                          <p className="text-sm text-[#485550]/60">{user.email}</p>
                        </div>
                        <div className="flex flex-col items-end gap-1">
                          <Badge variant="outline" className="border-[#485550]">{user.role}</Badge>
                          <Badge variant="outline" className={user.status === 'ACTIVE' ? 'bg-[#C0EB6A]/20 text-[#485550]' : 'bg-red-100 text-red-800'}>{user.status}</Badge>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>

              {/* Empty State */}
              {filteredUsers.length === 0 && (
                <div className="text-center py-12">
                  <Users className="h-12 w-12 text-[#485550]/30 mx-auto mb-4" />
                  <h3 className="text-lg font-semibold text-[#485550] mb-2">No users found</h3>
                  <p className="text-[#485550]/60">Try adjusting your search or filter criteria.</p>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="student" className="mt-4"><StudentForm /></TabsContent>
        <TabsContent value="lecturer" className="mt-4"><LecturerForm /></TabsContent>
        <TabsContent value="hod" className="mt-4"><HODForm /></TabsContent>
        <TabsContent value="dean" className="mt-4"><DeanForm /></TabsContent>
      </Tabs>

      {/* Edit User Dialog */}
      <Dialog open={editDialogOpen} onOpenChange={setEditDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-[#485550]">Edit User</DialogTitle>
            <DialogDescription>Update user information</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            {/* Profile Photo Upload */}
            <div className="flex flex-col items-center gap-3 pb-4 border-b border-[#F4F6F0]">
              <div className="relative">
                <div className="w-24 h-24 rounded-full bg-[#F4F6F0] flex items-center justify-center overflow-hidden border-2 border-dashed border-[#485550]/30">
                  {photoPreview || editForm.profilePhoto ? (
                    <img src={photoPreview || editForm.profilePhoto} alt="Profile" className="w-full h-full object-cover" />
                  ) : (
                    <div className="w-full h-full bg-[#485550] flex items-center justify-center text-white text-2xl font-bold">
                      {editForm.firstName?.[0]}{editForm.lastName?.[0]}
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => photoInputRef.current?.click()}
                  className="absolute bottom-0 right-0 w-8 h-8 rounded-full bg-[#485550] text-white flex items-center justify-center hover:bg-[#6b7c6f] transition-colors"
                >
                  <Camera className="w-4 h-4" />
                </button>
                <input
                  ref={photoInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) {
                      if (file.size > 5 * 1024 * 1024) {
                        toast.error('Photo must be less than 5MB');
                        return;
                      }
                      setPhotoFile(file);
                      const reader = new FileReader();
                      reader.onloadend = () => setPhotoPreview(reader.result as string);
                      reader.readAsDataURL(file);
                    }
                  }}
                />
              </div>
              <div className="text-center">
                <p className="text-sm font-medium text-[#485550]">Profile Photo</p>
                <p className="text-xs text-[#485550]/60">Click camera to upload (max 5MB)</p>
                {photoPreview && (
                  <Button variant="link" size="sm" onClick={() => { setPhotoFile(null); setPhotoPreview(null); }} className="text-red-500 h-auto p-0 mt-1">
                    Remove Photo
                  </Button>
                )}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>First Name</Label>
                <Input value={editForm.firstName || ''} onChange={(e) => setEditForm({ ...editForm, firstName: e.target.value })} className="border-[#485550]/20" />
              </div>
              <div className="space-y-2">
                <Label>Last Name</Label>
                <Input value={editForm.lastName || ''} onChange={(e) => setEditForm({ ...editForm, lastName: e.target.value })} className="border-[#485550]/20" />
              </div>
            </div>
            <div className="space-y-2">
              <Label>Email</Label>
              <Input type="email" value={editForm.email || ''} onChange={(e) => setEditForm({ ...editForm, email: e.target.value })} className="border-[#485550]/20" />
            </div>
            <div className="space-y-2">
              <Label>Phone</Label>
              <Input value={editForm.phone || ''} onChange={(e) => setEditForm({ ...editForm, phone: e.target.value })} className="border-[#485550]/20" />
            </div>
            <div className="space-y-2">
              <Label>Status</Label>
              <Select value={editForm.status} onValueChange={(v) => setEditForm({ ...editForm, status: v })}>
                <SelectTrigger className="border-[#485550]/20"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="ACTIVE">Active</SelectItem>
                  <SelectItem value="INACTIVE">Inactive</SelectItem>
                  <SelectItem value="SUSPENDED">Suspended</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditDialogOpen(false)}>Cancel</Button>
            <Button onClick={handleSaveEdit} disabled={submitting} className="bg-[#485550] hover:bg-[#6b7c6f]">
              {submitting ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              Save Changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Password Reset Dialog */}
      <Dialog open={passwordResetOpen} onOpenChange={setPasswordResetOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-[#485550]">Reset Password</DialogTitle>
            <DialogDescription>Reset password for {selectedUser?.firstName} {selectedUser?.lastName}</DialogDescription>
          </DialogHeader>
          <div className="py-4">
            {!tempPassword ? (
              <div className="text-center space-y-4">
                <div className="w-16 h-16 rounded-full bg-amber-100 flex items-center justify-center mx-auto">
                  <Key className="h-8 w-8 text-amber-600" />
                </div>
                <p className="text-[#485550]/70">This will generate a new temporary password for the user. They will need to change it on their next login.</p>
                <Button onClick={handlePasswordReset} disabled={submitting} className="bg-amber-500 hover:bg-amber-600 text-white">
                  {submitting ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Key className="h-4 w-4 mr-2" />}
                  Generate Temporary Password
                </Button>
              </div>
            ) : (
              <div className="text-center space-y-4">
                <div className="w-16 h-16 rounded-full bg-[#C0EB6A]/20 flex items-center justify-center mx-auto">
                  <CheckCircle className="h-8 w-8 text-[#485550]" />
                </div>
                <p className="text-[#485550] font-medium">Password Reset Successful!</p>
                <div className="bg-[#F4F6F0] p-4 rounded-lg">
                  <p className="text-sm text-[#485550]/70 mb-2">Temporary Password:</p>
                  <div className="flex items-center justify-center gap-2">
                    <code className="text-lg font-mono font-bold text-[#485550]">{tempPassword}</code>
                    <Button size="sm" variant="ghost" onClick={() => copyToClipboard(tempPassword)}>
                      <Copy className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
                <p className="text-xs text-[#485550]/60">Make sure to share this password securely with the user.</p>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setPasswordResetOpen(false); setTempPassword(null); }}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* CSV Upload Preview Dialog */}
      <Dialog open={csvDialogOpen} onOpenChange={setCsvDialogOpen}>
        <DialogContent className="max-w-4xl max-h-[80vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle className="text-[#485550] flex items-center gap-2">
              <FileSpreadsheet className="h-5 w-5" /> CSV Import Preview
            </DialogTitle>
            <DialogDescription>{csvData.length} users found in file</DialogDescription>
          </DialogHeader>
          <div className="flex-1 overflow-auto py-4">
            {csvData.length > 0 && (
              <div className="border rounded-lg overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-[#F4F6F0]">
                    <tr>
                      <th className="px-3 py-2 text-left text-[#485550]">#</th>
                      <th className="px-3 py-2 text-left text-[#485550]">First Name</th>
                      <th className="px-3 py-2 text-left text-[#485550]">Last Name</th>
                      <th className="px-3 py-2 text-left text-[#485550]">Email</th>
                      <th className="px-3 py-2 text-left text-[#485550]">Role</th>
                      <th className="px-3 py-2 text-left text-[#485550]">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {csvData.slice(0, 50).map((row: any, idx: number) => {
                      const fn = row.firstName || row['First Name'] || '';
                      const ln = row.lastName || row['Last Name'] || '';
                      const em = row.email || row.Email || '';
                      const role = row.role || row.Role || 'STUDENT';
                      const valid = fn && ln && em;
                      return (
                        <tr key={idx} className={`border-t ${!valid ? 'bg-red-50' : ''}`}>
                          <td className="px-3 py-2">{idx + 1}</td>
                          <td className="px-3 py-2">{fn || <span className="text-red-500">Missing</span>}</td>
                          <td className="px-3 py-2">{ln || <span className="text-red-500">Missing</span>}</td>
                          <td className="px-3 py-2">{em || <span className="text-red-500">Missing</span>}</td>
                          <td className="px-3 py-2"><Badge variant="outline">{role}</Badge></td>
                          <td className="px-3 py-2">{valid ? <CheckCircle className="h-4 w-4 text-green-500" /> : <XCircle className="h-4 w-4 text-red-500" />}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {csvData.length > 50 && <p className="text-center py-2 text-sm text-[#485550]/60">Showing first 50 of {csvData.length} rows</p>}
              </div>
            )}
          </div>
          <DialogFooter className="border-t pt-4">
            <Button variant="outline" onClick={() => { setCsvDialogOpen(false); setCsvData([]); }}>Cancel</Button>
            <Button onClick={handleBulkUpload} disabled={csvUploading} className="bg-[#485550] hover:bg-[#6b7c6f]">
              {csvUploading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Upload className="h-4 w-4 mr-2" />}
              Import {csvData.length} Users
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
