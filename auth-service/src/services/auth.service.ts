import { Role, UserStatus, AuditAction } from '@prisma/client';
import prisma from '../config/database';
import { config } from '../config';
import {
    RegisterDTO,
    LoginDTO,
    TokenResponse,
    SafeUser,
    JWTPayload
} from '../types';
import {
    hashPassword,
    comparePassword,
    generateAccessToken,
    generateRefreshToken,
    verifyRefreshToken,
    generateRandomToken,
    getExpirationDate,
} from '../utils/auth';
import {
    BadRequestError,
    ConflictError,
    NotFoundError,
    UnauthorizedError,
} from '../utils/errors';
import { auditService } from './audit.service';

export class AuthService {
    /**
     * Register a new user
     */
    async register(data: RegisterDTO, ipAddress?: string, userAgent?: string): Promise<TokenResponse> {
        const isSuperAdmin = data.role === Role.SUPER_ADMIN;

        // For non-SUPER_ADMIN, institution is required
        if (!isSuperAdmin) {
            if (!data.institutionId) {
                throw new BadRequestError('Institution is required');
            }

            // Check if institution exists
            const institution = await prisma.institution.findUnique({
                where: { id: data.institutionId },
            });

            if (!institution) {
                throw new NotFoundError('Institution not found');
            }

            // Check if user already exists in this institution
            const existingUser = await prisma.user.findFirst({
                where: {
                    email: data.email,
                    institutionId: data.institutionId,
                },
            });

            if (existingUser) {
                throw new ConflictError('User with this email already exists in this institution');
            }

            // Validate department and faculty if provided
            if (data.departmentId) {
                const department = await prisma.department.findFirst({
                    where: { id: data.departmentId, institutionId: data.institutionId },
                });
                if (!department) {
                    throw new BadRequestError('Invalid department');
                }
            }

            if (data.facultyId) {
                const faculty = await prisma.faculty.findFirst({
                    where: { id: data.facultyId, institutionId: data.institutionId },
                });
                if (!faculty) {
                    throw new BadRequestError('Invalid faculty');
                }
            }
        } else {
            // SUPER_ADMIN - check for globally unique email
            const existingSuperAdmin = await prisma.user.findFirst({
                where: {
                    email: data.email,
                    role: Role.SUPER_ADMIN,
                },
            });

            if (existingSuperAdmin) {
                throw new ConflictError('Super Admin with this email already exists');
            }
        }

        // Hash password
        const hashedPassword = await hashPassword(data.password);

        // Create user with profile in transaction
        const user = await prisma.$transaction(async (tx) => {
            const newUser = await tx.user.create({
                data: {
                    email: data.email,
                    password: hashedPassword,
                    firstName: data.firstName,
                    lastName: data.lastName,
                    middleName: data.middleName,
                    phone: data.phone,
                    role: data.role,
                    status: isSuperAdmin ? UserStatus.ACTIVE : UserStatus.PENDING_VERIFICATION,
                    institutionId: isSuperAdmin ? null : data.institutionId!,
                    departmentId: isSuperAdmin ? null : data.departmentId,
                    facultyId: isSuperAdmin ? null : data.facultyId,
                },
            });

            // Create role-specific profile (not for SUPER_ADMIN)
            if (data.role === Role.STUDENT && data.matricNumber) {
                await tx.studentProfile.create({
                    data: {
                        matricNumber: data.matricNumber,
                        level: data.level || 100,
                        enrollmentYear: data.enrollmentYear || new Date().getFullYear(),
                        userId: newUser.id,
                    },
                });
            }

            if ((data.role === Role.LECTURER || data.role === Role.HOD || data.role === Role.DEAN) && data.staffId) {
                await tx.lecturerProfile.create({
                    data: {
                        staffId: data.staffId,
                        title: data.title,
                        rank: data.rank,
                        specialization: data.specialization,
                        userId: newUser.id,
                    },
                });
            }

            return newUser;
        });

        // Generate tokens
        const tokenPayload: JWTPayload = {
            userId: user.id,
            email: user.email,
            role: user.role,
            institutionId: user.institutionId,
        };

        const accessToken = generateAccessToken(tokenPayload);
        const refreshToken = generateRefreshToken(tokenPayload);

        // Save refresh token
        await prisma.refreshToken.create({
            data: {
                token: refreshToken,
                userId: user.id,
                expiresAt: getExpirationDate(config.jwt.refreshExpiresIn),
            },
        });

        // Audit log
        await auditService.log({
            action: AuditAction.REGISTER,
            description: `New ${data.role} registered`,
            userId: user.id,
            institutionId: user.institutionId,
            ipAddress,
            userAgent,
        });

        return {
            accessToken,
            refreshToken,
            expiresIn: config.jwt.expiresIn,
            user: this.sanitizeUser(user),
        };
    }

