'use client';

import { useState, useRef } from 'react';
import Link from 'next/link';
import { CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import {
    User,
    Mail,
    Lock,
    Camera,
    Save,
    Loader2,
    Shield,
    Bell,
    LogOut,
    Check,
    Smartphone,
    Image as ImageIcon,
    Upload
} from 'lucide-react';
import { toast } from 'sonner';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    DialogFooter,
} from '@/components/ui/dialog';

export default function ProfileSettingsPage() {
    const [isLoading, setIsLoading] = useState(false);
    const [user, setUser] = useState({
        name: 'Super Admin',
        email: 'admin@univarse.com',
        bio: 'Managing the universe, one tenant at a time.',
        role: 'SUPER_ADMIN',
        avatar: 'https://github.com/shadcn.png'
    });

    const [passwordData, setPasswordData] = useState({
        current: '',
        new: '',
        confirm: ''
    });

    const handleUpdateProfile = async () => {
        setIsLoading(true);
        // MOCK UPDATE
        setTimeout(() => {
            setIsLoading(false);
            toast.success('Profile updated successfully');
        }, 1000);
    };

    const handleChangePassword = async () => {
        if (passwordData.new !== passwordData.confirm) {
            toast.error('New passwords do not match');
            return;
        }
        setIsLoading(true);
        // MOCK PASSWORD CHANGE
        setTimeout(() => {
            setIsLoading(false);
            toast.success('Password changed successfully');
            setPasswordData({ current: '', new: '', confirm: '' });
        }, 1200);
    };

    // Upload Modal State
    const [showUploadDialog, setShowUploadDialog] = useState(false);
    const [selectedImage, setSelectedImage] = useState<string | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);

    const handleAvatarClick = () => {
        setShowUploadDialog(true);
        setSelectedImage(null);
    };

    const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onloadend = () => {
            setSelectedImage(reader.result as string);
        };
        reader.readAsDataURL(file);
    };

    const handleSaveAvatar = () => {
        if (!selectedImage) return;

        setIsLoading(true);
        // Mock Upload
        setTimeout(() => {
            setUser(prev => ({ ...prev, avatar: selectedImage }));
            setIsLoading(false);
            setShowUploadDialog(false);
            toast.success('Avatar updated successfully');
        }, 1500);
    };

    return (
        <div className="space-y-8 max-w-5xl mx-auto">
            {/* Header */}
            <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
                <div>
                    <h2 className="text-2xl font-bold text-[#485550] flex items-center gap-3">
                        <User className="w-6 h-6 text-[#C0EB6A]" />
                        My Profile
                    </h2>
                    <p className="text-[#6B7C6F]">Manage your account settings and preferences</p>
                </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
                {/* Left Column - Avatar & Core Info */}
                <div className="md:col-span-1 space-y-6">
                    <div className="morph-card p-6 text-center">
                        <div className="relative inline-block mb-4 group cursor-pointer" onClick={handleAvatarClick}>
                            <Avatar className={`w-32 h-32 border-4 border-white shadow-lg mx-auto transition-opacity ${isLoading ? 'opacity-50' : 'opacity-100'}`}>
                                <AvatarImage src={user.avatar} className="object-cover" />
                                <AvatarFallback className="text-3xl bg-[#F4F6F0] text-[#485550]">SA</AvatarFallback>
                            </Avatar>

                            {/* Loading Overlay */}
                            {isLoading && (
                                <div className="absolute inset-0 flex items-center justify-center">
                                    <Loader2 className="w-8 h-8 text-[#485550] animate-spin" />
                                </div>
                            )}

                            <div className="absolute bottom-0 right-0 p-2 bg-[#485550] rounded-full text-white shadow-md hover:bg-[#3a4440] transition-colors border-2 border-white group-hover:scale-110">
                                <Camera className="w-4 h-4" />
                            </div>
                        </div>
                        <h3 className="text-xl font-bold text-[#485550]">{user.name}</h3>
                        <p className="text-[#6B7C6F] font-medium text-sm mb-4">{user.role}</p>

                        <div className="border-t border-[#F4F6F0] pt-4 mt-4 text-left space-y-3">
                            <div className="flex items-center gap-3 text-sm text-[#6B7C6F]">
                                <Mail className="w-4 h-4" />
                                {user.email}
                            </div>
                            <div className="flex items-center gap-3 text-sm text-[#6B7C6F]">
                                <Shield className="w-4 h-4" />
                                2FA Enabled
                            </div>
                        </div>
                    </div>
                </div>

                {/* Right Column - Forms */}
                <div className="md:col-span-2 space-y-6">
                    {/* General Settings */}
                    <div className="morph-card">
                        <CardHeader className="bg-[#F4F6F0]/50 border-b border-[#F4F6F0]">
                            <CardTitle className="text-lg text-[#485550]">General Information</CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-4 pt-6">
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                <div className="space-y-2">
                                    <Label>Display Name</Label>
                                    <Input
                                        value={user.name}
                                        onChange={e => setUser({ ...user, name: e.target.value })}
                                        className="input-morph bg-white"
                                    />
                                </div>
                                <div className="space-y-2">
                                    <Label>Email</Label>
                                    <Input
                                        value={user.email}
                                        disabled
                                        className="bg-[#F4F6F0] border-transparent text-[#6B7C6F] cursor-not-allowed"
                                    />
                                </div>
                            </div>
                            <div className="space-y-2">
                                <Label>Bio</Label>
                                <Textarea
                                    value={user.bio}
                                    onChange={e => setUser({ ...user, bio: e.target.value })}
                                    className="input-morph bg-white min-h-[100px] resize-none"
                                />
                            </div>
                            <div className="flex justify-end pt-2">
                                <Button onClick={handleUpdateProfile} className="btn-morph-primary" disabled={isLoading}>
                                    {isLoading ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Save className="w-4 h-4 mr-2" />}
                                    Save Changes
                                </Button>
                            </div>
                        </CardContent>
                    </div>

                    {/* Security Settings */}
                    <div className="morph-card">
                        <CardHeader className="bg-[#F4F6F0]/50 border-b border-[#F4F6F0]">
                            <CardTitle className="text-lg text-[#485550] flex items-center gap-2">
                                <Lock className="w-4 h-4" />
                                Security & Password
                            </CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-6 pt-6">
                            <div className="space-y-3">
                                <Label>Change Password</Label>
                                <Input
                                    type="password"
                                    placeholder="Current Password"
                                    className="input-morph bg-white"
                                    value={passwordData.current}
                                    onChange={e => setPasswordData({ ...passwordData, current: e.target.value })}
                                />
                                <div className="grid grid-cols-2 gap-4">
                                    <Input
                                        type="password"
                                        placeholder="New Password"
                                        className="input-morph bg-white"
                                        value={passwordData.new}
                                        onChange={e => setPasswordData({ ...passwordData, new: e.target.value })}
                                    />
                                    <Input
                                        type="password"
                                        placeholder="Confirm Password"
                                        className="input-morph bg-white"
                                        value={passwordData.confirm}
                                        onChange={e => setPasswordData({ ...passwordData, confirm: e.target.value })}
                                    />
                                </div>
                                <Button onClick={handleChangePassword} variant="outline" className="w-full border-dashed border-[#D1DBC1] hover:border-[#C0EB6A] hover:bg-[#F4F6F0] text-[#6B7C6F]" disabled={!passwordData.current || !passwordData.new}>
                                    Update Password
                                </Button>
                            </div>

                            <div className="border-t border-[#F4F6F0] pt-6 flex items-center justify-between">
                                <div>
                                    <h4 className="font-medium text-[#485550]">Advanced Security</h4>
                                    <p className="text-sm text-[#6B7C6F]">Manage 2FA, Active Sessions, and IP Restrictions</p>
                                </div>
                                <Link href="/super-admin/settings/security">
                                    <Button variant="outline" className="btn-morph bg-white">
                                        <Shield className="w-4 h-4 mr-2" />
                                        Manage Security
                                    </Button>
                                </Link>
                            </div>
                        </CardContent>
                    </div>

                    {/* Preferences */}
                    <div className="morph-card">
                        <CardHeader className="bg-[#F4F6F0]/50 border-b border-[#F4F6F0]">
                            <CardTitle className="text-lg text-[#485550] flex items-center gap-2">
                                <Bell className="w-4 h-4" />
                                Preferences
                            </CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-4 pt-6">
                            <div className="flex items-center justify-between">
                                <Label className="cursor-pointer" htmlFor="email-notifs">Email Notifications</Label>
                                <Switch id="email-notifs" defaultChecked />
                            </div>
                            <div className="flex items-center justify-between">
                                <Label className="cursor-pointer" htmlFor="marketing">Product Updates</Label>
                                <Switch id="marketing" />
                            </div>
                        </CardContent>
                    </div>
                </div>
            </div>

            {/* Avatar Upload Dialog */}
            <Dialog open={showUploadDialog} onOpenChange={setShowUploadDialog}>
                <DialogContent className="sm:max-w-3xl bg-[#F4F6F0] border-white shadow-2xl rounded-[2rem] p-0 overflow-hidden">
                    <div className="grid grid-cols-1 md:grid-cols-5 h-full">
                        {/* Left Side - Visual/Preview */}
                        <div className="md:col-span-2 bg-[#E8EDE0]/50 p-8 flex flex-col items-center justify-center border-b md:border-b-0 md:border-r border-[#D1DBC1]/50 relative">
                            <div className="relative w-40 h-40 md:w-56 md:h-56 rounded-full border-4 border-dashed border-[#D1DBC1] flex items-center justify-center overflow-hidden bg-white/50 group hover:border-[#C0EB6A] transition-colors shadow-inner">
                                {selectedImage ? (
                                    <img src={selectedImage} alt="Preview" className="w-full h-full object-cover" />
                                ) : (
                                    <div className="flex flex-col items-center text-[#6B7C6F] gap-2 p-4 text-center">
                                        <ImageIcon className="w-12 h-12 mb-2 opacity-50" />
                                        <span className="text-sm font-medium">Select Image</span>
                                    </div>
                                )}
                            </div>
                            {/* Decorative Elements */}
                            <div className="absolute top-4 left-4 text-[#D1DBC1]/40 transform -rotate-12">
                                <Camera className="w-12 h-12" />
                            </div>
                        </div>

                        {/* Right Side - Controls */}
                        <div className="md:col-span-3 p-8 flex flex-col justify-between space-y-6">
                            <div>
                                <DialogHeader className="text-left">
                                    <DialogTitle className="text-2xl text-[#485550]">Change Profile Picture</DialogTitle>
                                    <DialogDescription className="text-[#6B7C6F] mt-2">
                                        Upload a new photo to personalize your account.
                                        Recommended size: 400x400px.
                                    </DialogDescription>
                                </DialogHeader>

                                <div className="mt-8 flex flex-col gap-4">
                                    <Button
                                        variant="outline"
                                        onClick={() => fileInputRef.current?.click()}
                                        className="h-12 border-dashed border-[#D1DBC1] text-[#6B7C6F] hover:text-[#485550] hover:border-[#C0EB6A] hover:bg-[#F4F6F0] justify-start px-6"
                                    >
                                        <Camera className="w-5 h-5 mr-3" />
                                        {selectedImage ? 'Choose Different Photo' : 'Select Photo from Computer'}
                                    </Button>
                                    <input
                                        type="file"
                                        ref={fileInputRef}
                                        className="hidden"
                                        accept="image/*"
                                        onChange={handleFileSelect}
                                    />
                                </div>
                            </div>

                            <DialogFooter className="sm:justify-between gap-3 border-t border-[#F4F6F0] pt-6">
                                <Button
                                    variant="ghost"
                                    onClick={() => setShowUploadDialog(false)}
                                    className="text-[#6B7C6F] hover:text-[#485550]"
                                >
                                    Cancel
                                </Button>
                                <Button
                                    onClick={handleSaveAvatar}
                                    disabled={!selectedImage || isLoading}
                                    className="btn-morph-primary px-8"
                                >
                                    {isLoading ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Save className="w-4 h-4 mr-2" />}
                                    Save Changes
                                </Button>
                            </DialogFooter>
                        </div>
                    </div>
                </DialogContent>
            </Dialog>
        </div>
    );
}
