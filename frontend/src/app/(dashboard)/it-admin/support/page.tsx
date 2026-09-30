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
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import {
  HelpCircle,
  Plus,
  MessageSquare,
  Clock,
  CheckCircle,
  AlertCircle,
  Search,
  Eye,
  Edit,
  Loader2,
  Send,
  Phone,
  Mail
} from 'lucide-react';
import { toast } from 'sonner';

interface SupportTicket {
  id: string;
  title: string;
  description: string;
  priority: 'Low' | 'Medium' | 'High' | 'Urgent';
  status: 'Open' | 'In Progress' | 'Resolved';
  category: string;
  assignedTo: string;
  createdDate: string;
  lastUpdate: string;
}

interface KBArticle {
  id: number;
  title: string;
  category: string;
  views: number;
  lastUpdated: string;
}

// Mock data
const mockTickets: SupportTicket[] = [
  { id: 'TKT-1001', title: 'Unable to bulk upload student records', description: 'CSV import fails with large files over 1000 rows', priority: 'High', status: 'Open', category: 'Technical Issue', assignedTo: 'Support Team', createdDate: '2024-01-14', lastUpdate: '2024-01-14' },
  { id: 'TKT-1002', title: 'Course registration page slow loading', description: 'Takes over 30 seconds to load the course selection page during peak hours', priority: 'Medium', status: 'In Progress', category: 'Performance', assignedTo: 'Support Team', createdDate: '2024-01-12', lastUpdate: '2024-01-13' },
  { id: 'TKT-1003', title: 'Request: Add batch notification feature', description: 'Would be helpful to send notifications to specific level students', priority: 'Low', status: 'Resolved', category: 'Feature Request', assignedTo: 'Product Team', createdDate: '2024-01-10', lastUpdate: '2024-01-11' },
];

const mockKnowledgeBase: KBArticle[] = [
  { id: 1, title: 'How to Reset User Passwords', category: 'User Management', views: 245, lastUpdated: '2024-01-10' },
  { id: 2, title: 'Setting Up Course Notifications', category: 'Notifications', views: 189, lastUpdated: '2024-01-08' },
  { id: 3, title: 'Database Backup Procedures', category: 'System Administration', views: 156, lastUpdated: '2024-01-05' },
  { id: 4, title: 'Troubleshooting Login Issues', category: 'Authentication', views: 298, lastUpdated: '2024-01-03' },
];

