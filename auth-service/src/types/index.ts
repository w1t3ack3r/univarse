import { Role, UserStatus } from '@prisma/client';
import { Request } from 'express';

export interface JWTPayload {
    userId: string;
    email: string;
    role: Role;
    institutionId: string | null; // null for SUPER_ADMIN (platform-level admins)
}

export interface AuthenticatedRequest extends Request {
    user?: JWTPayload;
}

export interface RegisterDTO {
    email: string;
    password: string;
    firstName: string;
    lastName: string;
    middleName?: string;
    phone?: string;
    role: Role;
    institutionId?: string; // Optional for SUPER_ADMIN
    departmentId?: string;
    facultyId?: string;
    // Student specific
    matricNumber?: string;
    level?: number;
    enrollmentYear?: number;
    // Lecturer specific
    staffId?: string;
    title?: string;
    rank?: string;
    specialization?: string;
}

export interface LoginDTO {
    email: string;
    password: string;
    institutionId?: string; // Optional for SUPER_ADMIN
}

export interface TokenResponse {
    accessToken: string;
    refreshToken: string;
    expiresIn: string;
    user: SafeUser;
    mustChangePassword?: boolean;
}

export interface SafeUser {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
    middleName: string | null;
    phone: string | null;
    avatar: string | null;
    role: Role;
    status: UserStatus;
    institutionId: string | null; // null for SUPER_ADMIN
    departmentId: string | null;
    facultyId: string | null;
}

export interface ApiResponse<T = any> {
    success: boolean;
    message: string;
    data?: T;
    errors?: any[];
}

export interface PaginationParams {
    page?: number;
    limit?: number;
    sortBy?: string;
    sortOrder?: 'asc' | 'desc';
}

export interface PaginatedResponse<T> {
    data: T[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
}
