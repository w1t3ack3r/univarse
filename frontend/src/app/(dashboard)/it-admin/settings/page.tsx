'use client';

import { useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import {
  Settings as SettingsIcon,
  Shield,
  Bell,
  Database,
  Users,
  Plus,
  Edit,
  Trash2,
  Save,
  Loader2,
  RefreshCw,
  Download
} from 'lucide-react';
import { toast } from 'sonner';

interface ITAdmin {
  id: string;
  name: string;
  email: string;
  role: string;
  status: 'Active' | 'Inactive';
  lastLogin: string;
  permissions: string[];
}

const mockAdmins: ITAdmin[] = [
  { id: '1', name: 'John Smith', email: 'john.smith@university.edu', role: 'Senior IT Admin', status: 'Active', lastLogin: '2024-01-15 10:30 AM', permissions: ['Full Access'] },
  { id: '2', name: 'Sarah Johnson', email: 'sarah.johnson@university.edu', role: 'IT Admin', status: 'Active', lastLogin: '2024-01-15 09:15 AM', permissions: ['User Management', 'Academic Structure'] },
  { id: '3', name: 'Michael Brown', email: 'michael.brown@university.edu', role: 'IT Admin', status: 'Active', lastLogin: '2024-01-14 04:45 PM', permissions: ['Course Management', 'Notifications'] },
];

export default function SettingsPage() {
  const [saving, setSaving] = useState(false);
  const [admins] = useState<ITAdmin[]>(mockAdmins);
  const [notifications, setNotifications] = useState({
    emailAlerts: true,
    systemUpdates: true,
    securityAlerts: true,
    maintenanceNotices: false
  });

  const handleSave = async () => {
    setSaving(true);
    await new Promise(r => setTimeout(r, 1000));
    toast.success('Settings saved successfully!');
    setSaving(false);
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-3xl font-bold text-[#485550]">Settings</h1>
        <p className="text-[#485550]/60 mt-1">Manage system settings and IT administrator accounts</p>
      </div>

      {/* Tabs */}
      <Tabs defaultValue="general" className="space-y-4">
        <TabsList className="grid w-full grid-cols-2 sm:grid-cols-5 bg-[#485550]">
          <TabsTrigger value="general" className="text-white data-[state=active]:bg-[#C0EB6A] data-[state=active]:text-[#485550]">General</TabsTrigger>
          <TabsTrigger value="admins" className="text-white data-[state=active]:bg-[#C0EB6A] data-[state=active]:text-[#485550]">IT Admins</TabsTrigger>
          <TabsTrigger value="security" className="text-white data-[state=active]:bg-[#C0EB6A] data-[state=active]:text-[#485550]">Security</TabsTrigger>
          <TabsTrigger value="notifications" className="text-white data-[state=active]:bg-[#C0EB6A] data-[state=active]:text-[#485550]">Notifications</TabsTrigger>
          <TabsTrigger value="system" className="text-white data-[state=active]:bg-[#C0EB6A] data-[state=active]:text-[#485550]">System</TabsTrigger>
        </TabsList>

        {/* General Tab */}
        <TabsContent value="general" className="space-y-4">
          <Card className="border-[#F4F6F0]">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-[#485550]">
                <SettingsIcon className="h-5 w-5" /> General Settings
              </CardTitle>
              <CardDescription>Configure basic system settings</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="space-y-4">
                  <div className="space-y-2">
                    <Label className="text-[#485550]">Institution Name</Label>
                    <Input defaultValue="University of Technology" className="border-[#485550]/20" />
                  </div>
                  <div className="space-y-2">
                    <Label className="text-[#485550]">Timezone</Label>
                    <Select defaultValue="utc+1">
                      <SelectTrigger className="border-[#485550]/20"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="utc+0">UTC+0 (GMT)</SelectItem>
                        <SelectItem value="utc+1">UTC+1 (WAT)</SelectItem>
                        <SelectItem value="utc+2">UTC+2 (CAT)</SelectItem>
                        <SelectItem value="utc-5">UTC-5 (EST)</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label className="text-[#485550]">Default Language</Label>
                    <Select defaultValue="english">
                      <SelectTrigger className="border-[#485550]/20"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="english">English</SelectItem>
                        <SelectItem value="french">French</SelectItem>
                        <SelectItem value="spanish">Spanish</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="space-y-4">
                  <div className="space-y-2">
                    <Label className="text-[#485550]">Date Format</Label>
                    <Select defaultValue="dmy">
                      <SelectTrigger className="border-[#485550]/20"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="mdy">MM/DD/YYYY</SelectItem>
                        <SelectItem value="dmy">DD/MM/YYYY</SelectItem>
                        <SelectItem value="ymd">YYYY-MM-DD</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label className="text-[#485550]">Session Timeout</Label>
                    <Select defaultValue="30">
                      <SelectTrigger className="border-[#485550]/20"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="15">15 minutes</SelectItem>
                        <SelectItem value="30">30 minutes</SelectItem>
                        <SelectItem value="60">1 hour</SelectItem>
                        <SelectItem value="120">2 hours</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label className="text-[#485550]">Max File Upload Size</Label>
                    <Select defaultValue="50">
                      <SelectTrigger className="border-[#485550]/20"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="10">10 MB</SelectItem>
                        <SelectItem value="25">25 MB</SelectItem>
                        <SelectItem value="50">50 MB</SelectItem>
                        <SelectItem value="100">100 MB</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </div>
              <div className="space-y-2">
                <Label className="text-[#485550]">Institution Description</Label>
                <Textarea placeholder="Brief description of your institution..." className="min-h-[100px] border-[#485550]/20" />
              </div>
              <Button onClick={handleSave} disabled={saving} className="bg-[#485550] hover:bg-[#6b7c6f]">
                {saving ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Save className="h-4 w-4 mr-2" />}
                Save Changes
              </Button>
            </CardContent>
          </Card>
        </TabsContent>

        {/* IT Admins Tab */}
        <TabsContent value="admins" className="space-y-4">
          <Card className="border-[#F4F6F0]">
            <CardHeader>
              <div className="flex flex-col sm:flex-row justify-between sm:items-center gap-4">
                <div>
                  <CardTitle className="flex items-center gap-2 text-[#485550]">
                    <Users className="h-5 w-5" /> IT Administrator Accounts
                  </CardTitle>
                  <CardDescription>Manage IT administrator access and permissions</CardDescription>
                </div>
                <Dialog>
                  <DialogTrigger asChild>
                    <Button className="bg-[#485550] hover:bg-[#6b7c6f]">
                      <Plus className="h-4 w-4 mr-2" /> Add Admin
                    </Button>
                  </DialogTrigger>
                  <DialogContent>
                    <DialogHeader>
                      <DialogTitle className="text-[#485550]">Add New IT Administrator</DialogTitle>
                      <DialogDescription>Create a new IT administrator account</DialogDescription>
                    </DialogHeader>
                    <div className="space-y-4 pt-4">
                      <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-2">
                          <Label className="text-[#485550]">First Name</Label>
                          <Input placeholder="Enter first name" className="border-[#485550]/20" />
                        </div>
                        <div className="space-y-2">
                          <Label className="text-[#485550]">Last Name</Label>
                          <Input placeholder="Enter last name" className="border-[#485550]/20" />
                        </div>
                      </div>
                      <div className="space-y-2">
                        <Label className="text-[#485550]">Email Address</Label>
                        <Input type="email" placeholder="Enter email address" className="border-[#485550]/20" />
                      </div>
                      <div className="space-y-2">
                        <Label className="text-[#485550]">Role</Label>
                        <Select>
                          <SelectTrigger className="border-[#485550]/20"><SelectValue placeholder="Select role" /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="senior">Senior IT Admin</SelectItem>
                            <SelectItem value="admin">IT Admin</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <Button className="w-full bg-[#485550] hover:bg-[#6b7c6f]">
                        <Plus className="h-4 w-4 mr-2" /> Create Administrator
                      </Button>
                    </div>
                  </DialogContent>
                </Dialog>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {admins.map(admin => (
                <div key={admin.id} className="p-4 border border-[#F4F6F0] rounded-lg hover:bg-[#F4F6F0]/50 transition-colors">
                  <div className="flex flex-col sm:flex-row justify-between sm:items-start gap-4 mb-3">
                    <div>
                      <h4 className="font-semibold text-[#485550]">{admin.name}</h4>
                      <p className="text-sm text-[#485550]/70">{admin.email}</p>
                      <p className="text-sm text-[#485550]/60">{admin.role}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge className={admin.status === 'Active' ? 'bg-[#C0EB6A]/20 text-[#485550] border-[#C0EB6A]' : 'bg-gray-100 text-gray-600'}>
                        {admin.status}
                      </Badge>
                      <Button variant="ghost" size="sm"><Edit className="h-4 w-4 text-[#485550]" /></Button>
                      <Button variant="ghost" size="sm" className="text-red-500"><Trash2 className="h-4 w-4" /></Button>
                    </div>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
                    <div>
                      <span className="text-[#485550]/60">Last Login:</span>
                      <span className="ml-2 text-[#485550]">{admin.lastLogin}</span>
                    </div>
                    <div>
                      <span className="text-[#485550]/60">Permissions:</span>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {admin.permissions.map((perm, i) => (
                          <Badge key={i} variant="outline" className="text-xs border-[#485550]/30">{perm}</Badge>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Security Tab */}
        <TabsContent value="security" className="space-y-4">
          <Card className="border-[#F4F6F0]">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-[#485550]">
                <Shield className="h-5 w-5" /> Security Settings
              </CardTitle>
              <CardDescription>Configure security and authentication settings</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="flex items-center justify-between p-4 border border-[#F4F6F0] rounded-lg">
                <div>
                  <Label className="text-[#485550]">Two-Factor Authentication</Label>
                  <p className="text-sm text-[#485550]/60">Require 2FA for all admin accounts</p>
                </div>
                <Switch defaultChecked />
              </div>
              <div className="flex items-center justify-between p-4 border border-[#F4F6F0] rounded-lg">
                <div>
                  <Label className="text-[#485550]">Password Expiry</Label>
                  <p className="text-sm text-[#485550]/60">Force password change every 90 days</p>
                </div>
                <Switch defaultChecked />
              </div>
              <div className="flex items-center justify-between p-4 border border-[#F4F6F0] rounded-lg">
                <div>
                  <Label className="text-[#485550]">Login Attempt Limits</Label>
                  <p className="text-sm text-[#485550]/60">Lock account after 5 failed attempts</p>
                </div>
                <Switch defaultChecked />
              </div>
              <div className="space-y-2">
                <Label className="text-[#485550]">Minimum Password Length</Label>
                <Select defaultValue="8">
                  <SelectTrigger className="border-[#485550]/20"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="6">6 characters</SelectItem>
                    <SelectItem value="8">8 characters</SelectItem>
                    <SelectItem value="10">10 characters</SelectItem>
                    <SelectItem value="12">12 characters</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <Button onClick={handleSave} disabled={saving} className="bg-[#485550] hover:bg-[#6b7c6f]">
                {saving ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Save className="h-4 w-4 mr-2" />}
                Save Security Settings
              </Button>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Notifications Tab */}
        <TabsContent value="notifications" className="space-y-4">
          <Card className="border-[#F4F6F0]">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-[#485550]">
                <Bell className="h-5 w-5" /> Notification Preferences
              </CardTitle>
              <CardDescription>Configure how you receive system notifications</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="flex items-center justify-between p-4 border border-[#F4F6F0] rounded-lg">
                <div>
                  <Label className="text-[#485550]">Email Alerts</Label>
                  <p className="text-sm text-[#485550]/60">Receive important alerts via email</p>
                </div>
                <Switch checked={notifications.emailAlerts} onCheckedChange={(c) => setNotifications(p => ({ ...p, emailAlerts: c }))} />
              </div>
              <div className="flex items-center justify-between p-4 border border-[#F4F6F0] rounded-lg">
                <div>
                  <Label className="text-[#485550]">System Updates</Label>
                  <p className="text-sm text-[#485550]/60">Notifications about system updates and maintenance</p>
                </div>
                <Switch checked={notifications.systemUpdates} onCheckedChange={(c) => setNotifications(p => ({ ...p, systemUpdates: c }))} />
              </div>
              <div className="flex items-center justify-between p-4 border border-[#F4F6F0] rounded-lg">
                <div>
                  <Label className="text-[#485550]">Security Alerts</Label>
                  <p className="text-sm text-[#485550]/60">Critical security notifications</p>
                </div>
                <Switch checked={notifications.securityAlerts} onCheckedChange={(c) => setNotifications(p => ({ ...p, securityAlerts: c }))} />
              </div>
              <div className="flex items-center justify-between p-4 border border-[#F4F6F0] rounded-lg">
                <div>
                  <Label className="text-[#485550]">Maintenance Notices</Label>
                  <p className="text-sm text-[#485550]/60">Scheduled maintenance notifications</p>
                </div>
                <Switch checked={notifications.maintenanceNotices} onCheckedChange={(c) => setNotifications(p => ({ ...p, maintenanceNotices: c }))} />
              </div>
              <Button onClick={handleSave} disabled={saving} className="bg-[#485550] hover:bg-[#6b7c6f]">
                {saving ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Save className="h-4 w-4 mr-2" />}
                Save Preferences
              </Button>
            </CardContent>
          </Card>
        </TabsContent>

        {/* System Tab */}
        <TabsContent value="system" className="space-y-4">
          <Card className="border-[#F4F6F0]">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-[#485550]">
                <Database className="h-5 w-5" /> System Configuration
              </CardTitle>
              <CardDescription>Advanced system settings and maintenance</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="space-y-4">
                  <div className="p-4 border border-[#F4F6F0] rounded-lg space-y-3">
                    <div>
                      <Label className="text-[#485550]">Database Backup</Label>
                      <p className="text-sm text-[#485550]/60">Last backup: 2 hours ago</p>
                    </div>
                    <Button variant="outline" className="w-full border-[#485550] text-[#485550]">
                      <Database className="h-4 w-4 mr-2" /> Run Backup Now
                    </Button>
                  </div>
                  <div className="p-4 border border-[#F4F6F0] rounded-lg space-y-3">
                    <div>
                      <Label className="text-[#485550]">System Maintenance</Label>
                      <p className="text-sm text-[#485550]/60">Schedule maintenance window</p>
                    </div>
                    <Button variant="outline" className="w-full border-[#485550] text-[#485550]">
                      Schedule Maintenance
                    </Button>
                  </div>
                </div>
                <div className="space-y-4">
                  <div className="p-4 border border-[#F4F6F0] rounded-lg space-y-3">
                    <div>
                      <Label className="text-[#485550]">Cache Management</Label>
                      <p className="text-sm text-[#485550]/60">Clear system cache to improve performance</p>
                    </div>
                    <Button variant="outline" className="w-full border-[#485550] text-[#485550]">
                      <RefreshCw className="h-4 w-4 mr-2" /> Clear Cache
                    </Button>
                  </div>
                  <div className="p-4 border border-[#F4F6F0] rounded-lg space-y-3">
                    <div>
                      <Label className="text-[#485550]">Export Data</Label>
                      <p className="text-sm text-[#485550]/60">Export system data for backup</p>
                    </div>
                    <Button variant="outline" className="w-full border-[#485550] text-[#485550]">
                      <Download className="h-4 w-4 mr-2" /> Export System Data
                    </Button>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
