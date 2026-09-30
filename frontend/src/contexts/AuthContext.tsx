'use client';

import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { api, User, TokenResponse } from '@/lib/api';

interface AuthContextType {
    user: User | null;
    isLoading: boolean;
    isAuthenticated: boolean;
    login: (email: string, password: string, institutionId: string) => Promise<void>;
    register: (data: RegisterData) => Promise<void>;
    logout: () => Promise<void>;
    refreshUser: () => Promise<void>;
}

interface RegisterData {
    email: string;
    password: string;
    firstName: string;
    lastName: string;
    role: string;
    institutionId: string;
    matricNumber?: string;
    staffId?: string;
    departmentId?: string;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
    const [user, setUser] = useState<User | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const router = useRouter();

    const refreshUser = useCallback(async () => {
        try {
            const storedUser = localStorage.getItem('user');
            const accessToken = localStorage.getItem('accessToken');

            if (storedUser && accessToken) {
                setUser(JSON.parse(storedUser));
                // Optionally refresh from server
                try {
                    const freshUser = await api.getMe();
                    setUser(freshUser);
                    localStorage.setItem('user', JSON.stringify(freshUser));
                } catch {
                    // Token might be expired, try refresh
                    try {
                        await api.refreshTokens();
                        const freshUser = await api.getMe();
                        setUser(freshUser);
                        localStorage.setItem('user', JSON.stringify(freshUser));
                    } catch {
                        // Refresh failed, logout
                        setUser(null);
                        localStorage.removeItem('user');
                        localStorage.removeItem('accessToken');
                        localStorage.removeItem('refreshToken');
                    }
                }
            }
        } catch (error) {
            console.error('Failed to refresh user:', error);
        } finally {
            setIsLoading(false);
        }
    }, []);

    useEffect(() => {
        refreshUser();
    }, [refreshUser]);

    const login = async (email: string, password: string, institutionId: string) => {
        const response = await api.login(email, password, institutionId);
        setUser(response.user);

        // Redirect based on role
        const dashboardPath = getDashboardPath(response.user.role);
        router.push(dashboardPath);
    };

    const register = async (data: RegisterData) => {
        const response = await api.register(data);
        setUser(response.user);

        // Redirect to appropriate dashboard
        const dashboardPath = getDashboardPath(response.user.role);
        router.push(dashboardPath);
    };

    const logout = async () => {
        try {
            await api.logout();
        } finally {
            setUser(null);
            router.push('/login');
        }
    };

    return (
        <AuthContext.Provider
            value={{
                user,
                isLoading,
                isAuthenticated: !!user,
                login,
                register,
                logout,
                refreshUser,
            }}
        >
            {children}
        </AuthContext.Provider>
    );
}

export function useAuth() {
    const context = useContext(AuthContext);
    if (context === undefined) {
        throw new Error('useAuth must be used within an AuthProvider');
    }
    return context;
}

function getDashboardPath(role: string): string {
    switch (role) {
        case 'STUDENT':
            return '/student';
        case 'LECTURER':
            return '/lecturer';
        case 'HOD':
            return '/hod';
        case 'DEAN':
            return '/dean';
        case 'ICT_ADMIN':
            return '/it-admin';
        case 'SUPER_ADMIN':
            return '/super-admin';
        default:
            return '/student';
    }
}
