'use client';

import { useState, useEffect } from 'react';
import { CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    DialogFooter,
} from '@/components/ui/dialog';
import {
    Shield,
    ShieldCheck,
    ShieldOff,
    Smartphone,
    Key,
    Copy,
    RefreshCw,
    Loader2,
    CheckCircle2,
    AlertTriangle,
    ArrowLeft,
    ArrowRight,
    Download,
    Monitor,
    Trash2,
    Plus,
    X,
    Globe,
    Lock
} from 'lucide-react';
import { toast } from 'sonner';
// import { api } from '@/lib/api';
import { Switch } from '@radix-ui/react-switch';

// 2FA Setup Wizard Steps
type SetupStep = 'start' | 'qrcode' | 'verify' | 'recovery' | 'complete';

export default function SecuritySettingsPage() {
    // 2FA Status
    const [is2FAEnabled, setIs2FAEnabled] = useState(false);
    const [isLoading, setIsLoading] = useState(true);

    // Setup Wizard State
    const [showSetupWizard, setShowSetupWizard] = useState(false);
    const [setupStep, setSetupStep] = useState<SetupStep>('start');
    const [qrCode, setQrCode] = useState('');
    const [secret, setSecret] = useState('');
    const [verificationCode, setVerificationCode] = useState('');
    const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
    const [isSettingUp, setIsSettingUp] = useState(false);
    const [setupError, setSetupError] = useState('');

    // Disable 2FA State
    const [showDisableDialog, setShowDisableDialog] = useState(false);
    const [disablePassword, setDisablePassword] = useState('');
    const [disableToken, setDisableToken] = useState('');
    const [isDisabling, setIsDisabling] = useState(false);

    // Recovery Codes View
    const [showRecoveryCodes, setShowRecoveryCodes] = useState(false);
    const [isRegeneratingCodes, setIsRegeneratingCodes] = useState(false);

    // Session Management State
    const [sessions, setSessions] = useState<any[]>([]);
    const [isLoadingSessions, setIsLoadingSessions] = useState(false);
    const [terminatingSessionId, setTerminatingSessionId] = useState<string | null>(null);

    // IP Whitelist State
    const [ipWhitelist, setIpWhitelist] = useState<string[]>([]);
    const [ipWhitelistEnabled, setIpWhitelistEnabled] = useState(false);
    const [currentIP, setCurrentIP] = useState('');
    const [newIP, setNewIP] = useState('');
    const [isLoadingIP, setIsLoadingIP] = useState(false);
    const [isSavingIP, setIsSavingIP] = useState(false);

    // Fetch 2FA status on mount
    useEffect(() => {
        fetchStatus();
        fetchSessions();
        fetchIPWhitelist();
    }, []);

    const fetchStatus = async () => {
        // MOCK STATUS
        setTimeout(() => {
            setIs2FAEnabled(false);
            setIsLoading(false);
        }, 500);
    };

    const fetchSessions = async () => {
        setIsLoadingSessions(true);
        // MOCK SESSIONS
        setTimeout(() => {
            setSessions([
                { id: 'sess-1', deviceInfo: 'Windows 11 · Chrome', ipAddress: '127.0.0.1', lastActivityAt: new Date().toISOString(), isCurrent: true },
                { id: 'sess-2', deviceInfo: 'iPhone 14 · Safari', ipAddress: '192.168.1.4', lastActivityAt: new Date(Date.now() - 3600000).toISOString(), isCurrent: false },
            ]);
            setIsLoadingSessions(false);
        }, 800);
    };

    const fetchIPWhitelist = async () => {
        setIsLoadingIP(true);
        // MOCK IP WHITELIST
        setTimeout(() => {
            setIpWhitelist(['127.0.0.1', '192.168.1.1']);
            setIpWhitelistEnabled(true);
            setCurrentIP('127.0.0.1');
            setIsLoadingIP(false);
        }, 600);
    };

    // ==================== SETUP WIZARD ====================

    const startSetup = async () => {
        setSetupStep('start');
        setSetupError('');
        setShowSetupWizard(true);
    };

    const proceedToQRCode = async () => {
        setIsSettingUp(true);
        setSetupError('');
        // MOCK GENERATE QR
        setTimeout(() => {
            setQrCode('https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=otpauth://totp/UniVarse:superadmin?secret=MOCKSECRET123&issuer=UniVarse');
            setSecret('MOCKSECRET123');
            setSetupStep('qrcode');
            setIsSettingUp(false);
        }, 1000);
    };

    const verifySetup = async () => {
        if (verificationCode.length < 6) {
            setSetupError('Please enter a 6-digit code');
            return;
        }

        setIsSettingUp(true);
        setSetupError('');
        // MOCK VERIFY
        setTimeout(() => {
            if (verificationCode === '123456' || verificationCode.length === 6) {
                setRecoveryCodes(['RECO-VERY-CODE-1', 'RECO-VERY-CODE-2', 'RECO-VERY-CODE-3', 'RECO-VERY-CODE-4']);
                setSetupStep('recovery');
            } else {
                setSetupError('Invalid verification code');
            }
            setIsSettingUp(false);
        }, 1000);
    };

    const completeSetup = () => {
        setSetupStep('complete');
        setIs2FAEnabled(true);
    };

    const closeSetupWizard = () => {
        setShowSetupWizard(false);
        setSetupStep('start');
        setQrCode('');
        setSecret('');
        setVerificationCode('');
        setRecoveryCodes([]);
        setSetupError('');
    };

    // ==================== DISABLE 2FA ====================

    const handleDisable2FA = async () => {
        if (!disablePassword || !disableToken) {
            toast.error('Please enter both password and 2FA code');
            return;
        }

        setIsDisabling(true);
        // MOCK DISABLE
        setTimeout(() => {
            setIs2FAEnabled(false);
            setShowDisableDialog(false);
            setDisablePassword('');
            setDisableToken('');
            toast.success('2FA has been disabled (Mock Mode)');
            setIsDisabling(false);
        }, 1000);
    };

    // ==================== RECOVERY CODES ====================

    const handleRegenerateCodes = async () => {
        setIsRegeneratingCodes(true);
        // MOCK REGENERATE
        setTimeout(() => {
            setRecoveryCodes(['NEW-CODE-1', 'NEW-CODE-2', 'NEW-CODE-3', 'NEW-CODE-4']);
            setShowRecoveryCodes(true);
            toast.success('Recovery codes regenerated (Mock Mode)');
            setIsRegeneratingCodes(false);
        }, 1000);
    };

    const copyRecoveryCodes = () => {
        navigator.clipboard.writeText(recoveryCodes.join('\n'));
        toast.success('Recovery codes copied to clipboard');
    };

    const downloadRecoveryCodes = () => {
        const content = `UniVarse Super Admin Recovery Codes\n${'='.repeat(40)}\n\nThese codes can be used to access your account if you lose your authenticator device.\nEach code can only be used once.\n\n${recoveryCodes.map((code, i) => `${i + 1}. ${code}`).join('\n')}\n\nKeep these codes in a safe place.`;
        const blob = new Blob([content], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'univarse-recovery-codes.txt';
        a.click();
        URL.revokeObjectURL(url);
        toast.success('Recovery codes downloaded');
    };

    // ==================== SESSION MANAGEMENT ====================

    const terminateSession = async (sessionId: string) => {
        setTerminatingSessionId(sessionId);
        // MOCK TERMINATE
        setTimeout(() => {
            setSessions(prev => prev.filter(s => s.id !== sessionId));
            toast.success('Session terminated (Mock Mode)');
            setTerminatingSessionId(null);
        }, 800);
    };

    const terminateAllSessions = async () => {
        // MOCK TERMINATE ALL
        setTimeout(() => {
            setSessions(prev => prev.filter(s => s.isCurrent));
            toast.success('All other sessions terminated (Mock Mode)');
        }, 800);
    };

    // ==================== IP WHITELIST ====================

    const addIP = () => {
        if (!newIP.trim()) return;
        const ipRegex = /^(\d{1,3}\.){3}\d{1,3}$/;
        if (!ipRegex.test(newIP.trim())) {
            toast.error('Invalid IP address format');
            return;
        }
        if (ipWhitelist.includes(newIP.trim())) {
            toast.error('IP already in whitelist');
            return;
        }
        setIpWhitelist(prev => [...prev, newIP.trim()]);
        setNewIP('');
    };

    const removeIP = (ip: string) => {
        setIpWhitelist(prev => prev.filter(i => i !== ip));
    };

    const saveIPWhitelist = async () => {
        setIsSavingIP(true);
        // MOCK SAVE IP
        setTimeout(() => {
            toast.success('IP whitelist saved (Mock Mode)');
            setIsSavingIP(false);
        }, 1000);
    };

    // ==================== RENDER ====================

    if (isLoading) {
        return (
            <div className="flex items-center justify-center h-[calc(100vh-200px)]">
                <div className="flex flex-col items-center gap-4">
                    <Loader2 className="w-10 h-10 text-[#C0EB6A] animate-spin" />
                    <p className="text-[#6B7C6F] animate-pulse">Checking security status...</p>
                </div>
            </div>
        );
    }

    return (
        <div className="space-y-8">
            {/* Header */}
            <div>
                <Button variant="ghost" className="mb-4 text-[#6B7C6F] hover:text-[#485550]" onClick={() => window.history.back()}>
                    <ArrowLeft className="w-4 h-4 mr-2" />
                    Back to Settings
                </Button>
                <h1 className="text-3xl font-bold text-[#485550]">Security Settings</h1>
                <p className="text-[#6B7C6F] mt-1">Manage your account security and authentication</p>
            </div>

            {/* 2FA Status Card */}
            <div className="morph-card p-6">
                <div className="flex items-center justify-between mb-6">
                    <div className="flex items-center gap-4">
                        <div className={`w-14 h-14 rounded-2xl flex items-center justify-center shadow-lg ${is2FAEnabled
                            ? 'bg-green-100 text-green-600'
                            : 'bg-amber-100 text-amber-600'
                            }`}>
                            {is2FAEnabled
                                ? <ShieldCheck className="w-7 h-7" />
                                : <Shield className="w-7 h-7" />
                            }
                        </div>
                        <div>
                            <h3 className="text-xl font-bold text-[#485550]">Two-Factor Authentication</h3>
                            <p className="text-[#6B7C6F]">
                                Add an extra layer of security to your account
                            </p>
                        </div>
                    </div>
                    <Badge className={`px-4 py-1.5 text-sm rounded-lg ${is2FAEnabled
                        ? 'bg-green-100 text-green-700 hover:bg-green-200'
                        : 'bg-amber-100 text-amber-700 hover:bg-amber-200'
                        }`}>
                        {is2FAEnabled ? 'Enabled' : 'Disabled'}
                    </Badge>
                </div>

                <div className="pl-[72px]">
                    {is2FAEnabled ? (
                        <div className="space-y-6">
                            <p className="text-[#485550]">
                                Your account is protected with two-factor authentication using an authenticator app.
                            </p>
                            <div className="flex gap-3">
                                <Button
                                    variant="outline"
                                    onClick={handleRegenerateCodes}
                                    disabled={isRegeneratingCodes}
                                    className="btn-morph bg-white"
                                >
                                    {isRegeneratingCodes ? (
                                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                                    ) : (
                                        <Key className="w-4 h-4 mr-2" />
                                    )}
                                    view Recovery Codes
                                </Button>
                                <Button
                                    variant="outline"
                                    className="text-red-600 hover:text-red-700 hover:bg-red-50 border-red-100"
                                    onClick={() => setShowDisableDialog(true)}
                                >
                                    <ShieldOff className="w-4 h-4 mr-2" />
                                    Disable 2FA
                                </Button>
                            </div>
                        </div>
                    ) : (
                        <div className="space-y-6">
                            <div className="p-4 bg-amber-50 border border-amber-200 rounded-xl">
                                <div className="flex items-start gap-3">
                                    <AlertTriangle className="w-5 h-5 text-amber-600 mt-0.5" />
                                    <div>
                                        <p className="font-bold text-amber-800">
                                            Your account is not fully protected
                                        </p>
                                        <p className="text-sm text-amber-700 mt-1">
                                            Enable two-factor authentication to add an extra layer of security.
                                        </p>
                                    </div>
                                </div>
                            </div>
                            <Button
                                onClick={startSetup}
                                className="btn-morph-primary"
                            >
                                <Smartphone className="w-4 h-4 mr-2" />
                                Enable Two-Factor Authentication
                            </Button>
                        </div>
                    )}
                </div>
            </div>

            {/* Active Sessions Card */}
            <div className="morph-card p-6">
                <div className="flex items-center justify-between mb-6">
                    <div className="flex items-center gap-4">
                        <div className="w-14 h-14 rounded-2xl bg-blue-100 flex items-center justify-center text-blue-600 shadow-lg">
                            <Monitor className="w-7 h-7" />
                        </div>
                        <div>
                            <h3 className="text-xl font-bold text-[#485550]">Active Sessions</h3>
                            <p className="text-[#6B7C6F]">
                                Manage your active login sessions
                            </p>
                        </div>
                    </div>
                    {sessions.length > 1 && (
                        <Button
                            variant="outline"
                            size="sm"
                            className="text-red-600 hover:text-red-700 hover:bg-red-50 border-red-100"
                            onClick={terminateAllSessions}
                        >
                            <Trash2 className="w-4 h-4 mr-2" />
                            End All Others
                        </Button>
                    )}
                </div>

                <div className="pl-[72px]">
                    {isLoadingSessions ? (
                        <div className="flex items-center py-4">
                            <RefreshCw className="w-5 h-5 animate-spin text-[#C0EB6A] mr-2" />
                            <span className="text-[#6B7C6F]">Loading sessions...</span>
                        </div>
                    ) : sessions.length === 0 ? (
                        <p className="text-[#6B7C6F] py-4">No active sessions found</p>
                    ) : (
                        <div className="space-y-3">
                            {sessions.map((session) => (
                                <div
                                    key={session.id}
                                    className={`p-4 rounded-xl border flex items-center justify-between ${session.isCurrent
                                        ? 'bg-green-50 border-green-200 shadow-sm'
                                        : 'bg-white border-[#F4F6F0]'
                                        }`}
                                >
                                    <div className="flex items-center gap-4">
                                        <Monitor className={`w-5 h-5 ${session.isCurrent ? 'text-green-600' : 'text-gray-400'}`} />
                                        <div>
                                            <div className="font-bold text-[#485550] flex items-center gap-2">
                                                {session.deviceInfo || 'Unknown Device'}
                                                {session.isCurrent && (
                                                    <Badge className="bg-green-100 text-green-700 hover:bg-green-100 text-xs px-2 py-0.5 rounded">Current</Badge>
                                                )}
                                            </div>
                                            <p className="text-sm text-[#6B7C6F]">
                                                {session.ipAddress} • {new Date(session.lastActivityAt).toLocaleString()}
                                            </p>
                                        </div>
                                    </div>
                                    {!session.isCurrent && (
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            className="text-red-600 hover:text-red-700 hover:bg-red-50"
                                            onClick={() => terminateSession(session.id)}
                                            disabled={terminatingSessionId === session.id}
                                        >
                                            {terminatingSessionId === session.id ? (
                                                <Loader2 className="w-4 h-4 animate-spin" />
                                            ) : (
                                                <X className="w-4 h-4" />
                                            )}
                                        </Button>
                                    )}
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </div>

            {/* IP Whitelist Card */}
            <div className="morph-card p-6">
                <div className="flex items-center justify-between mb-6">
                    <div className="flex items-center gap-4">
                        <div className="w-14 h-14 rounded-2xl bg-purple-100 flex items-center justify-center text-purple-600 shadow-lg">
                            <Globe className="w-7 h-7" />
                        </div>
                        <div>
                            <h3 className="text-xl font-bold text-[#485550]">IP Address Restriction</h3>
                            <p className="text-[#6B7C6F]">
                                Restrict login access to specific IP addresses
                            </p>
                        </div>
                    </div>
                </div>

                <div className="pl-[72px]">
                    {isLoadingIP ? (
                        <div className="flex items-center py-4">
                            <RefreshCw className="w-5 h-5 animate-spin text-[#C0EB6A] mr-2" />
                            <span className="text-[#6B7C6F]">Loading IP settings...</span>
                        </div>
                    ) : (
                        <div className="space-y-6">
                            {/* Enable Toggle */}
                            <div className="flex items-center justify-between p-4 bg-[#F4F6F0] rounded-xl border border-transparent hover:border-[#D1DBC1] transition-colors">
                                <div>
                                    <p className="font-bold text-[#485550]">Enable IP Restriction</p>
                                    <p className="text-sm text-[#6B7C6F]">Only allow login from whitelisted IPs</p>
                                </div>
                                <Switch
                                    checked={ipWhitelistEnabled}
                                    onCheckedChange={setIpWhitelistEnabled}
                                    className="data-[state=checked]:bg-purple-600"
                                />
                            </div>

                            {/* Current IP */}
                            <div className="p-3 bg-blue-50 border border-blue-200 rounded-xl flex items-center gap-2">
                                <div className="w-2 h-2 rounded-full bg-blue-500 animate-pulse ml-2" />
                                <p className="text-sm text-blue-800">
                                    Your current IP: <code className="font-mono font-bold">{currentIP || 'Unknown'}</code>
                                </p>
                            </div>

                            {/* Add IP */}
                            <div className="flex gap-3">
                                <Input
                                    placeholder="Enter IP address (e.g., 192.168.1.1)"
                                    value={newIP}
                                    onChange={(e) => setNewIP(e.target.value)}
                                    onKeyDown={(e) => e.key === 'Enter' && addIP()}
                                    className="input-morph bg-white flex-1"
                                />
                                <Button onClick={addIP} variant="outline" className="btn-morph bg-white">
                                    <Plus className="w-4 h-4" />
                                </Button>
                            </div>

                            {/* IP List */}
                            {ipWhitelist.length > 0 && (
                                <div className="space-y-3">
                                    <Label className="text-[#485550]">Whitelisted IPs</Label>
                                    <div className="flex flex-wrap gap-2">
                                        {ipWhitelist.map((ip) => (
                                            <div
                                                key={ip}
                                                className="flex items-center gap-2 pl-3 pr-2 py-1.5 bg-white border border-[#D1DBC1] rounded-lg text-sm shadow-sm"
                                            >
                                                <span className="font-mono text-[#485550]">{ip}</span>
                                                <button
                                                    onClick={() => removeIP(ip)}
                                                    className="p-1 rounded-md hover:bg-red-50 text-gray-400 hover:text-red-500 transition-colors"
                                                >
                                                    <X className="w-3 h-3" />
                                                </button>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}

                            {/* Save Button */}
                            <Button
                                onClick={saveIPWhitelist}
                                disabled={isSavingIP}
                                className="w-full btn-morph-primary py-6"
                            >
                                {isSavingIP ? (
                                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                                ) : (
                                    <CheckCircle2 className="w-4 h-4 mr-2" />
                                )}
                                Save IP Settings
                            </Button>
                        </div>
                    )}
                </div>
            </div>

            {/* 2FA Setup Wizard Dialog */}
            <Dialog open={showSetupWizard} onOpenChange={(open) => !open && closeSetupWizard()}>
                <DialogContent className="sm:max-w-4xl bg-[#F4F6F0] border-white shadow-2xl rounded-[2rem] p-0 overflow-hidden">
                    <div className="grid grid-cols-1 md:grid-cols-5 h-full">
                        {/* Left Side - Visual & Steps */}
                        <div className="md:col-span-2 bg-[#E8EDE0]/50 p-8 flex flex-col justify-between border-b md:border-b-0 md:border-r border-[#D1DBC1]/50 relative overflow-hidden">
                            <div className="relative z-10">
                                <div className="p-3 bg-white rounded-2xl w-fit shadow-sm mb-6">
                                    <div className="p-3 bg-[#C0EB6A] rounded-xl text-[#485550]">
                                        <ShieldCheck className="w-8 h-8" />
                                    </div>
                                </div>
                                <DialogTitle className="text-[#485550] font-bold text-xl mb-2">Two-Factor Auth</DialogTitle>
                                <p className="text-[#6B7C6F] text-sm leading-relaxed">
                                    Secure your account in 3 simple steps.
                                </p>
                            </div>

                            {/* Step Indicators */}
                            <div className="relative z-10 space-y-4 mt-8">
                                <div className={`flex items-center gap-3 text-sm transition-opacity ${setupStep === 'start' ? 'opacity-100 font-bold text-[#485550]' : 'opacity-50 text-[#6B7C6F]'}`}>
                                    <div className={`w-8 h-8 rounded-full flex items-center justify-center border-2 ${setupStep === 'start' ? 'border-[#C0EB6A] bg-[#C0EB6A]/20' : 'border-[#D1DBC1]'}`}>1</div>
                                    <span>Download App</span>
                                </div>
                                <div className={`flex items-center gap-3 text-sm transition-opacity ${setupStep === 'qrcode' ? 'opacity-100 font-bold text-[#485550]' : 'opacity-50 text-[#6B7C6F]'}`}>
                                    <div className={`w-8 h-8 rounded-full flex items-center justify-center border-2 ${setupStep === 'qrcode' ? 'border-[#C0EB6A] bg-[#C0EB6A]/20' : 'border-[#D1DBC1]'}`}>2</div>
                                    <span>Scan QR Code</span>
                                </div>
                                <div className={`flex items-center gap-3 text-sm transition-opacity ${setupStep === 'verify' ? 'opacity-100 font-bold text-[#485550]' : 'opacity-50 text-[#6B7C6F]'}`}>
                                    <div className={`w-8 h-8 rounded-full flex items-center justify-center border-2 ${setupStep === 'verify' ? 'border-[#C0EB6A] bg-[#C0EB6A]/20' : 'border-[#D1DBC1]'}`}>3</div>
                                    <span>Verify Code</span>
                                </div>
                            </div>

                            {/* Decor */}
                            <div className="absolute -bottom-10 -right-10 text-[#D1DBC1]/20 transform rotate-12">
                                <Lock className="w-48 h-48" />
                            </div>
                        </div>

                        {/* Right Side - Wizard Content */}
                        <div className="md:col-span-3 p-8 flex flex-col justify-center min-h-[500px]">
                            <DialogHeader className="mb-6">
                                <DialogTitle className="text-[#485550] text-xl font-bold">
                                    {setupStep === 'start' && 'Step 1: Get Authenticator'}
                                    {setupStep === 'qrcode' && 'Step 2: Link Device'}
                                    {setupStep === 'verify' && 'Step 3: Verification'}
                                    {setupStep === 'recovery' && 'Safety Backup'}
                                    {setupStep === 'complete' && 'Setup Complete'}
                                </DialogTitle>
                            </DialogHeader>

                            {/* Step: Start */}
                            {setupStep === 'start' && (
                                <div className="space-y-6">
                                    <div className="p-4 bg-white rounded-xl border border-[#F4F6F0] shadow-sm">
                                        <p className="text-[#6B7C6F] mb-4">
                                            Download one of these apps to your smartphone:
                                        </p>
                                        <div className="flex gap-4 justify-center">
                                            <div className="text-center">
                                                <div className="w-12 h-12 bg-gray-100 rounded-xl mb-2 mx-auto flex items-center justify-center font-bold text-gray-400">G</div>
                                                <span className="text-xs text-[#6B7C6F] font-medium">Google</span>
                                            </div>
                                            <div className="text-center">
                                                <div className="w-12 h-12 bg-gray-100 rounded-xl mb-2 mx-auto flex items-center justify-center font-bold text-gray-400">M</div>
                                                <span className="text-xs text-[#6B7C6F] font-medium">Microsoft</span>
                                            </div>
                                            <div className="text-center">
                                                <div className="w-12 h-12 bg-gray-100 rounded-xl mb-2 mx-auto flex items-center justify-center font-bold text-gray-400">A</div>
                                                <span className="text-xs text-[#6B7C6F] font-medium">Authy</span>
                                            </div>
                                        </div>
                                    </div>
                                    <DialogFooter className="flex justify-between sm:justify-between items-center mt-8">
                                        <Button variant="ghost" onClick={closeSetupWizard} className="text-[#6B7C6F] hover:text-[#485550]">Cancel</Button>
                                        <Button onClick={proceedToQRCode} disabled={isSettingUp} className="btn-morph-primary">
                                            {isSettingUp ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <ArrowRight className="w-4 h-4 mr-2" />}
                                            Next Step
                                        </Button>
                                    </DialogFooter>
                                </div>
                            )}

                            {/* Step: QR Code */}
                            {setupStep === 'qrcode' && (
                                <div className="space-y-6">
                                    {setupError && (
                                        <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
                                            {setupError}
                                        </div>
                                    )}
                                    <div className="flex flex-col items-center justify-center">
                                        {qrCode ? (
                                            <div className="p-4 bg-white border border-gray-200 rounded-xl shadow-inner mb-4">
                                                <img src={qrCode} alt="2FA QR Code" className="w-40 h-40 mix-blend-multiply" />
                                            </div>
                                        ) : (
                                            <div className="w-40 h-40 bg-gray-100 rounded-xl flex items-center justify-center mb-4">
                                                <Loader2 className="w-8 h-8 animate-spin text-gray-400" />
                                            </div>
                                        )}
                                        <p className="text-sm text-[#6B7C6F] text-center max-w-xs">
                                            Open your authenticator app and point your camera at this code.
                                        </p>
                                    </div>

                                    <div className="text-center text-xs">
                                        <span className="text-[#6B7C6F]">Alternative code: </span>
                                        <button
                                            onClick={() => { navigator.clipboard.writeText(secret); toast.success('Copied!'); }}
                                            className="font-mono font-bold text-[#485550] hover:bg-[#F4F6F0] px-2 py-1 rounded cursor-pointer"
                                        >
                                            {secret} <Copy className="w-3 h-3 inline ml-1 opacity-50" />
                                        </button>
                                    </div>

                                    <DialogFooter className="flex justify-between sm:justify-between items-center mt-4">
                                        <Button variant="ghost" onClick={() => setSetupStep('start')} className="text-[#6B7C6F]">
                                            <ArrowLeft className="w-4 h-4 mr-2" />
                                            Back
                                        </Button>
                                        <Button onClick={() => setSetupStep('verify')} className="btn-morph-primary">
                                            Enter Code <ArrowRight className="w-4 h-4 ml-2" />
                                        </Button>
                                    </DialogFooter>
                                </div>
                            )}

                            {/* Step: Verify */}
                            {setupStep === 'verify' && (
                                <div className="space-y-8">
                                    <div className="text-center">
                                        <p className="text-[#6B7C6F] mb-6">
                                            Enter the 6-digit code generated by your app.
                                        </p>
                                        <div className="flex justify-center">
                                            <Input
                                                id="verifyCode"
                                                type="text"
                                                placeholder="000 000"
                                                value={verificationCode}
                                                onChange={(e) => setVerificationCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                                                className="input-morph text-center text-4xl font-mono tracking-[0.2em] w-full max-w-xs h-20 bg-white shadow-inner"
                                                maxLength={6}
                                                autoFocus
                                            />
                                        </div>
                                    </div>
                                    {setupError && (
                                        <p className="text-red-500 text-sm text-center font-medium bg-red-50 p-2 rounded-lg">{setupError}</p>
                                    )}
                                    <DialogFooter className="flex justify-between sm:justify-between items-center">
                                        <Button variant="ghost" onClick={() => setSetupStep('qrcode')} className="text-[#6B7C6F]">
                                            <ArrowLeft className="w-4 h-4 mr-2" />
                                            Back
                                        </Button>
                                        <Button onClick={verifySetup} disabled={isSettingUp || verificationCode.length < 6} className="btn-morph-primary">
                                            {isSettingUp ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <CheckCircle2 className="w-4 h-4 mr-2" />}
                                            Verify & Enable
                                        </Button>
                                    </DialogFooter>
                                </div>
                            )}

                            {/* Step: Recovery Codes */}
                            {setupStep === 'recovery' && (
                                <div className="space-y-6">
                                    <div className="p-4 bg-amber-50 border border-amber-200 rounded-xl flex items-start gap-3">
                                        <AlertTriangle className="w-5 h-5 text-amber-600 mt-0.5 shrink-0" />
                                        <div>
                                            <p className="font-bold text-amber-800 text-sm">Save your recovery codes!</p>
                                            <p className="text-xs text-amber-700 mt-1 leading-normal">
                                                If you lose your device, these codes are the ONLY way to access your account.
                                            </p>
                                        </div>
                                    </div>
                                    <div className="grid grid-cols-2 gap-3 p-4 bg-white rounded-xl border border-[#D1DBC1] font-mono text-sm shadow-sm">
                                        {recoveryCodes.map((code, index) => (
                                            <div key={index} className="text-center py-2 bg-[#F4F6F0] rounded-lg text-[#485550] font-semibold tracking-wider">
                                                {code}
                                            </div>
                                        ))}
                                    </div>
                                    <div className="flex gap-3">
                                        <Button variant="outline" className="flex-1 btn-morph bg-white h-10" onClick={copyRecoveryCodes}>
                                            <Copy className="w-4 h-4 mr-2" />
                                            Copy
                                        </Button>
                                        <Button variant="outline" className="flex-1 btn-morph bg-white h-10" onClick={downloadRecoveryCodes}>
                                            <Download className="w-4 h-4 mr-2" />
                                            Download
                                        </Button>
                                    </div>
                                    <Button onClick={completeSetup} className="w-full bg-green-600 hover:bg-green-700 text-white rounded-xl py-6 shadow-lg shadow-green-200 mt-4">
                                        <CheckCircle2 className="w-5 h-5 mr-2" />
                                        I've Saved Them
                                    </Button>
                                </div>
                            )}

                            {/* Step: Complete */}
                            {setupStep === 'complete' && (
                                <div className="flex flex-col items-center justify-center h-full text-center space-y-6">
                                    <div className="w-20 h-20 rounded-full bg-green-100 flex items-center justify-center animate-bounce shadow-lg shadow-green-100">
                                        <CheckCircle2 className="w-10 h-10 text-green-600" />
                                    </div>
                                    <div>
                                        <h3 className="text-2xl font-bold text-[#485550]">You're all set!</h3>
                                        <p className="text-[#6B7C6F] mt-2 max-w-xs mx-auto">
                                            Your account is now fully protected.
                                        </p>
                                    </div>
                                    <Button onClick={closeSetupWizard} className="w-full btn-morph-primary">
                                        Return to Settings
                                    </Button>
                                </div>
                            )}
                        </div>
                    </div>
                </DialogContent>
            </Dialog>

            {/* Disable 2FA Dialog */}
            <Dialog open={showDisableDialog} onOpenChange={(open) => {
                if (!open) {
                    setShowDisableDialog(false);
                    setDisablePassword('');
                    setDisableToken('');
                }
            }}>
                <DialogContent className="sm:max-w-[400px] bg-[#F4F6F0] border-white shadow-2xl rounded-[2rem]">
                    <DialogHeader>
                        <DialogTitle className="flex items-center gap-2 text-red-600">
                            <ShieldOff className="w-5 h-5" />
                            Disable 2FA?
                        </DialogTitle>
                        <DialogDescription>
                            This will make your account less secure. You'll need to verify your identity to proceed.
                        </DialogDescription>
                    </DialogHeader>

                    <div className="space-y-4 py-4">
                        <div className="space-y-2">
                            <Label htmlFor="password">Current Password</Label>
                            <Input
                                id="password"
                                type="password"
                                value={disablePassword}
                                onChange={(e) => setDisablePassword(e.target.value)}
                                className="input-morph bg-white"
                            />
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="token">2FA Code</Label>
                            <Input
                                id="token"
                                placeholder="000000"
                                value={disableToken}
                                onChange={(e) => setDisableToken(e.target.value.replace(/\D/g, '').slice(0, 6))}
                                className="input-morph bg-white font-mono"
                                maxLength={6}
                            />
                        </div>
                    </div>

                    <DialogFooter>
                        <Button variant="ghost" onClick={() => setShowDisableDialog(false)} className="text-[#6B7C6F]">Cancel</Button>
                        <Button
                            onClick={handleDisable2FA}
                            className="bg-red-600 hover:bg-red-700 text-white rounded-xl shadow-lg border-0"
                            disabled={isDisabling}
                        >
                            {isDisabling ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <ShieldOff className="w-4 h-4 mr-2" />}
                            Disable Forever
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}
