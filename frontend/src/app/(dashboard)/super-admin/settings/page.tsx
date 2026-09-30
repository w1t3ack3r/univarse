'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import {
    Settings,
    Save,
    RefreshCw,
    Globe,
    Mail,
    Shield,
    ShieldCheck,
    Database,
    Palette,
    Megaphone,
    Plus,
    Trash2,
    Check,
    X,
    ArrowRight,
    Loader2,
    Sliders,
    Cpu,
    Activity
} from 'lucide-react';
import { toast } from 'sonner';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000/api';

interface PlatformSetting {
    id: string;
    key: string;
    value: string;
    type: 'STRING' | 'NUMBER' | 'BOOLEAN' | 'JSON';
    category: string;
    label?: string;
    description?: string;
}

interface Announcement {
    id: string;
    title: string;
    message: string;
    type: 'info' | 'warning' | 'success' | 'error';
    isActive: boolean;
    startsAt: string;
    endsAt?: string;
    targetRoles: string[];
}

const categoryIcons: Record<string, any> = {
    SECURITY: Shield,
    EMAIL: Mail,
    FEATURES: Globe,
    BRANDING: Palette,
    TENANT_DEFAULTS: Database,
};

const categoryColors: Record<string, string> = {
    SECURITY: 'text-green-600',
    EMAIL: 'text-blue-600',
    FEATURES: 'text-purple-600',
    BRANDING: 'text-pink-600',
    TENANT_DEFAULTS: 'text-amber-600',
};