    /**
     * Login user
     */
    async login(data: LoginDTO, ipAddress?: string, userAgent?: string): Promise<TokenResponse> {
        let user;
        let tenantPrisma = prisma; // Default to local prisma

        // Check if this is a SUPER_ADMIN login (no institution required)
        if (!data.institutionId) {
            // SUPER_ADMIN login - find by email where institutionId is null
            user = await prisma.user.findFirst({
                where: {
                    email: data.email,
                    role: Role.SUPER_ADMIN,
                    institutionId: { equals: null },
                },
            });
        } else {
            // Regular user login - lookup institution from master DB and connect to tenant
            const { masterDb } = await import('../config/master-db');
            const { tenantConnectionManager } = await import('../config/tenant-db');

            const institution = await masterDb.institution.findUnique({
                where: { id: data.institutionId },
            });

            if (!institution) {
                throw new NotFoundError('Institution not found');
            }

            if (!institution.isProvisioned) {
                throw new BadRequestError('This institution is not yet activated. Please contact support.');
            }

            // Check institution status for lifecycle states
            if (institution.status === 'SUSPENDED') {
                throw new BadRequestError('This institution is currently suspended. Please contact your IT Administrator.');
            }

            if (institution.status === 'PENDING_DELETION') {
                throw new BadRequestError('This institution is scheduled for deletion. Please contact support if you believe this is an error.');
            }

            if (!institution.isActive) {
                throw new BadRequestError('This institution is currently inactive.');
            }

            // Connect to tenant database
            tenantPrisma = await tenantConnectionManager.getConnection({
                id: institution.id,
                subdomain: institution.subdomain,
                dbHost: institution.dbHost,
                dbPort: institution.dbPort,
                dbName: institution.dbName,
                dbUser: institution.dbUser,
                dbPassword: institution.dbPassword,
            });

            // Find user in tenant database
            user = await tenantPrisma.user.findFirst({
                where: {
                    email: data.email,
                    institutionId: data.institutionId,
                },
            });
        }

        if (!user) {
            throw new UnauthorizedError('Invalid email or password');
        }

        // Check password
        const isValidPassword = await comparePassword(data.password, user.password);
        if (!isValidPassword) {
            throw new UnauthorizedError('Invalid email or password');
        }

        // Check user status
        if (user.status === UserStatus.SUSPENDED) {
            throw new UnauthorizedError('Account has been suspended');
        }

        if (user.status === UserStatus.INACTIVE) {
            throw new UnauthorizedError('Account is inactive');
        }

        // Check if temp password has expired
        if (user.mustChangePassword && user.tempPasswordExpiresAt && new Date() > user.tempPasswordExpiresAt) {
            throw new UnauthorizedError('Temporary password has expired. Please contact admin.');
        }

        // Update last login
        await tenantPrisma.user.update({
            where: { id: user.id },
            data: { lastLoginAt: new Date() },
        });

        // If user must change password, return limited response
        if (user.mustChangePassword) {
            // Generate a short-lived token just for password change
            const tokenPayload: JWTPayload = {
                userId: user.id,
                email: user.email,
                role: user.role,
                institutionId: user.institutionId,
            };

            const tempAccessToken = generateAccessToken(tokenPayload);

            // Audit log
            await auditService.log({
                action: AuditAction.LOGIN,
                description: 'User logged in - requires password change',
                userId: user.id,
                institutionId: user.institutionId,
                ipAddress,
                userAgent,
            });

            return {
                accessToken: tempAccessToken,
                refreshToken: '',
                expiresIn: config.jwt.expiresIn,
                user: this.sanitizeUser(user),
                mustChangePassword: true,
            };
        }

        // Generate tokens
        const tokenPayload: JWTPayload = {
            userId: user.id,
            email: user.email,
            role: user.role,
            institutionId: user.institutionId,
        };

        const accessToken = generateAccessToken(tokenPayload);
        const refreshToken = generateRefreshToken(tokenPayload);

        // Save refresh token
        await prisma.refreshToken.create({
            data: {
                token: refreshToken,
                userId: user.id,
                expiresAt: getExpirationDate(config.jwt.refreshExpiresIn),
            },
        });

        // Audit log
        await auditService.log({
            action: AuditAction.LOGIN,
            description: 'User logged in',
            userId: user.id,
            institutionId: user.institutionId,
            ipAddress,
            userAgent,
        });

        return {
            accessToken,
            refreshToken,
            expiresIn: config.jwt.expiresIn,
            user: this.sanitizeUser(user),
            mustChangePassword: false,
        };
    }

