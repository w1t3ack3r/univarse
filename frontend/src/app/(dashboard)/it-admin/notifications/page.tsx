'use client';

import { useState, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Bell,
  Send,
  Mail,
  MessageSquare,
  Users,
  Calendar,
  Clock,
  Eye,
  Trash2,
  Loader2,
  CheckCircle
} from 'lucide-react';
import { toast } from 'sonner';

interface Notification {
  id: string;
  title: string;
  message: string;
  type: string;
  recipients: string;
  status: 'Sent' | 'Read' | 'Scheduled';
  priority: 'Low' | 'Medium' | 'High' | 'Urgent';
  timestamp: string;
}

// Mock data
const mockNotifications: Notification[] = [
  { id: 'n1', title: 'Course Registration Open', message: 'The course registration for the second semester is now open. Please register before the deadline.', type: 'Email', recipients: 'All Students', status: 'Sent', priority: 'High', timestamp: '2024-01-14 09:30 AM' },
  { id: 'n2', title: 'Faculty Meeting Reminder', message: 'Reminder: There will be a faculty meeting on Friday at 2:00 PM in the conference room.', type: 'In-App', recipients: 'All Faculty', status: 'Sent', priority: 'Medium', timestamp: '2024-01-13 02:15 PM' },
  { id: 'n3', title: 'System Maintenance Notice', message: 'The system will undergo maintenance on Saturday from 2-4 AM. Some services may be unavailable.', type: 'Both', recipients: 'All Users', status: 'Scheduled', priority: 'Medium', timestamp: '2024-01-15 02:00 AM' },
  { id: 'n4', title: 'Exam Schedule Published', message: 'The examination schedule for the semester has been published. Please check your portal.', type: 'Email', recipients: 'All Students', status: 'Sent', priority: 'High', timestamp: '2024-01-12 10:00 AM' },
];

const templates = [
  { id: 1, name: 'System Maintenance', category: 'System', usage: 12 },
  { id: 2, name: 'Course Registration', category: 'Academic', usage: 8 },
  { id: 3, name: 'Faculty Meeting', category: 'Administrative', usage: 15 },
  { id: 4, name: 'Exam Schedule', category: 'Academic', usage: 6 },
  { id: 5, name: 'Holiday Notice', category: 'General', usage: 4 },
  { id: 6, name: 'Emergency Alert', category: 'Urgent', usage: 2 },
];

const recipientGroups = [
  { id: 'all', label: 'All Users', count: 3159 },
  { id: 'students', label: 'All Students', count: 2847 },
  { id: 'faculty', label: 'All Faculty', count: 156 },
  { id: 'deans', label: 'Deans', count: 8 },
  { id: 'hods', label: 'HODs', count: 24 },
  { id: 'cs-dept', label: 'Computer Science Dept', count: 456 },
  { id: 'eng-dept', label: 'Engineering Dept', count: 389 },
  { id: 'business-dept', label: 'Business Dept', count: 334 },
];