export default function SettingsPage() {
    const [isLoading, setIsLoading] = useState(true);
    const [isSaving, setIsSaving] = useState(false);
    const [settings, setSettings] = useState<Record<string, PlatformSetting[]>>({});
    const [announcements, setAnnouncements] = useState<Announcement[]>([]);
    const [editedSettings, setEditedSettings] = useState<Record<string, string>>({});
    const [showNewAnnouncement, setShowNewAnnouncement] = useState(false);
    const [newAnnouncement, setNewAnnouncement] = useState({
        title: '',
        message: '',
        type: 'info' as const,
        targetRoles: [] as string[],
    });

    useEffect(() => {
        fetchSettings();
        fetchAnnouncements();
    }, []);

    const getAuthToken = () => {
        if (typeof window !== 'undefined') {
            return localStorage.getItem('superAdminToken');
        }
        return null;
    };

    const fetchSettings = async () => {
        // MOCK SETTINGS FETCH
        try {
            await new Promise(resolve => setTimeout(resolve, 800));
            setSettings({
                SECURITY: [
                    { id: '1', key: 'MAX_LOGIN_ATTEMPTS', value: '5', type: 'NUMBER', category: 'SECURITY', label: 'Max Login Attempts', description: 'Lock account after N failed attempts' },
                    { id: '2', key: 'SESSION_TIMEOUT', value: '30', type: 'NUMBER', category: 'SECURITY', label: 'Session Timeout (min)', description: 'Auto-logout inactivity period' },
                    { id: '3', key: 'REQUIRE_2FA', value: 'true', type: 'BOOLEAN', category: 'SECURITY', label: 'Require 2FA', description: 'Enforce 2FA for all admins' },
                ],
                EMAIL: [
                    { id: '4', key: 'SMTP_HOST', value: 'smtp.gmail.com', type: 'STRING', category: 'EMAIL', label: 'SMTP Host' },
                    { id: '5', key: 'SMTP_PORT', value: '587', type: 'NUMBER', category: 'EMAIL', label: 'SMTP Port' },
                ],
                BRANDING: [
                    { id: '6', key: 'SHOW_POWERED_BY', value: 'true', type: 'BOOLEAN', category: 'BRANDING', label: 'Show "Powered By"', description: 'Display footer branding' },
                ]
            });
        } catch (error) {
            console.error('Failed to fetch settings:', error);
        } finally {
            setIsLoading(false);
        }
    };

    const fetchAnnouncements = async () => {
        // MOCK ANNOUNCEMENTS FETCH
        try {
            // await new Promise(resolve => setTimeout(resolve, 600));
            setAnnouncements([
                {
                    id: '1',
                    title: 'Welcome to UniVarse',
                    message: 'The new Super Admin dashboard is now live.',
                    type: 'info',
                    isActive: true,
                    startsAt: new Date().toISOString(),
                    targetRoles: ['SUPER_ADMIN']
                },
                {
                    id: '2',
                    title: 'Maintenance Scheduled',
                    message: 'Database optimization at midnight.',
                    type: 'warning',
                    isActive: true,
                    startsAt: new Date().toISOString(),
                    targetRoles: ['ALL']
                }
            ]);
        } catch (error) {
            console.error('Failed to fetch announcements:', error);
        }
    };

    const handleSettingChange = (key: string, value: string) => {
        setEditedSettings(prev => ({ ...prev, [key]: value }));
    };

    const saveSettings = async () => {
        setIsSaving(true);
        // MOCK SAVE
        try {
            await new Promise(resolve => setTimeout(resolve, 1000));

            // In a real mock, we'd update the state 'settings' object with 'editedSettings'
            // For now, just simulating success

            toast.success('Settings saved successfully (Mock Mode)');
            setEditedSettings({});
        } catch (error) {
            toast.error('Failed to save settings');
        } finally {
            setIsSaving(false);
        }
    };

    const seedDefaults = async () => {
        // MOCK SEED
        try {
            await new Promise(resolve => setTimeout(resolve, 1000));
            toast.success('Default settings applied (Mock Mode)');
            fetchSettings();
        } catch (error) {
            toast.error('Failed to seed defaults');
        }
    };

    const createAnnouncement = async () => {
        // MOCK CREATE
        try {
            await new Promise(resolve => setTimeout(resolve, 1000));

            const newAnn: Announcement = {
                id: Math.random().toString(36).substr(2, 9),
                title: newAnnouncement.title,
                message: newAnnouncement.message,
                type: newAnnouncement.type as any,
                isActive: true,
                startsAt: new Date().toISOString(),
                targetRoles: newAnnouncement.targetRoles
            };

            setAnnouncements([...announcements, newAnn]);
            toast.success('Announcement created (Mock Mode)');
            setShowNewAnnouncement(false);
            setNewAnnouncement({ title: '', message: '', type: 'info', targetRoles: [] });
        } catch (error) {
            toast.error('Failed to create announcement');
        }
    };

    const deleteAnnouncement = async (id: string) => {
        // MOCK DELETE
        try {
            setAnnouncements(announcements.filter(a => a.id !== id));
            toast.success('Announcement deleted (Mock Mode)');
        } catch (error) {
            toast.error('Failed to delete announcement');
        }
    };

    const toggleAnnouncement = async (id: string, isActive: boolean) => {
        // MOCK TOGGLE
        try {
            setAnnouncements(announcements.map(a => a.id === id ? { ...a, isActive: !isActive } : a));
        } catch (error) {
            toast.error('Failed to update announcement');
        }
    };

    const getSettingValue = (key: string, originalValue: string) => {
        return editedSettings[key] ?? originalValue;
    };

    const renderSettingInput = (setting: PlatformSetting) => {
        const value = getSettingValue(setting.key, setting.value);

        if (setting.type === 'BOOLEAN') {
            return (
                <Switch
                    checked={value === 'true'}
                    onCheckedChange={(checked) => handleSettingChange(setting.key, String(checked))}
                    className="data-[state=checked]:bg-[#C0EB6A] data-[state=unchecked]:bg-[#D1DBC1]"
                />
            );
        }

        return (
            <Input
                value={value}
                onChange={(e) => handleSettingChange(setting.key, e.target.value)}
                type={setting.type === 'NUMBER' ? 'number' : 'text'}
                className="input-morph max-w-xs bg-white"
            />
        );
    };

    if (isLoading) {
        return (
            <div className="flex items-center justify-center h-[calc(100vh-200px)]">
                <div className="flex flex-col items-center gap-4">
                    <Loader2 className="w-10 h-10 text-[#C0EB6A] animate-spin" />
                    <p className="text-[#6B7C6F] animate-pulse">Loading settings...</p>
                </div>
            </div>
        );
    }

    return (
        <div className="space-y-8">
            {/* Header */}
            <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
                <div>
                    <h2 className="text-2xl font-bold text-[#485550] flex items-center gap-3">
                        <Sliders className="w-6 h-6 text-[#C0EB6A]" />
                        Platform Settings
                    </h2>
                    <p className="text-[#6B7C6F]">Global configuration and announcements</p>
                </div>
                <div className="flex gap-3">
                    <Button variant="outline" onClick={seedDefaults} className="btn-morph bg-white hover:bg-[#F4F6F0]">
                        <Database className="w-4 h-4 mr-2" />
                        Seed Defaults
                    </Button>
                    <Button
                        onClick={saveSettings}
                        disabled={Object.keys(editedSettings).length === 0 || isSaving}
                        className="btn-morph-primary"
                    >
                        {isSaving ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
                        {isSaving ? 'Saving...' : 'Save Changes'}
                    </Button>
                </div>
            </div>

            <Tabs defaultValue="settings" className="space-y-6">
                <TabsList className="bg-[#F4F6F0] p-1 rounded-xl border border-transparent">
                    <TabsTrigger
                        value="settings"
                        className="rounded-lg data-[state=active]:bg-white data-[state=active]:text-[#485550] data-[state=active]:shadow-sm text-[#6B7C6F]"
                    >
                        <Settings className="w-4 h-4 mr-2" />
                        Settings
                    </TabsTrigger>

                    <TabsTrigger
                        value="security"
                        className="rounded-lg data-[state=active]:bg-white data-[state=active]:text-[#485550] data-[state=active]:shadow-sm text-[#6B7C6F]"
                    >
                        <ShieldCheck className="w-4 h-4 mr-2" />
                        Security & Integrations
                    </TabsTrigger>
                </TabsList>

                <TabsContent value="settings" className="space-y-6">
                    {Object.entries(settings).map(([category, categorySettings]) => {
                        const Icon = categoryIcons[category] || Globe;
                        const colorClass = categoryColors[category] || 'text-gray-500';

                        return (
                            <div key={category} className="morph-card overflow-hidden">
                                <CardHeader className="bg-[#F4F6F0]/50 border-b border-[#F4F6F0]">
                                    <CardTitle className="flex items-center gap-2 text-[#485550]">
                                        <div className={`p-2 rounded-lg bg-white shadow-sm ${colorClass}`}>
                                            <Icon className="w-5 h-5" />
                                        </div>
                                        {category.replace('_', ' ')}
                                    </CardTitle>
                                    <CardDescription className="text-[#6B7C6F]">
                                        {category === 'SECURITY' && 'Authentication and access control settings'}
                                        {category === 'EMAIL' && 'Email configuration settings'}
                                        {category === 'FEATURES' && 'Platform feature toggles'}
                                        {category === 'BRANDING' && 'Platform appearance settings'}
                                        {category === 'TENANT_DEFAULTS' && 'Default settings for new tenants'}
                                    </CardDescription>
                                </CardHeader>
                                <CardContent className="space-y-4 pt-6">
                                    {categorySettings.map((setting) => (
                                        <div key={setting.key} className="flex flex-col sm:flex-row sm:items-center justify-between py-3 border-b border-gray-100 last:border-0 gap-4">
                                            <div className="flex-1">
                                                <p className="font-medium text-[#485550]">
                                                    {setting.label || setting.key}
                                                </p>
                                                {setting.description && (
                                                    <p className="text-sm text-[#6B7C6F]">{setting.description}</p>
                                                )}
                                            </div>
                                            <div className="sm:ml-4">
                                                {renderSettingInput(setting)}
                                            </div>
                                        </div>
                                    ))}
                                </CardContent>
                            </div>
                        );
                    })}

                    {Object.keys(settings).length === 0 && (
                        <div className="morph-card py-16 text-center">
                            <div className="w-16 h-16 bg-[#F4F6F0] rounded-full flex items-center justify-center mx-auto mb-4">
                                <Database className="w-8 h-8 text-[#D1DBC1]" />
                            </div>
                            <h3 className="text-lg font-bold text-[#485550] mb-2">No Settings Found</h3>
                            <p className="text-[#6B7C6F] mb-6">Click "Seed Defaults" to initialize platform settings</p>
                            <Button onClick={seedDefaults} className="btn-morph-primary">
                                <Database className="w-4 h-4 mr-2" />
                                Seed Default Settings
                            </Button>
                        </div>
                    )}
                </TabsContent>

                <TabsContent value="security" className="space-y-6">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                        <div className="morph-card hover:bg-[#F4F6F0] transition-colors cursor-pointer group">
                            <Link href="/super-admin/settings/security" className="flex items-center p-6 gap-6">
                                <div className="w-16 h-16 rounded-2xl bg-green-100 flex items-center justify-center group-hover:scale-110 transition-transform shadow-sm">
                                    <ShieldCheck className="w-8 h-8 text-green-600" />
                                </div>
                                <div className="flex-1">
                                    <h3 className="text-xl font-bold text-[#485550] mb-1">Security & Access</h3>
                                    <p className="text-[#6B7C6F]">
                                        Configure 2FA, IP whitelisting, and session policies.
                                    </p>
                                </div>
                                <div className="p-2 rounded-full bg-white text-[#485550] shadow-sm group-hover:bg-[#C0EB6A] transition-colors">
                                    <ArrowRight className="w-5 h-5" />
                                </div>
                            </Link>
                        </div>

                        <div className="morph-card hover:bg-[#F4F6F0] transition-colors cursor-pointer group">
                            <Link href="/super-admin/settings/integrations" className="flex items-center p-6 gap-6">
                                <div className="w-16 h-16 rounded-2xl bg-blue-100 flex items-center justify-center group-hover:scale-110 transition-transform shadow-sm">
                                    <Cpu className="w-8 h-8 text-blue-600" />
                                </div>
                                <div className="flex-1">
                                    <h3 className="text-xl font-bold text-[#485550] mb-1">Integrations Hub</h3>
                                    <p className="text-[#6B7C6F]">
                                        Manage API keys for Stripe, SendGrid, and AI providers.
                                    </p>
                                </div>
                                <div className="p-2 rounded-full bg-white text-[#485550] shadow-sm group-hover:bg-[#C0EB6A] transition-colors">
                                    <ArrowRight className="w-5 h-5" />
                                </div>
                            </Link>
                        </div>

                        <div className="morph-card hover:bg-[#F4F6F0] transition-colors cursor-pointer group md:col-span-2">
                            <Link href="/super-admin/settings/maintenance" className="flex items-center p-6 gap-6">
                                <div className="w-16 h-16 rounded-2xl bg-amber-100 flex items-center justify-center group-hover:scale-110 transition-transform shadow-sm">
                                    <Activity className="w-8 h-8 text-amber-600" />
                                </div>
                                <div className="flex-1">
                                    <h3 className="text-xl font-bold text-[#485550] mb-1">System Maintenance</h3>
                                    <p className="text-[#6B7C6F]">
                                        Service status, logs, cache management, and system health utilities.
                                    </p>
                                </div>
                                <div className="p-2 rounded-full bg-white text-[#485550] shadow-sm group-hover:bg-[#C0EB6A] transition-colors">
                                    <ArrowRight className="w-5 h-5" />
                                </div>
                            </Link>
                        </div>
                    </div>
                </TabsContent>
            </Tabs>
        </div>
    );
}
