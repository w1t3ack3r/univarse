'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogDescription,
} from '@/components/ui/dialog';
import { Crown, Eye, EyeOff, Loader2, AlertCircle, Shield, Key, Lock, Mail, ArrowRight } from 'lucide-react';
import { toast } from 'sonner';
// import { api } from '@/lib/api';

export default function SuperAdminLoginPage() {
    const router = useRouter();
    const [isLoading, setIsLoading] = useState(false);
    const [showPassword, setShowPassword] = useState(false);
    const [error, setError] = useState('');
    const [rememberMe, setRememberMe] = useState(false);
    const [showForgotPassword, setShowForgotPassword] = useState(false);
    const [formData, setFormData] = useState({
        email: '',
        password: '',
    });

    // 2FA State
    const [show2FADialog, setShow2FADialog] = useState(false);
    const [twoFactorCode, setTwoFactorCode] = useState('');
    const [pending2FAEmail, setPending2FAEmail] = useState('');
    const [is2FALoading, setIs2FALoading] = useState(false);
    const [twoFactorError, setTwoFactorError] = useState('');

    const handleForgotPassword = async (e: React.FormEvent) => {
        // MOCK RESET
        toast.promise(
            new Promise(resolve => setTimeout(resolve, 1500)),
            {
                loading: 'Sending reset link...',
                success: () => {
                    setShowForgotPassword(false);
                    return 'Reset link sent to your email!';
                },
                error: 'Failed to send reset link',
            }
        );
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError('');
        setIsLoading(true);

        // MOCK LOGIN LOGIC
        try {
            // Simulate network delay
            await new Promise(resolve => setTimeout(resolve, 1500));

            // Demo specific logic: '2fa@univarse.com' triggers 2FA dialog
            if (formData.email === '2fa@univarse.com') {
                setPending2FAEmail(formData.email);
                setShow2FADialog(true);
                setIsLoading(false);
                return;
            }

            // Default Mock User
            const mockUser = {
                id: 'super-admin-mock-id',
                email: formData.email,
                name: 'Super Admin',
                firstName: 'Super',
                lastName: 'Admin',
                role: 'SUPER_ADMIN',
                permissions: ['ALL']
            };

            // Store mock user
            localStorage.setItem('superAdminToken', 'mock-jwt-token-12345');
            localStorage.setItem('superAdmin', JSON.stringify(mockUser));

            // Normal login success
            toast.success('Login successful! (Mock Mode)');
            router.push('/super-admin');
        } catch (err: any) {
            setError('Mock login failed - this should not happen');
            toast.error('Login failed');
        } finally {
            setIsLoading(false);
        }
    };

    const handle2FAVerification = async () => {
        if (!twoFactorCode.trim()) {
            setTwoFactorError('Please enter your 2FA code');
            return;
        }

        setIs2FALoading(true);
        setTwoFactorError('');

        try {
            // Simulate network delay
            await new Promise(resolve => setTimeout(resolve, 1500));

            if (twoFactorCode !== '123456') {
                throw new Error('Invalid code (Try 123456)');
            }

            // Mock User for 2FA
            const mockUser = {
                id: 'super-admin-mock-id',
                email: pending2FAEmail,
                name: 'Mock Super Admin',
                role: 'SUPER_ADMIN',
                permissions: ['ALL']
            };

            // Store user info
            localStorage.setItem('superAdminToken', 'mock-jwt-token-12345');
            localStorage.setItem('superAdmin', JSON.stringify(mockUser));

            toast.success('2FA Verified! (Mock Mode)');
            router.push('/super-admin');
        } catch (err: any) {
            setTwoFactorError(err.message || 'Invalid 2FA code');
        } finally {
            setIs2FALoading(false);
        }
    };

    const close2FADialog = () => {
        setShow2FADialog(false);
        setTwoFactorCode('');
        setTwoFactorError('');
        setPending2FAEmail('');
    };

    return (
        <div className="min-h-screen flex items-center justify-center bg-[#F4F6F0] p-4 overflow-hidden relative">
            {/* Background Texture/Elements */}
            <div className="absolute top-[-10%] right-[-5%] w-[600px] h-[600px] bg-gradient-brand opacity-10 blur-[120px] rounded-full animate-float" />
            <div className="absolute bottom-[-10%] left-[-5%] w-[500px] h-[500px] bg-[#C0EB6A] opacity-20 blur-[100px] rounded-full animate-float" style={{ animationDelay: '2s' }} />

            <div className="w-full max-w-5xl relative z-10 flex flex-col md:flex-row gap-8 items-center justify-center p-4">

                {/* Branding Side (Desktop Left / Mobile Top) */}
                <div className="w-full md:w-1/2 text-center md:text-left space-y-6 md:pr-12">
                    <div className="inline-flex w-24 h-24 rounded-3xl bg-gradient-brand items-center justify-center shadow-2xl transform rotate-6 hover:rotate-0 transition-all duration-500 group animate-in zoom-in slide-in-from-left-4 duration-1000">
                        <Crown className="w-12 h-12 text-white drop-shadow-md group-hover:scale-110 transition-transform" />
                    </div>

                    <div className="space-y-4 animate-in fade-in slide-in-from-bottom-4 duration-1000 delay-200">
                        <h1 className="text-4xl md:text-6xl font-extrabold text-[#485550] tracking-tight">
                            UniVarse
                        </h1>
                        <p className="text-xl md:text-2xl font-medium text-[#6B7C6F]">
                            Super Admin Control Center
                        </p>
                        <p className="text-[#6B7C6F]/80 max-w-md mx-auto md:mx-0 leading-relaxed hidden md:block">
                            Manage institutions, monitor system health, and oversee global configurations from one centralized command deck.
                        </p>
                    </div>

                    <div className="hidden md:flex items-center gap-4 animate-in fade-in slide-in-from-bottom-8 duration-1000 delay-300">
                        <div className="px-4 py-2 rounded-full bg-white/50 border border-white/60 backdrop-blur-sm text-[#485550] text-sm font-medium shadow-sm flex items-center gap-2">
                            <Shield className="w-4 h-4 text-[#C0EB6A]" />
                            Secure Access
                        </div>
                        <div className="px-4 py-2 rounded-full bg-white/50 border border-white/60 backdrop-blur-sm text-[#485550] text-sm font-medium shadow-sm flex items-center gap-2">
                            <Lock className="w-4 h-4 text-[#C0EB6A]" />
                            2FA Protected
                        </div>
                    </div>
                </div>

                {/* Login Form Side (Desktop Right / Mobile Bottom) */}
                <div className="w-full md:w-[480px]">
                    <div className="morph-card p-8 md:p-10 shadow-2xl bg-white/80 backdrop-blur-xl">
                        <div className="text-center md:hidden mb-6">
                            <h2 className="text-2xl font-bold text-[#485550]">Welcome Back</h2>
                            <p className="text-sm text-[#6B7C6F]">Sign in to continue</p>
                        </div>

                        <form onSubmit={handleSubmit} className="space-y-6">
                            {/* Error Message */}
                            {error && (
                                <div className="flex items-center gap-3 p-4 rounded-xl bg-red-50 border border-red-100 text-red-600 text-sm animate-in fade-in slide-in-from-top-2">
                                    <AlertCircle className="w-5 h-5 shrink-0" />
                                    {error}
                                </div>
                            )}

                            {/* Email Field */}
                            <div className="space-y-2">
                                <Label htmlFor="email" className="text-[#485550] font-semibold ml-1">Email Address</Label>
                                <Input
                                    id="email"
                                    type="email"
                                    placeholder="admin@univarse.com"
                                    value={formData.email}
                                    onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                                    className="input-morph h-12"
                                    required
                                    disabled={isLoading}
                                />
                            </div>

                            {/* Password Field */}
                            <div className="space-y-2">
                                <div className="flex items-center justify-between">
                                    <Label htmlFor="password" className="text-[#485550] font-semibold ml-1">Password</Label>
                                    <button
                                        type="button"
                                        onClick={() => setShowForgotPassword(true)}
                                        className="text-xs font-medium text-[#6B7C6F] hover:text-[#485550] underline-offset-4 hover:underline transition-all"
                                    >
                                        Forgot Password?
                                    </button>
                                </div>
                                <div className="relative">
                                    <Input
                                        id="password"
                                        type={showPassword ? 'text' : 'password'}
                                        placeholder="••••••••"
                                        value={formData.password}
                                        onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                                        className="input-morph pr-12 h-12"
                                        required
                                        disabled={isLoading}
                                    />
                                    <button
                                        type="button"
                                        onClick={() => setShowPassword(!showPassword)}
                                        className="absolute right-4 top-1/2 -translate-y-1/2 text-[#6B7C6F] hover:text-[#485550] transition-colors"
                                    >
                                        {showPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                                    </button>
                                </div>
                            </div>

                            {/* Remember Me */}
                            <div className="flex items-center space-x-2">
                                <div className="flex items-center">
                                    <input
                                        id="rememberMe"
                                        type="checkbox"
                                        checked={rememberMe}
                                        onChange={(e) => setRememberMe(e.target.checked)}
                                        className="w-4 h-4 rounded border-[#D1DBC1] text-[#C0EB6A] focus:ring-[#C0EB6A]"
                                    />
                                    <Label htmlFor="rememberMe" className="ml-2 text-sm font-medium text-[#6B7C6F] cursor-pointer">
                                        Remember this device
                                    </Label>
                                </div>
                            </div>

                            {/* Submit Button */}
                            <Button
                                type="submit"
                                className="w-full btn-morph-primary h-14 text-lg font-bold mt-4 group shadow-lg shadow-[#C0EB6A]/20"
                                disabled={isLoading}
                            >
                                {isLoading ? (
                                    <>
                                        <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                                        Accessing...
                                    </>
                                ) : (
                                    <>
                                        Enter Control Center
                                        <ArrowRight className="w-5 h-5 ml-2 group-hover:translate-x-1 transition-transform" />
                                    </>
                                )}
                            </Button>
                        </form>

                        <div className="mt-8 text-center border-t border-[#F4F6F0] pt-6">
                            <span className="inline-block px-4 py-1.5 rounded-full bg-[#E8EDE0]/50 text-[#485550] text-[10px] font-mono tracking-wider border border-[#D1DBC1]/30">
                                SYSTEM v1.0.0 PROTECTED
                            </span>
                        </div>
                    </div>
                </div>
            </div>

            {/* 2FA Verification Dialog */}
            <Dialog open={show2FADialog} onOpenChange={(open) => !open && close2FADialog()}>
                <DialogContent className="sm:max-w-[420px] bg-[#F4F6F0] border border-white shadow-2xl rounded-[2rem] p-0 overflow-hidden">
                    <div className="p-8">
                        <DialogHeader className="mb-6">
                            <div className="mx-auto w-16 h-16 rounded-2xl bg-gradient-to-br from-[#C0EB6A] to-[#84cc16] flex items-center justify-center mb-4 shadow-lg animate-in zoom-in duration-300">
                                <Shield className="w-8 h-8 text-[#2A302D]" />
                            </div>
                            <DialogTitle className="text-center text-2xl font-bold text-[#485550]">Two-Factor Verify</DialogTitle>
                            <DialogDescription className="text-center text-[#6B7C6F]">
                                Enter the 6-digit code from your authenticator to proceed.
                            </DialogDescription>
                        </DialogHeader>

                        <div className="space-y-6">
                            {/* Error Message */}
                            {twoFactorError && (
                                <div className="flex items-center gap-3 p-3 rounded-xl bg-red-50 border border-red-100 text-red-600 text-sm animate-in slide-in-from-top-2">
                                    <AlertCircle className="w-5 h-5 shrink-0" />
                                    {twoFactorError}
                                </div>
                            )}

                            {/* 2FA Code Input */}
                            <div className="flex flex-col items-center space-y-3">
                                <Label htmlFor="twoFactorCode" className="text-[#485550] font-medium">Verification Code</Label>
                                <Input
                                    id="twoFactorCode"
                                    type="text"
                                    placeholder="000 000"
                                    value={twoFactorCode}
                                    onChange={(e) => setTwoFactorCode(e.target.value.replace(/\D/g, '').slice(0, 8))}
                                    className="input-morph text-center text-2xl font-mono tracking-[0.2em] h-14 w-full max-w-[240px]"
                                    maxLength={8}
                                    autoFocus
                                    disabled={is2FALoading}
                                />
                                <p className="text-xs text-[#6B7C6F]">
                                    Or use a recovery code if needed
                                </p>
                            </div>

                            <div className="space-y-3 pt-2">
                                {/* Verify Button */}
                                <Button
                                    onClick={handle2FAVerification}
                                    className="w-full btn-morph-primary h-12"
                                    disabled={is2FALoading || !twoFactorCode.trim()}
                                >
                                    {is2FALoading ? (
                                        <>
                                            <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                                            Verifying...
                                        </>
                                    ) : (
                                        <>
                                            <Key className="w-5 h-5 mr-2" />
                                            Verify & Login
                                        </>
                                    )}
                                </Button>

                                {/* Cancel Link */}
                                <button
                                    type="button"
                                    onClick={close2FADialog}
                                    className="w-full text-center text-sm font-medium text-[#6B7C6F] hover:text-[#485550] py-2 transition-colors"
                                    disabled={is2FALoading}
                                >
                                    Cancel and try again
                                </button>
                            </div>
                        </div>
                    </div>
                </DialogContent>
            </Dialog>

            {/* Forgot Password Dialog */}
            <Dialog open={showForgotPassword} onOpenChange={setShowForgotPassword}>
                <DialogContent className="sm:max-w-[420px] bg-[#F4F6F0] border border-white shadow-2xl rounded-[2rem] p-0 overflow-hidden">
                    <div className="p-8">
                        <DialogHeader className="mb-6">
                            <div className="mx-auto w-16 h-16 rounded-2xl bg-gradient-to-br from-blue-400 to-blue-600 flex items-center justify-center mb-4 shadow-lg animate-in zoom-in duration-300">
                                <Lock className="w-8 h-8 text-white" />
                            </div>
                            <DialogTitle className="text-center text-2xl font-bold text-[#485550]">Reset Password</DialogTitle>
                            <DialogDescription className="text-center text-[#6B7C6F]">
                                Enter your super admin email address to receive a secure reset link.
                            </DialogDescription>
                        </DialogHeader>

                        <form onSubmit={(e) => {
                            e.preventDefault();
                            handleForgotPassword(e);
                        }} className="space-y-6">
                            <div className="space-y-2">
                                <Label htmlFor="resetEmail" className="text-[#485550] font-medium">Email Address</Label>
                                <Input
                                    id="resetEmail"
                                    type="email"
                                    placeholder="admin@univarse.com"
                                    name="resetEmail"
                                    required
                                    className="input-morph"
                                    defaultValue={formData.email}
                                />
                            </div>

                            <div className="space-y-3 pt-2">
                                <Button
                                    type="submit"
                                    className="w-full btn-morph-primary h-12 bg-blue-600 hover:bg-blue-700 text-white"
                                >
                                    <Mail className="w-5 h-5 mr-2" />
                                    Send Reset Link
                                </Button>
                                <button
                                    type="button"
                                    onClick={() => setShowForgotPassword(false)}
                                    className="w-full text-center text-sm font-medium text-[#6B7C6F] hover:text-[#485550] py-2 transition-colors"
                                >
                                    Back to Login
                                </button>
                            </div>
                        </form>
                    </div>
                </DialogContent>
            </Dialog>
        </div>
    );
}
