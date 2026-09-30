'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { api, Institution } from '@/lib/api';

type RoleType = 'STUDENT' | 'LECTURER';

export default function RegisterPage() {
    const [formData, setFormData] = useState({
        email: '',
        password: '',
        confirmPassword: '',
        firstName: '',
        lastName: '',
        role: 'STUDENT' as RoleType,
        institutionId: '',
        matricNumber: '',
        staffId: '',
    });
    const [institutions, setInstitutions] = useState<Institution[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState('');
    const [step, setStep] = useState(1);

    const { register, isAuthenticated } = useAuth();
    const router = useRouter();

    useEffect(() => {
        if (isAuthenticated) {
            router.push('/student');
        }
    }, [isAuthenticated, router]);

    useEffect(() => {
        const loadInstitutions = async () => {
            const data = await api.getInstitutions();
            setInstitutions(data);
            if (data.length > 0) {
                setFormData(prev => ({ ...prev, institutionId: data[0].id }));
            }
        };
        loadInstitutions();
    }, []);

    const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
        setFormData({ ...formData, [e.target.name]: e.target.value });
    };

    const validateStep1 = () => {
        if (!formData.institutionId || !formData.role) {
            setError('Please select an institution and role');
            return false;
        }
        return true;
    };

    const validateStep2 = () => {
        if (!formData.firstName || !formData.lastName || !formData.email) {
            setError('Please fill in all required fields');
            return false;
        }
        if (formData.role === 'STUDENT' && !formData.matricNumber) {
            setError('Matric number is required for students');
            return false;
        }
        if (formData.role === 'LECTURER' && !formData.staffId) {
            setError('Staff ID is required for lecturers');
            return false;
        }
        return true;
    };

    const validateStep3 = () => {
        if (formData.password.length < 8) {
            setError('Password must be at least 8 characters');
            return false;
        }
        if (formData.password !== formData.confirmPassword) {
            setError('Passwords do not match');
            return false;
        }
        if (!/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/.test(formData.password)) {
            setError('Password must contain uppercase, lowercase, and number');
            return false;
        }
        return true;
    };

    const nextStep = () => {
        setError('');
        if (step === 1 && validateStep1()) setStep(2);
        else if (step === 2 && validateStep2()) setStep(3);
    };

    const prevStep = () => {
        setError('');
        setStep(step - 1);
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError('');

        if (!validateStep3()) return;

        setIsLoading(true);
        try {
            await register({
                email: formData.email,
                password: formData.password,
                firstName: formData.firstName,
                lastName: formData.lastName,
                role: formData.role,
                institutionId: formData.institutionId,
                matricNumber: formData.role === 'STUDENT' ? formData.matricNumber : undefined,
                staffId: formData.role === 'LECTURER' ? formData.staffId : undefined,
            });
        } catch (err: any) {
            setError(err.message || 'Registration failed. Please try again.');
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <div className="min-h-screen relative overflow-hidden">
            {/* Animated Background */}
            <div className="absolute inset-0 bg-gradient-to-br from-slate-900 via-purple-900 to-slate-900">
                <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-purple-500/30 rounded-full filter blur-3xl animate-pulse"></div>
                <div className="absolute bottom-1/4 right-1/4 w-96 h-96 bg-indigo-500/30 rounded-full filter blur-3xl animate-pulse" style={{ animationDelay: '1s' }}></div>
                <div className="absolute inset-0 opacity-10" style={{
                    backgroundImage: `linear-gradient(rgba(255,255,255,0.1) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.1) 1px, transparent 1px)`,
                    backgroundSize: '50px 50px'
                }}></div>
            </div>

            {/* Content */}
            <div className="relative z-10 min-h-screen flex items-center justify-center p-6">
                <div className="w-full max-w-lg">
                    {/* Logo */}
                    <div className="text-center mb-8">
                        <Link href="/" className="inline-flex items-center space-x-3">
                            <div className="w-12 h-12 bg-gradient-to-br from-violet-500 to-indigo-600 rounded-xl flex items-center justify-center shadow-lg shadow-violet-500/30">
                                <svg className="w-7 h-7 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
                                </svg>
                            </div>
                            <span className="text-3xl font-bold text-white">UniVarse</span>
                        </Link>
                    </div>

                    {/* Registration Card */}
                    <div className="bg-white/10 backdrop-blur-xl border border-white/20 rounded-3xl p-8 shadow-2xl">
                        <div className="text-center mb-8">
                            <h2 className="text-2xl font-bold text-white mb-2">Create Account</h2>
                            <p className="text-white/60">Join UniVarse and start your journey</p>
                        </div>

                        {/* Progress Steps */}
                        <div className="flex items-center justify-center mb-8">
                            {[1, 2, 3].map((s) => (
                                <div key={s} className="flex items-center">
                                    <div className={`w-10 h-10 rounded-full flex items-center justify-center font-semibold transition-all duration-300 ${step >= s
                                            ? 'bg-gradient-to-r from-violet-500 to-indigo-500 text-white shadow-lg shadow-violet-500/30'
                                            : 'bg-white/10 text-white/40'
                                        }`}>
                                        {s}
                                    </div>
                                    {s < 3 && (
                                        <div className={`w-12 h-1 mx-2 rounded transition-all duration-300 ${step > s ? 'bg-gradient-to-r from-violet-500 to-indigo-500' : 'bg-white/10'
                                            }`}></div>
                                    )}
                                </div>
                            ))}
                        </div>

                        {error && (
                            <div className="mb-6 p-4 bg-red-500/20 border border-red-500/30 rounded-xl text-red-200 text-sm">
                                {error}
                            </div>
                        )}

                        <form onSubmit={handleSubmit}>
                            {/* Step 1: Institution & Role */}
                            {step === 1 && (
                                <div className="space-y-5 animate-fadeIn">
                                    <div>
                                        <label className="block text-sm font-medium text-white/80 mb-2">Institution</label>
                                        <select
                                            name="institutionId"
                                            value={formData.institutionId}
                                            onChange={handleChange}
                                            className="w-full px-4 py-3.5 bg-white/5 border border-white/10 rounded-xl text-white appearance-none cursor-pointer transition-all duration-300 focus:outline-none focus:ring-2 focus:ring-violet-500/50"
                                            required
                                        >
                                            {institutions.map((inst) => (
                                                <option key={inst.id} value={inst.id} className="bg-slate-800">
                                                    {inst.name}
                                                </option>
                                            ))}
                                        </select>
                                    </div>

                                    <div>
                                        <label className="block text-sm font-medium text-white/80 mb-2">I am a</label>
                                        <div className="grid grid-cols-2 gap-4">
                                            {(['STUDENT', 'LECTURER'] as RoleType[]).map((role) => (
                                                <button
                                                    key={role}
                                                    type="button"
                                                    onClick={() => setFormData({ ...formData, role })}
                                                    className={`p-4 rounded-xl border-2 transition-all duration-300 ${formData.role === role
                                                            ? 'border-violet-500 bg-violet-500/20 text-white'
                                                            : 'border-white/10 bg-white/5 text-white/60 hover:border-white/20'
                                                        }`}
                                                >
                                                    <div className="text-2xl mb-2">{role === 'STUDENT' ? '🎓' : '👨‍🏫'}</div>
                                                    <div className="font-medium">{role === 'STUDENT' ? 'Student' : 'Lecturer'}</div>
                                                </button>
                                            ))}
                                        </div>
                                    </div>
                                </div>
                            )}

                            {/* Step 2: Personal Info */}
                            {step === 2 && (
                                <div className="space-y-5 animate-fadeIn">
                                    <div className="grid grid-cols-2 gap-4">
                                        <div>
                                            <label className="block text-sm font-medium text-white/80 mb-2">First Name</label>
                                            <input
                                                type="text"
                                                name="firstName"
                                                value={formData.firstName}
                                                onChange={handleChange}
                                                className="w-full px-4 py-3.5 bg-white/5 border border-white/10 rounded-xl text-white placeholder-white/40 focus:outline-none focus:ring-2 focus:ring-violet-500/50"
                                                required
                                            />
                                        </div>
                                        <div>
                                            <label className="block text-sm font-medium text-white/80 mb-2">Last Name</label>
                                            <input
                                                type="text"
                                                name="lastName"
                                                value={formData.lastName}
                                                onChange={handleChange}
                                                className="w-full px-4 py-3.5 bg-white/5 border border-white/10 rounded-xl text-white placeholder-white/40 focus:outline-none focus:ring-2 focus:ring-violet-500/50"
                                                required
                                            />
                                        </div>
                                    </div>

                                    <div>
                                        <label className="block text-sm font-medium text-white/80 mb-2">Email Address</label>
                                        <input
                                            type="email"
                                            name="email"
                                            value={formData.email}
                                            onChange={handleChange}
                                            className="w-full px-4 py-3.5 bg-white/5 border border-white/10 rounded-xl text-white placeholder-white/40 focus:outline-none focus:ring-2 focus:ring-violet-500/50"
                                            required
                                        />
                                    </div>

                                    {formData.role === 'STUDENT' ? (
                                        <div>
                                            <label className="block text-sm font-medium text-white/80 mb-2">Matric Number</label>
                                            <input
                                                type="text"
                                                name="matricNumber"
                                                value={formData.matricNumber}
                                                onChange={handleChange}
                                                placeholder="e.g., 2020/CSC/001"
                                                className="w-full px-4 py-3.5 bg-white/5 border border-white/10 rounded-xl text-white placeholder-white/40 focus:outline-none focus:ring-2 focus:ring-violet-500/50"
                                                required
                                            />
                                        </div>
                                    ) : (
                                        <div>
                                            <label className="block text-sm font-medium text-white/80 mb-2">Staff ID</label>
                                            <input
                                                type="text"
                                                name="staffId"
                                                value={formData.staffId}
                                                onChange={handleChange}
                                                placeholder="e.g., STF/001"
                                                className="w-full px-4 py-3.5 bg-white/5 border border-white/10 rounded-xl text-white placeholder-white/40 focus:outline-none focus:ring-2 focus:ring-violet-500/50"
                                                required
                                            />
                                        </div>
                                    )}
                                </div>
                            )}

                            {/* Step 3: Password */}
                            {step === 3 && (
                                <div className="space-y-5 animate-fadeIn">
                                    <div>
                                        <label className="block text-sm font-medium text-white/80 mb-2">Password</label>
                                        <input
                                            type="password"
                                            name="password"
                                            value={formData.password}
                                            onChange={handleChange}
                                            placeholder="Min. 8 characters"
                                            className="w-full px-4 py-3.5 bg-white/5 border border-white/10 rounded-xl text-white placeholder-white/40 focus:outline-none focus:ring-2 focus:ring-violet-500/50"
                                            required
                                        />
                                        <p className="mt-2 text-xs text-white/40">Must include uppercase, lowercase, and number</p>
                                    </div>

                                    <div>
                                        <label className="block text-sm font-medium text-white/80 mb-2">Confirm Password</label>
                                        <input
                                            type="password"
                                            name="confirmPassword"
                                            value={formData.confirmPassword}
                                            onChange={handleChange}
                                            className="w-full px-4 py-3.5 bg-white/5 border border-white/10 rounded-xl text-white placeholder-white/40 focus:outline-none focus:ring-2 focus:ring-violet-500/50"
                                            required
                                        />
                                    </div>

                                    <div className="flex items-start space-x-3">
                                        <input type="checkbox" required className="mt-1 w-4 h-4 rounded border-white/20 bg-white/5 text-violet-600" />
                                        <span className="text-sm text-white/60">
                                            I agree to the <a href="#" className="text-violet-400 hover:underline">Terms of Service</a> and{' '}
                                            <a href="#" className="text-violet-400 hover:underline">Privacy Policy</a>
                                        </span>
                                    </div>
                                </div>
                            )}

                            {/* Navigation Buttons */}
                            <div className="flex justify-between mt-8">
                                {step > 1 && (
                                    <button
                                        type="button"
                                        onClick={prevStep}
                                        className="px-6 py-3 bg-white/10 text-white rounded-xl hover:bg-white/20 transition-all"
                                    >
                                        Back
                                    </button>
                                )}
                                {step < 3 ? (
                                    <button
                                        type="button"
                                        onClick={nextStep}
                                        className="ml-auto px-6 py-3 bg-gradient-to-r from-violet-600 to-indigo-600 text-white font-semibold rounded-xl shadow-lg shadow-violet-500/25 hover:shadow-xl transition-all"
                                    >
                                        Continue
                                    </button>
                                ) : (
                                    <button
                                        type="submit"
                                        disabled={isLoading}
                                        className="ml-auto px-8 py-3 bg-gradient-to-r from-violet-600 to-indigo-600 text-white font-semibold rounded-xl shadow-lg shadow-violet-500/25 hover:shadow-xl transition-all disabled:opacity-50"
                                    >
                                        {isLoading ? 'Creating Account...' : 'Create Account'}
                                    </button>
                                )}
                            </div>
                        </form>

                        <p className="mt-8 text-center text-white/60">
                            Already have an account?{' '}
                            <Link href="/login" className="text-violet-400 hover:text-violet-300 font-medium">
                                Sign in
                            </Link>
                        </p>
                    </div>
                </div>
            </div>

            <style jsx>{`
        @keyframes fadeIn {
          from { opacity: 0; transform: translateY(10px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .animate-fadeIn {
          animation: fadeIn 0.3s ease-out;
        }
      `}</style>
        </div>
    );
}
