'use client';

import { useState, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import {
  Plus,
  Calendar,
  Play,
  Settings,
  Users,
  Clock,
  CheckCircle,
  AlertTriangle,
  Bell,
  Loader2,
  X,
  Save,
  Download,
  Edit,
  Trash2,
  BookOpen,
} from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';

interface AcademicSession {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  status: 'active' | 'upcoming' | 'completed';
  isDefault: boolean;
  createdAt: string;
}

interface RegistrationPeriod {
  id: string;
  sessionId: string;
  sessionName: string;
  semesterName: string;
  registrationStart: string;
  registrationEnd: string;
  lateRegistrationEnd: string;
  status: 'active' | 'closed' | 'upcoming';
}

// Mock data
const mockSessions: AcademicSession[] = [
  { id: 's1', name: '2024/2025 Academic Session', startDate: '2024-09-01', endDate: '2025-07-31', status: 'active', isDefault: true, createdAt: '2024-01-15' },
  { id: 's2', name: '2023/2024 Academic Session', startDate: '2023-09-01', endDate: '2024-07-31', status: 'completed', isDefault: false, createdAt: '2023-01-10' },
  { id: 's3', name: '2025/2026 Academic Session', startDate: '2025-09-01', endDate: '2026-07-31', status: 'upcoming', isDefault: false, createdAt: '2024-12-01' },
];

const mockRegistrationPeriods: RegistrationPeriod[] = [
  { id: 'r1', sessionId: 's1', sessionName: '2024/2025 Academic Session', semesterName: 'First Semester', registrationStart: '2024-08-15T08:00', registrationEnd: '2024-09-15T23:59', lateRegistrationEnd: '2024-09-30T23:59', status: 'closed' },
  { id: 'r2', sessionId: 's1', sessionName: '2024/2025 Academic Session', semesterName: 'Second Semester', registrationStart: '2025-01-10T08:00', registrationEnd: '2025-02-10T23:59', lateRegistrationEnd: '2025-02-28T23:59', status: 'active' },
];

export default function AcademicSessionManagement() {
  const [isLoading, setIsLoading] = useState(true);
  const [isCreatingSession, setIsCreatingSession] = useState(false);
  const [isCreatingRegistration, setIsCreatingRegistration] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [academicSessions, setAcademicSessions] = useState<AcademicSession[]>([]);
  const [registrationPeriods, setRegistrationPeriods] = useState<RegistrationPeriod[]>([]);

  const [sessionForm, setSessionForm] = useState({ name: '', startDate: '', endDate: '' });
  const [registrationForm, setRegistrationForm] = useState({
    sessionId: '', semesterId: '', registrationStart: '', registrationEnd: '', lateRegistrationEnd: ''
  });

  // New state for edit and settings
  const [editingSession, setEditingSession] = useState<AcademicSession | null>(null);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [settingsDialogOpen, setSettingsDialogOpen] = useState(false);
  const [selectedSession, setSelectedSession] = useState<AcademicSession | null>(null);

  // Semester configuration
  const [semesters, setSemesters] = useState([
    { id: 'first', name: 'First Semester', shortName: '1st Sem' },
    { id: 'second', name: 'Second Semester', shortName: '2nd Sem' },
  ]);

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    setIsLoading(true);
    try {
      if (api.isAuthenticated()) {
        const sessionsData = await api.getAdminSessions();
        setAcademicSessions(sessionsData.map((s: any) => ({
          id: s.id, name: s.name, startDate: s.startDate || s.start_date,
          endDate: s.endDate || s.end_date, status: s.isActive ? 'active' : 'upcoming',
          isDefault: s.isActive || false, createdAt: s.createdAt || s.created_at
        })));
        // For now, registration periods use mock data as API might not have this yet
        setRegistrationPeriods(mockRegistrationPeriods);
      } else {
        setAcademicSessions(mockSessions);
        setRegistrationPeriods(mockRegistrationPeriods);
      }
    } catch (error) {
      console.error('Failed to fetch sessions:', error);
      setAcademicSessions(mockSessions);
      setRegistrationPeriods(mockRegistrationPeriods);
    } finally {
      setIsLoading(false);
    }
  };

  const handleCreateSession = async () => {
    if (!sessionForm.name || !sessionForm.startDate || !sessionForm.endDate) {
      toast.error('Please fill in all required fields');
      return;
    }
    setSubmitting(true);
    try {
      if (api.isAuthenticated()) {
        await api.createAdminSession({
          name: sessionForm.name,
          startDate: sessionForm.startDate,
          endDate: sessionForm.endDate
        });
        await fetchData();
      }
      toast.success('Academic session created successfully!');
      setIsCreatingSession(false);
      setSessionForm({ name: '', startDate: '', endDate: '' });
    } catch (error: any) {
      toast.error(error.message || 'Failed to create session');
    } finally {
      setSubmitting(false);
    }
  };

  const handleCreateRegistrationPeriod = async () => {
    if (!registrationForm.sessionId || !registrationForm.registrationStart ||
      !registrationForm.registrationEnd || !registrationForm.lateRegistrationEnd) {
      toast.error('Please fill in all required fields');
      return;
    }
    setSubmitting(true);
    try {
      // In a real implementation, this would call an API
      toast.success('Registration period created successfully!');
      setIsCreatingRegistration(false);
      setRegistrationForm({ sessionId: '', semesterId: '', registrationStart: '', registrationEnd: '', lateRegistrationEnd: '' });
    } catch (error: any) {
      toast.error(error.message || 'Failed to create registration period');
    } finally {
      setSubmitting(false);
    }
  };

  const handleActivateSession = async (sessionId: string) => {
    try {
      if (api.isAuthenticated()) {
        await api.setCurrentAdminSession(sessionId);
        await fetchData();
      }
      toast.success('Session activated!');
    } catch (error: any) {
      toast.error(error.message || 'Failed to activate session');
    }
  };

  // Edit session
  const handleEditSession = (session: AcademicSession) => {
    setEditingSession(session);
    setSessionForm({ name: session.name, startDate: session.startDate.split('T')[0], endDate: session.endDate.split('T')[0] });
    setEditDialogOpen(true);
  };

  const handleSaveEdit = async () => {
    if (!editingSession || !sessionForm.name) return;
    setSubmitting(true);
    try {
      if (api.isAuthenticated()) {
        await api.updateAdminSession(editingSession.id, sessionForm);
        await fetchData();
      } else {
        setAcademicSessions(academicSessions.map(s =>
          s.id === editingSession.id ? { ...s, ...sessionForm } : s
        ));
      }
      toast.success('Session updated successfully!');
      setEditDialogOpen(false);
      setEditingSession(null);
    } catch (error: any) {
      toast.error(error.message || 'Failed to update session');
    } finally {
      setSubmitting(false);
    }
  };

  // Delete session
  const handleDeleteSession = async (sessionId: string) => {
    if (!confirm('Are you sure you want to delete this session? This action cannot be undone.')) return;
    try {
      // In a real implementation, this would call an API
      setAcademicSessions(academicSessions.filter(s => s.id !== sessionId));
      toast.success('Session deleted successfully!');
    } catch (error: any) {
      toast.error(error.message || 'Failed to delete session');
    }
  };

  // Settings dialog
  const handleOpenSettings = (session: AcademicSession) => {
    setSelectedSession(session);
    setSettingsDialogOpen(true);
  };

  // Export to CSV
  const handleExportSessions = () => {
    const csvRows = ['Name,Start Date,End Date,Status,Created'];
    academicSessions.forEach(s => {
      csvRows.push(`"${s.name}","${s.startDate}","${s.endDate}","${s.status}","${s.createdAt}"`);
    });
    const blob = new Blob([csvRows.join('\n')], { type: 'text/csv' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `academic_sessions_${new Date().toISOString().split('T')[0]}.csv`;
    link.click();
    toast.success('Sessions exported to CSV!');
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'active': return <Badge className="bg-[#C0EB6A]/20 text-[#485550] border-[#C0EB6A]">Active</Badge>;
      case 'upcoming': return <Badge className="bg-blue-50 text-blue-600 border-blue-200">Upcoming</Badge>;
      case 'completed': return <Badge className="bg-gray-50 text-gray-600 border-gray-200">Completed</Badge>;
      case 'closed': return <Badge className="bg-red-50 text-red-600 border-red-200">Closed</Badge>;
      default: return <Badge variant="outline">{status}</Badge>;
    }
  };

  const formatDateTime = (dateString: string) => {
    if (!dateString) return 'N/A';
    return new Date(dateString).toLocaleDateString('en-US', {
      year: 'numeric', month: 'short', day: 'numeric'
    });
  };

  const activeSession = academicSessions.find(s => s.status === 'active');
  const activeRegistration = registrationPeriods.filter(p => p.status === 'active').length;

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
        <h1 className="text-3xl font-bold text-[#485550]">Academic Session Management</h1>
        <p className="text-[#485550]/60 mt-1">Manage academic sessions and course registration periods</p>
      </div>

      {/* Statistics Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card className="border-[#F4F6F0]">
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-[#F4F6F0] flex items-center justify-center">
                <Calendar className="w-5 h-5 text-[#485550]" />
              </div>
              <div>
                <p className="text-2xl font-bold text-[#485550]">{academicSessions.length}</p>
                <p className="text-sm text-[#485550]/60">Total Sessions</p>
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
                <p className="text-2xl font-bold text-[#485550]">{activeSession ? 1 : 0}</p>
                <p className="text-sm text-[#485550]/60">Active Session</p>
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
                <p className="text-2xl font-bold text-[#485550]">{activeRegistration}</p>
                <p className="text-sm text-[#485550]/60">Active Registration</p>
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
                <p className="text-2xl font-bold text-[#485550]">2,847</p>
                <p className="text-sm text-[#485550]/60">Registered Students</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Quick Actions */}
      <div className="flex flex-wrap gap-3">
        <Button onClick={() => setIsCreatingSession(true)} disabled={isCreatingSession} className="bg-[#485550] hover:bg-[#6b7c6f]">
          <Plus className="w-4 h-4 mr-2" /> New Academic Session
        </Button>
        <Button variant="outline" onClick={() => setIsCreatingRegistration(true)} disabled={isCreatingRegistration} className="border-[#485550] text-[#485550]">
          <Calendar className="w-4 h-4 mr-2" /> Set Registration Period
        </Button>
        <Button variant="outline" onClick={handleExportSessions} className="border-[#485550] text-[#485550]">
          <Download className="w-4 h-4 mr-2" /> Export to CSV
        </Button>
      </div>

      {/* Create Academic Session Form */}
      {isCreatingSession && (
        <Card className="border-[#C0EB6A]">
          <CardHeader>
            <CardTitle className="text-[#485550]">Create New Academic Session</CardTitle>
            <CardDescription>Set up a new academic session for the institution</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label>Session Name <span className="text-red-500">*</span></Label>
                <Input placeholder="e.g., 2024/2025 Academic Session" value={sessionForm.name}
                  onChange={(e) => setSessionForm({ ...sessionForm, name: e.target.value })} className="border-[#485550]/20" />
              </div>
              <div className="space-y-2">
                <Label>Start Date <span className="text-red-500">*</span></Label>
                <Input type="date" value={sessionForm.startDate}
                  onChange={(e) => setSessionForm({ ...sessionForm, startDate: e.target.value })} className="border-[#485550]/20" />
              </div>
              <div className="space-y-2">
                <Label>End Date <span className="text-red-500">*</span></Label>
                <Input type="date" value={sessionForm.endDate}
                  onChange={(e) => setSessionForm({ ...sessionForm, endDate: e.target.value })} className="border-[#485550]/20" />
              </div>
            </div>
            <div className="flex items-center gap-4 p-4 bg-blue-50 rounded-lg">
              <Bell className="w-5 h-5 text-blue-600" />
              <div className="flex-1">
                <p className="text-sm font-medium text-blue-900">Automatic Notifications</p>
                <p className="text-sm text-blue-700">All users will be notified when this session is created and activated</p>
              </div>
            </div>
            <div className="flex gap-3">
              <Button onClick={handleCreateSession} disabled={submitting} className="bg-[#485550] hover:bg-[#6b7c6f]">
                {submitting ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
                Create Session
              </Button>
              <Button variant="outline" onClick={() => { setIsCreatingSession(false); setSessionForm({ name: '', startDate: '', endDate: '' }); }} className="border-[#485550]">
                <X className="w-4 h-4 mr-2" /> Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Create Registration Period Form */}
      {isCreatingRegistration && (
        <Card className="border-[#C0EB6A]">
          <CardHeader>
            <CardTitle className="text-[#485550]">Set Course Registration Period</CardTitle>
            <CardDescription>Configure registration deadlines and late registration periods</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Academic Session <span className="text-red-500">*</span></Label>
                <Select value={registrationForm.sessionId} onValueChange={(val) => setRegistrationForm({ ...registrationForm, sessionId: val })}>
                  <SelectTrigger className="border-[#485550]/20"><SelectValue placeholder="Select Session" /></SelectTrigger>
                  <SelectContent>{academicSessions.map(s => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Semester <span className="text-red-500">*</span></Label>
                <Select value={registrationForm.semesterId} onValueChange={(val) => setRegistrationForm({ ...registrationForm, semesterId: val })}>
                  <SelectTrigger className="border-[#485550]/20"><SelectValue placeholder="Select Semester" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="first">First Semester</SelectItem>
                    <SelectItem value="second">Second Semester</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label>Registration Start <span className="text-red-500">*</span></Label>
                <Input type="datetime-local" value={registrationForm.registrationStart}
                  onChange={(e) => setRegistrationForm({ ...registrationForm, registrationStart: e.target.value })} className="border-[#485550]/20" />
              </div>
              <div className="space-y-2">
                <Label>Registration Deadline <span className="text-red-500">*</span></Label>
                <Input type="datetime-local" value={registrationForm.registrationEnd}
                  onChange={(e) => setRegistrationForm({ ...registrationForm, registrationEnd: e.target.value })} className="border-[#485550]/20" />
              </div>
              <div className="space-y-2">
                <Label>Late Registration End <span className="text-red-500">*</span></Label>
                <Input type="datetime-local" value={registrationForm.lateRegistrationEnd}
                  onChange={(e) => setRegistrationForm({ ...registrationForm, lateRegistrationEnd: e.target.value })} className="border-[#485550]/20" />
              </div>
            </div>
            <div className="flex items-center gap-4 p-4 bg-amber-50 rounded-lg">
              <AlertTriangle className="w-5 h-5 text-amber-600" />
              <div className="flex-1">
                <p className="text-sm font-medium text-amber-900">Notification Schedule</p>
                <p className="text-sm text-amber-700">Students will receive notifications at registration start, 3 days before deadline, and when late registration begins</p>
              </div>
            </div>
            <div className="flex gap-3">
              <Button onClick={handleCreateRegistrationPeriod} disabled={submitting} className="bg-[#485550] hover:bg-[#6b7c6f]">
                {submitting ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Calendar className="w-4 h-4 mr-2" />}
                Set Registration Period
              </Button>
              <Button variant="outline" onClick={() => { setIsCreatingRegistration(false); setRegistrationForm({ sessionId: '', semesterId: '', registrationStart: '', registrationEnd: '', lateRegistrationEnd: '' }); }} className="border-[#485550]">
                <X className="w-4 h-4 mr-2" /> Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Academic Sessions List */}
      <Card className="border-[#F4F6F0]">
        <CardHeader>
          <CardTitle className="text-[#485550]">Academic Sessions</CardTitle>
          <CardDescription>Manage all academic sessions and their status</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {academicSessions.length === 0 ? (
            <div className="p-8 text-center">
              <Calendar className="w-12 h-12 text-[#485550]/30 mx-auto mb-4" />
              <h3 className="text-lg font-medium text-[#485550] mb-2">No sessions found</h3>
              <p className="text-[#485550]/60">Create your first academic session to get started.</p>
            </div>
          ) : (
            academicSessions.map(session => (
              <div key={session.id} className="flex items-center justify-between p-4 border border-[#F4F6F0] rounded-lg hover:bg-[#F4F6F0]/50 transition-colors">
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 rounded-lg bg-[#C0EB6A]/20 flex items-center justify-center">
                    <Calendar className="w-6 h-6 text-[#485550]" />
                  </div>
                  <div>
                    <div className="flex items-center gap-2 mb-1">
                      <h3 className="font-semibold text-[#485550]">{session.name}</h3>
                      {session.isDefault && <Badge variant="outline" className="border-[#C0EB6A] text-[#485550]">Default</Badge>}
                    </div>
                    <p className="text-sm text-[#485550]/70">
                      {formatDateTime(session.startDate)} - {formatDateTime(session.endDate)}
                    </p>
                    <p className="text-xs text-[#485550]/50">Created {formatDateTime(session.createdAt)}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  {getStatusBadge(session.status)}
                  {session.status !== 'active' && (
                    <Button size="sm" onClick={() => handleActivateSession(session.id)} className="bg-[#485550] hover:bg-[#6b7c6f]">
                      <Play className="w-4 h-4 mr-2" /> Activate
                    </Button>
                  )}
                  <Button variant="outline" size="sm" onClick={() => handleEditSession(session)} className="border-[#485550]/30">
                    <Edit className="w-4 h-4" />
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => handleOpenSettings(session)} className="border-[#485550]/30">
                    <Settings className="w-4 h-4" />
                  </Button>
                  {session.status !== 'active' && (
                    <Button variant="outline" size="sm" onClick={() => handleDeleteSession(session.id)} className="border-red-300 text-red-500 hover:bg-red-50">
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  )}
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      {/* Registration Periods List */}
      <Card className="border-[#F4F6F0]">
        <CardHeader>
          <CardTitle className="text-[#485550]">Course Registration Periods</CardTitle>
          <CardDescription>Monitor and manage course registration deadlines</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {registrationPeriods.length === 0 ? (
            <div className="p-8 text-center">
              <Clock className="w-12 h-12 text-[#485550]/30 mx-auto mb-4" />
              <h3 className="text-lg font-medium text-[#485550] mb-2">No registration periods</h3>
              <p className="text-[#485550]/60">Set up a registration period for students to register for courses.</p>
            </div>
          ) : (
            registrationPeriods.map(period => (
              <div key={period.id} className="p-4 border border-[#F4F6F0] rounded-lg">
                <div className="flex items-start justify-between mb-3">
                  <div>
                    <h3 className="font-semibold text-[#485550]">{period.sessionName}</h3>
                    <p className="text-sm text-[#485550]/70">{period.semesterName}</p>
                  </div>
                  {getStatusBadge(period.status)}
                </div>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
                  <div className="flex items-center gap-2">
                    <Clock className="w-4 h-4 text-green-600" />
                    <div>
                      <p className="font-medium text-[#485550]">Registration Opens</p>
                      <p className="text-[#485550]/70">{formatDateTime(period.registrationStart)}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <AlertTriangle className="w-4 h-4 text-amber-600" />
                    <div>
                      <p className="font-medium text-[#485550]">Registration Deadline</p>
                      <p className="text-[#485550]/70">{formatDateTime(period.registrationEnd)}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Clock className="w-4 h-4 text-red-500" />
                    <div>
                      <p className="font-medium text-[#485550]">Late Registration Ends</p>
                      <p className="text-[#485550]/70">{formatDateTime(period.lateRegistrationEnd)}</p>
                    </div>
                  </div>
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      {/* Edit Session Dialog */}
      <Dialog open={editDialogOpen} onOpenChange={setEditDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-[#485550]">Edit Academic Session</DialogTitle>
            <DialogDescription>Update session details</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>Session Name <span className="text-red-500">*</span></Label>
              <Input value={sessionForm.name} onChange={(e) => setSessionForm({ ...sessionForm, name: e.target.value })} className="border-[#485550]/20" />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Start Date</Label>
                <Input type="date" value={sessionForm.startDate} onChange={(e) => setSessionForm({ ...sessionForm, startDate: e.target.value })} className="border-[#485550]/20" />
              </div>
              <div className="space-y-2">
                <Label>End Date</Label>
                <Input type="date" value={sessionForm.endDate} onChange={(e) => setSessionForm({ ...sessionForm, endDate: e.target.value })} className="border-[#485550]/20" />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditDialogOpen(false)}>Cancel</Button>
            <Button onClick={handleSaveEdit} disabled={submitting} className="bg-[#485550] hover:bg-[#6b7c6f]">
              {submitting ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Save className="w-4 h-4 mr-2" />}
              Save Changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Settings Dialog */}
      <Dialog open={settingsDialogOpen} onOpenChange={setSettingsDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-[#485550] flex items-center gap-2">
              <Settings className="w-5 h-5" /> Session Settings
            </DialogTitle>
            <DialogDescription>{selectedSession?.name}</DialogDescription>
          </DialogHeader>
          <div className="space-y-6 py-4">
            {/* Semester Configuration */}
            <div>
              <h3 className="text-sm font-semibold text-[#485550] mb-3 flex items-center gap-2">
                <BookOpen className="w-4 h-4" /> Semester Configuration
              </h3>
              <div className="space-y-3">
                {semesters.map((sem, idx) => (
                  <div key={sem.id} className="flex items-center gap-3 p-3 border border-[#F4F6F0] rounded-lg">
                    <div className="w-8 h-8 rounded-full bg-[#C0EB6A]/20 flex items-center justify-center text-sm font-bold text-[#485550]">
                      {idx + 1}
                    </div>
                    <div className="flex-1">
                      <p className="font-medium text-[#485550]">{sem.name}</p>
                      <p className="text-xs text-[#485550]/60">{sem.shortName}</p>
                    </div>
                    <Badge variant="outline" className="border-[#C0EB6A] text-[#485550]">Active</Badge>
                  </div>
                ))}
              </div>
              <Button variant="outline" size="sm" className="mt-3 border-dashed border-[#485550]/30 text-[#485550]/70">
                <Plus className="w-4 h-4 mr-2" /> Add Summer Semester
              </Button>
            </div>

            {/* Session Status */}
            <div>
              <h3 className="text-sm font-semibold text-[#485550] mb-3 flex items-center gap-2">
                <CheckCircle className="w-4 h-4" /> Session Status
              </h3>
              <div className="flex items-center gap-3 p-3 bg-[#F4F6F0] rounded-lg">
                <div className="flex-1">
                  <p className="text-sm font-medium text-[#485550]">Current Status</p>
                  <p className="text-xs text-[#485550]/70">{selectedSession?.status === 'active' ? 'This session is currently active' : 'This session is not active'}</p>
                </div>
                {selectedSession && getStatusBadge(selectedSession.status)}
              </div>
            </div>

            {/* Registration Periods for this session */}
            <div>
              <h3 className="text-sm font-semibold text-[#485550] mb-3 flex items-center gap-2">
                <Calendar className="w-4 h-4" /> Registration Periods
              </h3>
              <p className="text-sm text-[#485550]/70">
                {registrationPeriods.filter(p => p.sessionId === selectedSession?.id).length} registration period(s) configured
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSettingsDialogOpen(false)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