export default function NotificationsPage() {
  const [isLoading, setIsLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [selectedRecipients, setSelectedRecipients] = useState<string[]>([]);
  const [notificationType, setNotificationType] = useState('email');
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [priority, setPriority] = useState('medium');
  const [scheduleEnabled, setScheduleEnabled] = useState(false);
  const [scheduleDate, setScheduleDate] = useState('');
  const [scheduleTime, setScheduleTime] = useState('');

  useEffect(() => {
    setTimeout(() => {
      setNotifications(mockNotifications);
      setIsLoading(false);
    }, 500);
  }, []);

  const handleRecipientChange = (groupId: string, checked: boolean) => {
    if (checked) {
      setSelectedRecipients([...selectedRecipients, groupId]);
    } else {
      setSelectedRecipients(selectedRecipients.filter(id => id !== groupId));
    }
  };

  const getTotalRecipients = () => {
    return selectedRecipients.reduce((total, groupId) => {
      const group = recipientGroups.find(g => g.id === groupId);
      return total + (group?.count || 0);
    }, 0);
  };

  const handleSendNotification = async () => {
    if (selectedRecipients.length === 0 || !subject || !message) {
      toast.error('Please fill all required fields');
      return;
    }
    setSubmitting(true);
    try {
      // Simulate API call
      await new Promise(r => setTimeout(r, 1000));
      toast.success('Notification sent successfully!');
      setSubject('');
      setMessage('');
      setSelectedRecipients([]);
      setPriority('medium');
    } catch (error: any) {
      toast.error(error.message || 'Failed to send notification');
    } finally {
      setSubmitting(false);
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'Sent': return <Badge className="bg-[#C0EB6A]/20 text-[#485550] border-[#C0EB6A]">Sent</Badge>;
      case 'Read': return <Badge className="bg-blue-50 text-blue-600 border-blue-200">Read</Badge>;
      case 'Scheduled': return <Badge className="bg-amber-50 text-amber-600 border-amber-200">Scheduled</Badge>;
      default: return <Badge variant="outline">{status}</Badge>;
    }
  };

  const getPriorityBadge = (priority: string) => {
    switch (priority) {
      case 'Urgent': return <Badge className="bg-red-100 text-red-700">Urgent</Badge>;
      case 'High': return <Badge className="bg-orange-50 text-orange-600">High</Badge>;
      case 'Medium': return <Badge className="bg-blue-50 text-blue-600">Medium</Badge>;
      case 'Low': return <Badge className="bg-gray-50 text-gray-600">Low</Badge>;
      default: return <Badge variant="outline">{priority}</Badge>;
    }
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
        <h1 className="text-3xl font-bold text-[#485550]">Notifications</h1>
        <p className="text-[#485550]/60 mt-1">Send and manage notifications across your institution</p>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card className="border-[#F4F6F0]">
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-[#F4F6F0] flex items-center justify-center">
                <Send className="w-5 h-5 text-[#485550]" />
              </div>
              <div>
                <p className="text-2xl font-bold text-[#485550]">24</p>
                <p className="text-sm text-[#485550]/60">Sent Today</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card className="border-[#F4F6F0]">
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-[#C0EB6A]/20 flex items-center justify-center">
                <Clock className="w-5 h-5 text-[#485550]" />
              </div>
              <div>
                <p className="text-2xl font-bold text-[#485550]">8</p>
                <p className="text-sm text-[#485550]/60">Scheduled</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card className="border-[#F4F6F0]">
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-[#F4F6F0] flex items-center justify-center">
                <Eye className="w-5 h-5 text-[#485550]" />
              </div>
              <div>
                <p className="text-2xl font-bold text-[#485550]">87%</p>
                <p className="text-sm text-[#485550]/60">Open Rate</p>
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
                <p className="text-2xl font-bold text-[#485550]">3,159</p>
                <p className="text-sm text-[#485550]/60">Total Recipients</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Tabs */}
      <Tabs defaultValue="compose" className="space-y-4">
        <TabsList className="bg-[#485550]">
          <TabsTrigger value="compose" className="text-white data-[state=active]:bg-[#C0EB6A] data-[state=active]:text-[#485550]">Compose</TabsTrigger>
          <TabsTrigger value="history" className="text-white data-[state=active]:bg-[#C0EB6A] data-[state=active]:text-[#485550]">History</TabsTrigger>
          <TabsTrigger value="templates" className="text-white data-[state=active]:bg-[#C0EB6A] data-[state=active]:text-[#485550]">Templates</TabsTrigger>
        </TabsList>

        {/* Compose Tab */}
        <TabsContent value="compose" className="space-y-4">
          <Card className="border-[#F4F6F0]">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-[#485550]">
                <Bell className="h-5 w-5" /> Compose Notification
              </CardTitle>
              <CardDescription>Send notifications to users across your institution</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              {/* Notification Type */}
              <div className="space-y-2">
                <Label className="text-[#485550]">Notification Type</Label>
                <div className="flex flex-wrap gap-4">
                  {[
                    { id: 'email', label: 'Email', icon: Mail },
                    { id: 'inapp', label: 'In-App', icon: Bell },
                    { id: 'both', label: 'Both', icon: CheckCircle },
                  ].map(type => (
                    <label key={type.id} className={`flex items-center gap-2 p-3 border rounded-lg cursor-pointer transition-colors ${notificationType === type.id ? 'border-[#C0EB6A] bg-[#C0EB6A]/10' : 'border-[#F4F6F0] hover:border-[#485550]/30'}`}>
                      <input type="radio" name="type" value={type.id} checked={notificationType === type.id}
                        onChange={(e) => setNotificationType(e.target.value)} className="sr-only" />
                      <type.icon className="w-4 h-4 text-[#485550]" />
                      <span className="text-[#485550]">{type.label}</span>
                    </label>
                  ))}
                </div>
              </div>

              {/* Recipients */}
              <div className="space-y-4">
                <Label className="text-[#485550]">Select Recipients</Label>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
                  {recipientGroups.map(group => (
                    <div key={group.id} className={`flex items-center gap-3 p-3 border rounded-lg transition-colors ${selectedRecipients.includes(group.id) ? 'border-[#C0EB6A] bg-[#C0EB6A]/10' : 'border-[#F4F6F0]'}`}>
                      <Checkbox id={group.id} checked={selectedRecipients.includes(group.id)}
                        onCheckedChange={(checked) => handleRecipientChange(group.id, checked as boolean)} />
                      <div className="flex-1">
                        <label htmlFor={group.id} className="cursor-pointer font-medium text-[#485550] text-sm">{group.label}</label>
                        <p className="text-xs text-[#485550]/60">{group.count.toLocaleString()} users</p>
                      </div>
                    </div>
                  ))}
                </div>
                {selectedRecipients.length > 0 && (
                  <div className="p-3 bg-[#C0EB6A]/20 rounded-lg">
                    <p className="text-sm font-medium text-[#485550]">Total Recipients: {getTotalRecipients().toLocaleString()} users</p>
                  </div>
                )}
              </div>

              {/* Subject & Priority */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label className="text-[#485550]">Subject <span className="text-red-500">*</span></Label>
                  <Input placeholder="Enter notification subject" value={subject} onChange={(e) => setSubject(e.target.value)} className="border-[#485550]/20" />
                </div>
                <div className="space-y-2">
                  <Label className="text-[#485550]">Priority</Label>
                  <Select value={priority} onValueChange={setPriority}>
                    <SelectTrigger className="border-[#485550]/20"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="low">Low</SelectItem>
                      <SelectItem value="medium">Medium</SelectItem>
                      <SelectItem value="high">High</SelectItem>
                      <SelectItem value="urgent">Urgent</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {/* Message */}
              <div className="space-y-2">
                <Label className="text-[#485550]">Message <span className="text-red-500">*</span></Label>
                <Textarea placeholder="Enter your notification message..." value={message} onChange={(e) => setMessage(e.target.value)} className="min-h-[120px] border-[#485550]/20" />
              </div>

              {/* Scheduling */}
              <div className="space-y-4">
                <div className="flex items-center gap-2">
                  <Switch id="schedule" checked={scheduleEnabled} onCheckedChange={setScheduleEnabled} />
                  <Label htmlFor="schedule" className="text-[#485550] cursor-pointer">Schedule for later</Label>
                </div>
                {scheduleEnabled && (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label className="text-[#485550]">Date</Label>
                      <Input type="date" value={scheduleDate} onChange={(e) => setScheduleDate(e.target.value)} className="border-[#485550]/20" />
                    </div>
                    <div className="space-y-2">
                      <Label className="text-[#485550]">Time</Label>
                      <Input type="time" value={scheduleTime} onChange={(e) => setScheduleTime(e.target.value)} className="border-[#485550]/20" />
                    </div>
                  </div>
                )}
              </div>

              {/* Actions */}
              <div className="flex flex-wrap gap-3 pt-4">
                <Button onClick={handleSendNotification} disabled={submitting} className="bg-[#485550] hover:bg-[#6b7c6f]">
                  {submitting ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Send className="w-4 h-4 mr-2" />}
                  {submitting ? 'Sending...' : 'Send Now'}
                </Button>
                {scheduleEnabled && (
                  <Button variant="outline" className="border-[#485550] text-[#485550]">
                    <Calendar className="w-4 h-4 mr-2" /> Schedule
                  </Button>
                )}
                <Button variant="outline" className="border-[#485550] text-[#485550]">Save as Template</Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* History Tab */}
        <TabsContent value="history" className="space-y-4">
          <Card className="border-[#F4F6F0]">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-[#485550]">
                <Clock className="h-5 w-5" /> Notification History
              </CardTitle>
              <CardDescription>View all sent and scheduled notifications</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {notifications.length === 0 ? (
                <div className="p-8 text-center">
                  <Bell className="w-12 h-12 text-[#485550]/30 mx-auto mb-4" />
                  <h3 className="text-lg font-medium text-[#485550] mb-2">No notifications yet</h3>
                  <p className="text-[#485550]/60">Sent notifications will appear here.</p>
                </div>
              ) : (
                notifications.map(notification => (
                  <div key={notification.id} className="p-4 border border-[#F4F6F0] rounded-lg hover:bg-[#F4F6F0]/50 transition-colors">
                    <div className="flex justify-between items-start mb-2">
                      <h4 className="font-semibold text-[#485550]">{notification.title}</h4>
                      <div className="flex items-center gap-2">
                        {getStatusBadge(notification.status)}
                        {getPriorityBadge(notification.priority)}
                      </div>
                    </div>
                    <p className="text-sm text-[#485550]/70 mb-3">{notification.message}</p>
                    <div className="flex flex-wrap justify-between items-center text-xs text-[#485550]/60">
                      <div className="flex gap-4">
                        <span>Type: {notification.type}</span>
                        <span>Recipients: {notification.recipients}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span>{notification.timestamp}</span>
                        <Button variant="ghost" size="sm" className="h-6 w-6 p-0"><Eye className="w-3 h-3" /></Button>
                        <Button variant="ghost" size="sm" className="h-6 w-6 p-0 text-red-500"><Trash2 className="w-3 h-3" /></Button>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Templates Tab */}
        <TabsContent value="templates" className="space-y-4">
          <Card className="border-[#F4F6F0]">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-[#485550]">
                <MessageSquare className="h-5 w-5" /> Notification Templates
              </CardTitle>
              <CardDescription>Pre-built templates for common notifications</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {templates.map(template => (
                  <Card key={template.id} className="border-[#F4F6F0] hover:shadow-md hover:border-[#C0EB6A] transition-all cursor-pointer">
                    <CardHeader className="pb-2">
                      <CardTitle className="text-base text-[#485550]">{template.name}</CardTitle>
                      <CardDescription>{template.category}</CardDescription>
                    </CardHeader>
                    <CardContent>
                      <div className="flex justify-between items-center">
                        <span className="text-sm text-[#485550]/60">Used {template.usage} times</span>
                        <Button size="sm" variant="outline" className="border-[#485550] text-[#485550]">Use Template</Button>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