    /**
     * Logout user - revoke refresh token
     */
    async logout(refreshToken: string, userId: string, ipAddress?: string, userAgent?: string): Promise<void> {
        const token = await prisma.refreshToken.findFirst({
            where: { token: refreshToken, userId },
        });

        if (token) {
            await prisma.refreshToken.update({
                where: { id: token.id },
                data: { revokedAt: new Date() },
            });
        }

        const user = await prisma.user.findUnique({ where: { id: userId } });

        // Audit log
        await auditService.log({
            action: AuditAction.LOGOUT,
            description: 'User logged out',
            userId,
            institutionId: user?.institutionId,
            ipAddress,
            userAgent,
        });
    }

    /**
     * Refresh access token
     */
    async refreshTokens(refreshToken: string): Promise<{ accessToken: string; refreshToken: string }> {
        // Verify token
        let payload: JWTPayload;
        try {
            payload = verifyRefreshToken(refreshToken);
        } catch {
            throw new UnauthorizedError('Invalid refresh token');
        }

        // Check if token exists and is not revoked
        const storedToken = await prisma.refreshToken.findFirst({
            where: {
                token: refreshToken,
                userId: payload.userId,
                revokedAt: null,
                expiresAt: { gt: new Date() },
            },
        });

        if (!storedToken) {
            throw new UnauthorizedError('Refresh token is invalid or expired');
        }

        // Get user for fresh data
        const user = await prisma.user.findUnique({
            where: { id: payload.userId },
        });

        if (!user || user.status !== UserStatus.ACTIVE) {
            throw new UnauthorizedError('User account is not active');
        }

        // Revoke old refresh token
        await prisma.refreshToken.update({
            where: { id: storedToken.id },
            data: { revokedAt: new Date() },
        });

        // Generate new tokens
        const newPayload: JWTPayload = {
            userId: user.id,
            email: user.email,
            role: user.role,
            institutionId: user.institutionId,
        };

        const newAccessToken = generateAccessToken(newPayload);
        const newRefreshToken = generateRefreshToken(newPayload);

        // Save new refresh token
        await prisma.refreshToken.create({
            data: {
                token: newRefreshToken,
                userId: user.id,
                expiresAt: getExpirationDate(config.jwt.refreshExpiresIn),
            },
        });

        return {
            accessToken: newAccessToken,
            refreshToken: newRefreshToken,
        };
    }

    /**
     * Request password reset
     */
    async requestPasswordReset(email: string, institutionId: string): Promise<string> {
        const user = await prisma.user.findUnique({
            where: {
                email_institutionId: { email, institutionId },
            },
        });

        if (!user) {
            // Return silently to prevent email enumeration
            return 'If the email exists, a reset link has been sent';
        }

        // Generate reset token
        const resetToken = generateRandomToken();
        const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

        await prisma.passwordReset.create({
            data: {
                token: resetToken,
                userId: user.id,
                expiresAt,
            },
        });

        // TODO: Send email with reset link
        // For now, return token (in production, this would be sent via email)
        console.log(`Password reset token for ${email}: ${resetToken}`);

        return 'If the email exists, a reset link has been sent';
    }

