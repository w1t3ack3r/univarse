'use client';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { User, Bell, Lock, Shield } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

export default function DeanSettings() {
    const [loading, setLoading] = useState(false);

    const handleSave = async () => {
        setLoading(true);
        await new Promise(resolve => setTimeout(resolve, 1000));
        setLoading(false);
        toast.success('Settings saved successfully');
    };

    return (
        <div className="space-y-6 max-w-4xl">
            <div>
                <h1 className="text-3xl font-bold text-[#485550]">Account Settings</h1>
                <p className="text-[#485550]/70 mt-1">
                    Manage your personal profile and preferences
                </p>
            </div>

            {/* Profile Section */}
            <Card className="border-[#F4F6F0]">
                <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-[#485550]">
                        <User className="h-5 w-5" /> Profile Information
                    </CardTitle>
                    <CardDescription>Update your personal details</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div className="space-y-2">
                            <Label>Title</Label>
                            <Input defaultValue="Prof." className="border-[#485550]/20" />
                        </div>
                        <div className="space-y-2">
                            <Label>Full Name</Label>
                            <Input defaultValue="Emmanuel Okronkwo" className="border-[#485550]/20" />
                        </div>
                        <div className="space-y-2">
                            <Label>Official Email</Label>
                            <Input defaultValue="dean.science@uni.edu.ng" disabled className="bg-[#F4F6F0] border-[#485550]/20" />
                        </div>
                        <div className="space-y-2">
                            <Label>Phone Number</Label>
                            <Input defaultValue="+234 803 555 1234" className="border-[#485550]/20" />
                        </div>
                    </div>
                </CardContent>
            </Card>

            {/* Security Section */}
            <Card className="border-[#F4F6F0]">
                <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-[#485550]">
                        <Lock className="h-5 w-5" /> Security
                    </CardTitle>
                    <CardDescription>Manage your password and authentication</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                    <div className="space-y-2">
                        <Label>Current Password</Label>
                        <Input type="password" placeholder="••••••••" className="border-[#485550]/20 max-w-md" />
                    </div>
                    <div className="space-y-2">
                        <Label>New Password</Label>
                        <Input type="password" placeholder="••••••••" className="border-[#485550]/20 max-w-md" />
                    </div>
                    <div className="space-y-2">
                        <Label>Confirm New Password</Label>
                        <Input type="password" placeholder="••••••••" className="border-[#485550]/20 max-w-md" />
                    </div>
                    <Button variant="outline" className="mt-2 text-amber-600 border-amber-200 hover:bg-amber-50">
                        Change Password
                    </Button>
                </CardContent>
            </Card>

            {/* Preferences */}
            <Card className="border-[#F4F6F0]">
                <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-[#485550]">
                        <Bell className="h-5 w-5" /> Notifications
                    </CardTitle>
                    <CardDescription>Choose what you get notified about</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                    <div className="flex items-center justify-between">
                        <div className="space-y-0.5">
                            <Label className="text-base">Result Submissions</Label>
                            <p className="text-sm text-[#485550]/60">
                                Get notified when HODs submit results for approval
                            </p>
                        </div>
                        <Switch defaultChecked />
                    </div>
                    <div className="border-t border-[#F4F6F0] my-2" />
                    <div className="flex items-center justify-between">
                        <div className="space-y-0.5">
                            <Label className="text-base">Senate Updates</Label>
                            <p className="text-sm text-[#485550]/60">
                                Receive updates on Senate List ratification status
                            </p>
                        </div>
                        <Switch defaultChecked />
                    </div>
                    <div className="border-t border-[#F4F6F0] my-2" />
                    <div className="flex items-center justify-between">
                        <div className="space-y-0.5">
                            <Label className="text-base">Email Digest</Label>
                            <p className="text-sm text-[#485550]/60">
                                Weekly summary of faculty performance and pending tasks
                            </p>
                        </div>
                        <Switch />
                    </div>
                </CardContent>
            </Card>

            <div className="flex justify-end pb-8">
                <Button
                    size="lg"
                    className="bg-[#485550] hover:bg-[#3a4543] min-w-[150px]"
                    onClick={handleSave}
                    disabled={loading}
                >
                    {loading ? 'Saving...' : 'Save Changes'}
                </Button>
            </div>
        </div>
    );
}