export default function SupportCenter() {
  const [isLoading, setIsLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [tickets, setTickets] = useState<SupportTicket[]>([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [priorityFilter, setPriorityFilter] = useState('all');
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [newTicket, setNewTicket] = useState({ title: '', description: '', category: 'technical', priority: 'medium', environment: '' });

  useEffect(() => {
    setTimeout(() => {
      setTickets(mockTickets);
      setIsLoading(false);
    }, 500);
  }, []);

  const filteredTickets = tickets.filter(t => {
    const matchesSearch = t.title.toLowerCase().includes(searchTerm.toLowerCase()) || t.description.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesPriority = priorityFilter === 'all' || t.priority === priorityFilter;
    return matchesSearch && matchesPriority;
  });

  const handleCreateTicket = async () => {
    if (!newTicket.title || !newTicket.description) {
      toast.error('Please fill required fields');
      return;
    }
    setSubmitting(true);
    try {
      await new Promise(r => setTimeout(r, 1000));
      toast.success('Support ticket created successfully!');
      setIsCreateOpen(false);
      setNewTicket({ title: '', description: '', category: 'technical', priority: 'medium', environment: '' });
    } catch (error: any) {
      toast.error(error.message || 'Failed to create ticket');
    } finally {
      setSubmitting(false);
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'Open': return <Badge className="bg-red-50 text-red-600 border-red-200">Open</Badge>;
      case 'In Progress': return <Badge className="bg-amber-50 text-amber-600 border-amber-200">In Progress</Badge>;
      case 'Resolved': return <Badge className="bg-[#C0EB6A]/20 text-[#485550] border-[#C0EB6A]">Resolved</Badge>;
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
      <div className="flex flex-col sm:flex-row justify-between sm:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold text-[#485550]">Support Center</h1>
          <p className="text-[#485550]/60 mt-1">Manage support tickets and access knowledge base</p>
        </div>
        <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
          <DialogTrigger asChild>
            <Button className="bg-[#485550] hover:bg-[#6b7c6f]">
              <Plus className="h-4 w-4 mr-2" /> Create Ticket
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle className="text-[#485550]">Create Support Ticket</DialogTitle>
              <DialogDescription>Submit a new support request</DialogDescription>
            </DialogHeader>
            <div className="space-y-4 pt-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label className="text-[#485550]">Priority</Label>
                  <Select value={newTicket.priority} onValueChange={(v) => setNewTicket({ ...newTicket, priority: v })}>
                    <SelectTrigger className="border-[#485550]/20"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="low">Low</SelectItem>
                      <SelectItem value="medium">Medium</SelectItem>
                      <SelectItem value="high">High</SelectItem>
                      <SelectItem value="urgent">Urgent</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label className="text-[#485550]">Category</Label>
                  <Select value={newTicket.category} onValueChange={(v) => setNewTicket({ ...newTicket, category: v })}>
                    <SelectTrigger className="border-[#485550]/20"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="technical">Technical Issue</SelectItem>
                      <SelectItem value="account">Account Management</SelectItem>
                      <SelectItem value="feature">Feature Request</SelectItem>
                      <SelectItem value="bug">Bug Report</SelectItem>
                      <SelectItem value="performance">Performance</SelectItem>
                      <SelectItem value="other">Other</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="space-y-2">
                <Label className="text-[#485550]">Title <span className="text-red-500">*</span></Label>
                <Input placeholder="Brief description of the issue" value={newTicket.title} onChange={(e) => setNewTicket({ ...newTicket, title: e.target.value })} className="border-[#485550]/20" />
              </div>
              <div className="space-y-2">
                <Label className="text-[#485550]">Description <span className="text-red-500">*</span></Label>
                <Textarea placeholder="Provide detailed information about the issue" value={newTicket.description} onChange={(e) => setNewTicket({ ...newTicket, description: e.target.value })} className="min-h-[120px] border-[#485550]/20" />
              </div>
              <div className="space-y-2">
                <Label className="text-[#485550]">Environment Details</Label>
                <Textarea placeholder="Browser, OS, device type, etc." value={newTicket.environment} onChange={(e) => setNewTicket({ ...newTicket, environment: e.target.value })} className="min-h-[80px] border-[#485550]/20" />
              </div>
              <div className="flex gap-3 pt-4">
                <Button onClick={handleCreateTicket} disabled={submitting} className="flex-1 bg-[#485550] hover:bg-[#6b7c6f]">
                  {submitting ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Send className="h-4 w-4 mr-2" />}
                  {submitting ? 'Submitting...' : 'Submit Ticket'}
                </Button>
                <Button variant="outline" className="border-[#485550]">Save as Draft</Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card className="border-[#F4F6F0]">
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-[#F4F6F0] flex items-center justify-center">
                <MessageSquare className="w-5 h-5 text-[#485550]" />
              </div>
              <div>
                <p className="text-2xl font-bold text-[#485550]">47</p>
                <p className="text-sm text-[#485550]/60">Total Tickets</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card className="border-[#F4F6F0]">
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-red-50 flex items-center justify-center">
                <AlertCircle className="w-5 h-5 text-red-500" />
              </div>
              <div>
                <p className="text-2xl font-bold text-[#485550]">12</p>
                <p className="text-sm text-[#485550]/60">Open Tickets</p>
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
                <p className="text-2xl font-bold text-[#485550]">4.2h</p>
                <p className="text-sm text-[#485550]/60">Avg Response</p>
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
                <p className="text-2xl font-bold text-[#485550]">94%</p>
                <p className="text-sm text-[#485550]/60">Resolution Rate</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Tabs */}
      <Tabs defaultValue="tickets" className="space-y-4">
        <TabsList className="bg-[#485550]">
          <TabsTrigger value="tickets" className="text-white data-[state=active]:bg-[#C0EB6A] data-[state=active]:text-[#485550]">My Tickets</TabsTrigger>
          <TabsTrigger value="knowledge" className="text-white data-[state=active]:bg-[#C0EB6A] data-[state=active]:text-[#485550]">Knowledge Base</TabsTrigger>
          <TabsTrigger value="contact" className="text-white data-[state=active]:bg-[#C0EB6A] data-[state=active]:text-[#485550]">Contact Support</TabsTrigger>
        </TabsList>

        {/* Tickets Tab */}
        <TabsContent value="tickets" className="space-y-4">
          <Card className="border-[#F4F6F0]">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-[#485550]">
                <MessageSquare className="h-5 w-5" /> Support Tickets
              </CardTitle>
              <CardDescription>Track and manage your support requests</CardDescription>
            </CardHeader>
            <CardContent>
              {/* Search & Filter */}
              <div className="flex flex-col sm:flex-row gap-4 mb-6">
                <div className="flex-1 relative">
                  <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-[#485550]/40" />
                  <Input placeholder="Search tickets..." value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} className="pl-10 border-[#485550]/20" />
                </div>
                <Select value={priorityFilter} onValueChange={setPriorityFilter}>
                  <SelectTrigger className="w-full sm:w-48 border-[#485550]/20"><SelectValue placeholder="Filter by priority" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Priorities</SelectItem>
                    <SelectItem value="High">High</SelectItem>
                    <SelectItem value="Medium">Medium</SelectItem>
                    <SelectItem value="Low">Low</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {/* Tickets List */}
              <div className="space-y-4">
                {filteredTickets.length === 0 ? (
                  <div className="p-8 text-center">
                    <MessageSquare className="w-12 h-12 text-[#485550]/30 mx-auto mb-4" />
                    <h3 className="text-lg font-medium text-[#485550] mb-2">No tickets found</h3>
                    <p className="text-[#485550]/60">Create a new ticket to get support.</p>
                  </div>
                ) : (
                  filteredTickets.map(ticket => (
                    <div key={ticket.id} className="p-4 border border-[#F4F6F0] rounded-lg hover:bg-[#F4F6F0]/50 transition-colors">
                      <div className="flex flex-col sm:flex-row justify-between sm:items-start gap-2 mb-2">
                        <div className="flex items-center gap-2 flex-wrap">
                          <h4 className="font-semibold text-[#485550]">{ticket.title}</h4>
                          <Badge variant="outline" className="border-[#485550]/30 text-xs">{ticket.id}</Badge>
                        </div>
                        <div className="flex items-center gap-2">
                          {getStatusBadge(ticket.status)}
                          {getPriorityBadge(ticket.priority)}
                        </div>
                      </div>
                      <p className="text-sm text-[#485550]/70 mb-3">{ticket.description}</p>
                      <div className="flex flex-wrap justify-between items-center text-xs text-[#485550]/60 gap-2">
                        <div className="flex flex-wrap gap-4">
                          <span>Category: {ticket.category}</span>
                          <span>Assigned: {ticket.assignedTo}</span>
                          <span>Created: {ticket.createdDate}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span>Updated: {ticket.lastUpdate}</span>
                          <Button variant="ghost" size="sm" className="h-6 w-6 p-0"><Eye className="w-3 h-3" /></Button>
                          <Button variant="ghost" size="sm" className="h-6 w-6 p-0"><Edit className="w-3 h-3" /></Button>
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Knowledge Base Tab */}
        <TabsContent value="knowledge" className="space-y-4">
          <Card className="border-[#F4F6F0]">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-[#485550]">
                <HelpCircle className="h-5 w-5" /> Knowledge Base
              </CardTitle>
              <CardDescription>Find answers to common questions and issues</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="relative mb-6">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-[#485550]/40" />
                <Input placeholder="Search knowledge base..." className="pl-10 border-[#485550]/20" />
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {mockKnowledgeBase.map(article => (
                  <Card key={article.id} className="border-[#F4F6F0] hover:shadow-md hover:border-[#C0EB6A] transition-all cursor-pointer">
                    <CardHeader className="pb-2">
                      <CardTitle className="text-base text-[#485550]">{article.title}</CardTitle>
                      <CardDescription>{article.category}</CardDescription>
                    </CardHeader>
                    <CardContent>
                      <div className="flex justify-between items-center text-sm text-[#485550]/60">
                        <span>{article.views} views</span>
                        <span>Updated {article.lastUpdated}</span>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
              <div className="mt-6 text-center">
                <Button variant="outline" className="border-[#485550] text-[#485550]">View All Articles</Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Contact Tab */}
        <TabsContent value="contact" className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <Card className="border-[#F4F6F0]">
              <CardHeader>
                <CardTitle className="text-[#485550]">Contact UniVarse Support</CardTitle>
                <CardDescription>Get direct help from our support team</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-3">
                  <div className="flex justify-between items-center p-3 bg-[#F4F6F0]/50 rounded-lg">
                    <span className="font-medium text-[#485550] flex items-center gap-2"><Mail className="w-4 h-4" /> Email Support</span>
                    <span className="text-[#485550]">support@univarse.edu</span>
                  </div>
                  <div className="flex justify-between items-center p-3 bg-[#F4F6F0]/50 rounded-lg">
                    <span className="font-medium text-[#485550] flex items-center gap-2"><Phone className="w-4 h-4" /> Phone Support</span>
                    <span className="text-[#485550]">+234 (0) 800-UNIVARSE</span>
                  </div>
                  <div className="flex justify-between items-center p-3 bg-[#F4F6F0]/50 rounded-lg">
                    <span className="font-medium text-[#485550]">Live Chat</span>
                    <Badge className="bg-[#C0EB6A]/20 text-[#485550] border-[#C0EB6A]">Available 24/7</Badge>
                  </div>
                  <div className="flex justify-between items-center p-3 bg-[#F4F6F0]/50 rounded-lg">
                    <span className="font-medium text-[#485550]">Response Time</span>
                    <span className="text-[#485550]">Within 4 hours</span>
                  </div>
                </div>
                <Button className="w-full bg-[#485550] hover:bg-[#6b7c6f]">
                  <MessageSquare className="h-4 w-4 mr-2" /> Start Live Chat
                </Button>
              </CardContent>
            </Card>

            <Card className="border-red-200">
              <CardHeader>
                <CardTitle className="text-[#485550]">Emergency Contact</CardTitle>
                <CardDescription>For critical system issues</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="p-4 bg-red-50 border border-red-200 rounded-lg">
                  <div className="flex items-center gap-2 mb-2">
                    <AlertCircle className="h-5 w-5 text-red-600" />
                    <span className="font-medium text-red-900">Critical Issues Only</span>
                  </div>
                  <p className="text-sm text-red-800 mb-4">Use this contact method only for system-wide outages or security incidents.</p>
                  <div className="space-y-2">
                    <div className="flex justify-between">
                      <span className="font-medium text-red-900">Emergency Hotline:</span>
                      <span className="text-red-600 font-bold">+234 911-HELP</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="font-medium text-red-900">Emergency Email:</span>
                      <span className="text-red-600">emergency@univarse.edu</span>
                    </div>
                  </div>
                </div>
                <Button variant="destructive" className="w-full">
                  <AlertCircle className="h-4 w-4 mr-2" /> Report Critical Issue
                </Button>
              </CardContent>
            </Card>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