    /**
     * Reset password with token
     */
    async resetPassword(token: string, newPassword: string, ipAddress?: string, userAgent?: string): Promise<void> {
        const resetRecord = await prisma.passwordReset.findFirst({
            where: {
                token,
                usedAt: null,
                expiresAt: { gt: new Date() },
            },
            include: { user: true },
        });

        if (!resetRecord) {
            throw new BadRequestError('Invalid or expired reset token');
        }

        const hashedPassword = await hashPassword(newPassword);

        await prisma.$transaction([
            prisma.user.update({
                where: { id: resetRecord.userId },
                data: { password: hashedPassword },
            }),
            prisma.passwordReset.update({
                where: { id: resetRecord.id },
                data: { usedAt: new Date() },
            }),
            // Revoke all refresh tokens
            prisma.refreshToken.updateMany({
                where: { userId: resetRecord.userId, revokedAt: null },
                data: { revokedAt: new Date() },
            }),
        ]);

        // Audit log
        await auditService.log({
            action: AuditAction.PASSWORD_RESET,
            description: 'Password reset completed',
            userId: resetRecord.userId,
            institutionId: resetRecord.user.institutionId,
            ipAddress,
            userAgent,
        });
    }

    /**
     * Get user by ID
     */
    async getUserById(userId: string): Promise<SafeUser | null> {
        const user = await prisma.user.findUnique({
            where: { id: userId },
        });

        return user ? this.sanitizeUser(user) : null;
    }

    /**
     * Get user with profiles
     */
    async getUserWithProfiles(userId: string) {
        return prisma.user.findUnique({
            where: { id: userId },
            include: {
                studentProfile: true,
                lecturerProfile: true,
                department: true,
                faculty: true,
                institution: {
                    select: {
                        id: true,
                        name: true,
                        code: true,
                        logo: true,
                    },
                },
            },
        });
    }

    /**
     * Change password on first login (for temporary passwords)
     */
    async changePasswordFirstLogin(
        userId: string,
        currentPassword: string,
        newPassword: string,
        ipAddress?: string,
        userAgent?: string
    ): Promise<TokenResponse> {
        const user = await prisma.user.findUnique({
            where: { id: userId },
        });

        if (!user) {
            throw new NotFoundError('User not found');
        }

        if (!user.mustChangePassword) {
            throw new BadRequestError('Password change not required');
        }

        // Verify current password
        const isValidPassword = await comparePassword(currentPassword, user.password);
        if (!isValidPassword) {
            throw new UnauthorizedError('Current password is incorrect');
        }

        // Hash new password
        const hashedPassword = await hashPassword(newPassword);

        // Update password and clear mustChangePassword flag
        await prisma.user.update({
            where: { id: userId },
            data: {
                password: hashedPassword,
                mustChangePassword: false,
                tempPasswordExpiresAt: null,
                status: UserStatus.ACTIVE,
            },
        });

        // Generate full tokens now
        const tokenPayload: JWTPayload = {
            userId: user.id,
            email: user.email,
            role: user.role,
            institutionId: user.institutionId,
        };

        const accessToken = generateAccessToken(tokenPayload);
        const refreshToken = generateRefreshToken(tokenPayload);

        // Save refresh token
        await prisma.refreshToken.create({
            data: {
                token: refreshToken,
                userId: user.id,
                expiresAt: getExpirationDate(config.jwt.refreshExpiresIn),
            },
        });

        // Audit log
        await auditService.log({
            action: AuditAction.PASSWORD_CHANGE,
            description: 'First-time password change completed',
            userId: user.id,
            institutionId: user.institutionId,
            ipAddress,
            userAgent,
        });

        return {
            accessToken,
            refreshToken,
            expiresIn: config.jwt.expiresIn,
            user: this.sanitizeUser({ ...user, mustChangePassword: false, status: UserStatus.ACTIVE }),
            mustChangePassword: false,
        };
    }

    /**
     * Remove sensitive data from user object
     */
    private sanitizeUser(user: any): SafeUser {
        return {
            id: user.id,
            email: user.email,
            firstName: user.firstName,
            lastName: user.lastName,
            middleName: user.middleName,
            phone: user.phone,
            avatar: user.avatar,
            role: user.role,
            status: user.status,
            institutionId: user.institutionId,
            departmentId: user.departmentId,
            facultyId: user.facultyId,
        };
    }
}

export const authService = new AuthService();
