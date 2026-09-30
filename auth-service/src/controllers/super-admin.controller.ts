// Super Admin Controller
// Handles platform-level administration

import { Request, Response, NextFunction } from 'express';
import { validationResult } from 'express-validator';
import { masterDb } from '../config/master-db';
import { tenantConnectionManager } from '../config/tenant-db';
import { hashPassword, comparePassword, generateAccessToken } from '../utils/auth';
import { successResponse } from '../utils/errors';
import { encryptDbPassword, decryptDbPassword } from '../utils/encryption';
import { backupService } from '../services/backup.service';
import { twoFactorService } from '../services/2fa.service';
import { emailService } from '../services/email.service';

export class SuperAdminController {
    /**
     * Super Admin Login
     * POST /super-admin/login
     */
    async login(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                res.status(400).json({ success: false, errors: errors.array() });
                return;
            }

            const { email, password } = req.body;

            const admin = await masterDb.superAdmin.findUnique({ where: { email } });
            if (!admin) {
                res.status(401).json({ success: false, message: 'Invalid credentials' });
                return;
            }

            const isValid = await comparePassword(password, admin.password);
            if (!isValid) {
                res.status(401).json({ success: false, message: 'Invalid credentials' });
                return;
            }

            if (!admin.isActive) {
                res.status(403).json({ success: false, message: 'Account is inactive' });
                return;
            }

            // Check IP Whitelist
            if (admin.ipWhitelistEnabled && admin.ipWhitelist.length > 0) {
                const clientIP = req.ip?.replace('::ffff:', '') || '';
                if (!admin.ipWhitelist.includes(clientIP)) {
                    res.status(403).json({
                        success: false,
                        message: 'Access denied. Your IP address is not whitelisted.',
                    });
                    return;
                }
            }

            // Check if 2FA is enabled
            if (admin.twoFactorEnabled && admin.twoFactorVerified) {
                // Return requires2FA flag - don't issue token yet
                res.json(successResponse('2FA verification required', {
                    requires2FA: true,
                    email: admin.email,
                    message: 'Please enter your 2FA code to complete login',
                }));
                return;
            }

            // Update last login
            await masterDb.superAdmin.update({
                where: { id: admin.id },
                data: { lastLoginAt: new Date() },
            });

            // Generate token
            const token = generateAccessToken({
                userId: admin.id,
                email: admin.email,
                role: 'SUPER_ADMIN',
                institutionId: null,
            });

            // Create session
            const crypto = require('crypto');
            const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
            const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

            await masterDb.superAdminSession.create({
                data: {
                    superAdminId: admin.id,
                    tokenHash,
                    ipAddress: req.ip || 'unknown',
                    userAgent: req.headers['user-agent'] || null,
                    deviceInfo: this.parseUserAgent(req.headers['user-agent']),
                    expiresAt,
                },
            });

            res.json(successResponse('Login successful', {
                accessToken: token,
                user: {
                    id: admin.id,
                    email: admin.email,
                    firstName: admin.firstName,
                    lastName: admin.lastName,
                    role: 'SUPER_ADMIN',
                    twoFactorEnabled: admin.twoFactorEnabled,
                },
            }));
        } catch (error) {
            next(error);
        }
    }

    /**
     * Parse User-Agent to get device info
     */
    private parseUserAgent(ua?: string): string | null {
        if (!ua) return null;

        // Simple parsing - extract browser and OS
        let browser = 'Unknown Browser';
        let os = 'Unknown OS';

        if (ua.includes('Chrome')) browser = 'Chrome';
        else if (ua.includes('Firefox')) browser = 'Firefox';
        else if (ua.includes('Safari')) browser = 'Safari';
        else if (ua.includes('Edge')) browser = 'Edge';

        if (ua.includes('Windows')) os = 'Windows';
        else if (ua.includes('Mac')) os = 'macOS';
        else if (ua.includes('Linux')) os = 'Linux';
        else if (ua.includes('Android')) os = 'Android';
        else if (ua.includes('iOS') || ua.includes('iPhone')) os = 'iOS';

        return `${browser} on ${os}`;
    }


    /**
     * Get All Institutions
     * GET /super-admin/institutions
     */
    async getAllInstitutions(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const institutions = await masterDb.institution.findMany({
                orderBy: { name: 'asc' },
            });

            // Remove sensitive data
            const safeInstitutions = institutions.map((inst: typeof institutions[0]) => ({
                ...inst,
                dbPassword: '***',  // Hide password
            }));

            res.json(successResponse('Institutions retrieved', safeInstitutions));
        } catch (error) {
            next(error);
        }
    }

    /**
     * Create Institution
     * POST /super-admin/institutions
     */
    async createInstitution(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                res.status(400).json({ success: false, errors: errors.array() });
                return;
            }

            const { code, name, subdomain, logo, address, phone, email, website } = req.body;

            // Check for duplicates
            const existing = await masterDb.institution.findFirst({
                where: { OR: [{ code }, { subdomain }] },
            });

            if (existing) {
                res.status(409).json({ success: false, message: 'Institution code or subdomain already exists' });
                return;
            }

            // Generate DB credentials
            const dbName = `univarse_${subdomain}`;
            const dbUser = `univarse_${subdomain}_user`;
            const dbPassword = generateRandomPassword(24);
            const tenantSecretKey = generateSecureKey(32); // 256-bit key

            const institution = await masterDb.institution.create({
                data: {
                    code: code.toUpperCase(),
                    name,
                    subdomain: subdomain.toLowerCase(),
                    logo,
                    address,
                    phone,
                    email,
                    website,
                    dbHost: process.env.TENANT_DB_HOST || 'localhost',
                    dbPort: parseInt(process.env.TENANT_DB_PORT || '5434'),
                    dbName,
                    dbUser,
                    dbPassword,
                    tenantSecretKey,
                    keyCreatedAt: new Date(),
                    status: 'PENDING',
                    isActive: true,
                    isProvisioned: false,
                },
            });

            // Log action
            await masterDb.platformAuditLog.create({
                data: {
                    action: 'CREATE_INSTITUTION',
                    description: `Created institution: ${name} (${code})`,
                    institutionId: institution.id,
                    superAdminId: (req as any).superAdmin?.id,
                    ipAddress: req.ip,
                },
            });

            res.status(201).json(successResponse('Institution created', {
                ...institution,
                dbPassword: '***',
            }));
        } catch (error) {
            next(error);
        }
    }

    /**
     * Get Single Institution
     * GET /super-admin/institutions/:id
     */
    async getInstitution(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const institution = await masterDb.institution.findUnique({
                where: { id: req.params.id as string },
            });

            if (!institution) {
                res.status(404).json({ success: false, message: 'Institution not found' });
                return;
            }

            res.json(successResponse('Institution retrieved', {
                ...institution,
                dbPassword: '***',
            }));
        } catch (error) {
            next(error);
        }
    }

    /**
     * Update Institution
     * PUT /super-admin/institutions/:id
     */
    async updateInstitution(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const { name, logo, address, phone, email, website, isActive } = req.body;

            const institution = await masterDb.institution.update({
                where: { id: req.params.id as string },
                data: { name, logo, address, phone, email, website, isActive },
            });

            res.json(successResponse('Institution updated', {
                ...institution,
                dbPassword: '***',
            }));
        } catch (error) {
            next(error);
        }
    }

    /**
     * Delete Institution
     * DELETE /super-admin/institutions/:id
     */
    async deleteInstitution(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            // Close any active connections
            const institutionId = req.params.id as string;
            await tenantConnectionManager.closeConnection(institutionId);

            await masterDb.institution.delete({
                where: { id: institutionId },
            });

            res.json(successResponse('Institution deleted'));
        } catch (error) {
            next(error);
        }
    }

    /**
     * Provision Database for Institution
     * POST /super-admin/institutions/:id/provision
     */
    async provisionDatabase(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const institutionId = req.params.id as string;
            const institution = await masterDb.institution.findUnique({
                where: { id: institutionId },
            });

            if (!institution) {
                res.status(404).json({ success: false, message: 'Institution not found' });
                return;
            }

            if (institution.isProvisioned) {
                res.status(400).json({ success: false, message: 'Database already provisioned' });
                return;
            }

            // Use the provisioning service to create the database
            const { dbProvisioningService } = await import('../services/db-provisioning.service');

            const result = await dbProvisioningService.provisionDatabase({
                dbName: institution.dbName,
                dbUser: institution.dbUser,
                dbPassword: institution.dbPassword,
            });

            if (!result.success) {
                res.status(500).json({ success: false, message: result.message });
                return;
            }

            // Create initial IT Admin in the new tenant database
            const { tenantConnectionManager } = await import('../config/tenant-db');
            const bcrypt = await import('bcryptjs');

            const tenantPrisma = await tenantConnectionManager.getConnection({
                id: institution.id,
                subdomain: institution.subdomain,
                dbHost: institution.dbHost,
                dbPort: institution.dbPort,
                dbName: institution.dbName,
                dbUser: institution.dbUser,
                dbPassword: institution.dbPassword,
            });

            // Generate initial IT Admin credentials
            const adminEmail = institution.email || `admin@${institution.subdomain}.univarse.com`;
            const tempPassword = `${institution.code}Admin@123`;
            const hashedPassword = await bcrypt.hash(tempPassword, 12);

            // Create the Institution record in tenant DB FIRST (User has FK to Institution)
            await tenantPrisma.institution.create({
                data: {
                    id: institution.id,
                    name: institution.name,
                    code: institution.code,
                    logo: institution.logo,
                    address: institution.address,
                    phone: institution.phone,
                    email: institution.email,
                    website: institution.website,
                    isActive: true,
                },
            });

            // Then create IT Admin user in tenant DB
            const itAdmin = await tenantPrisma.user.create({
                data: {
                    email: adminEmail,
                    password: hashedPassword,
                    firstName: institution.code,
                    lastName: 'Admin',
                    role: 'ICT_ADMIN',
                    status: 'ACTIVE',
                    itAdminRole: 'IT_ADMIN_CENTRAL',
                    institutionId: institution.id,
                    mustChangePassword: true,
                },
            });

            // Mark as provisioned in master DB
            await masterDb.institution.update({
                where: { id: institutionId },
                data: {
                    isProvisioned: true,
                    status: 'ACTIVE',  // Institution is now fully operational
                },
            });

            // Log the action
            await masterDb.platformAuditLog.create({
                data: {
                    action: 'PROVISION_DATABASE',
                    description: `Provisioned database for: ${institution.name} (${institution.dbName}). IT Admin created: ${adminEmail}`,
                    institutionId: institution.id,
                    superAdminId: (req as any).superAdmin?.id,
                },
            });

            // Send welcome email to IT Admin (don't fail if email fails)
            try {
                const loginUrl = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/login?institution=${institution.subdomain}`;
                await emailService.sendITAdminWelcome({
                    institutionName: institution.name,
                    email: adminEmail,
                    temporaryPassword: tempPassword,
                    loginUrl,
                });
            } catch (emailError) {
                console.error('[Email] Failed to send IT Admin welcome email:', emailError);
            }

            res.json(successResponse('Database provisioned successfully', {
                isProvisioned: true,
                database: result.details?.database,
                migrated: result.details?.migrated,
                itAdmin: {
                    email: adminEmail,
                    temporaryPassword: tempPassword,
                    message: 'Please change this password on first login.',
                },
            }));
        } catch (error) {
            next(error);
        }
    }

    /**
     * Run Migrations on Institution Database
     * POST /super-admin/institutions/:id/migrate
     */
    async runMigrations(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            // TODO: Run Prisma migrations on the tenant database
            res.json(successResponse('Migrations completed'));
        } catch (error) {
            next(error);
        }
    }

    /**
     * Suspend Institution
     * POST /super-admin/institutions/:id/suspend
     * Blocks all logins for this institution
     */
    async suspendInstitution(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const { id: institutionId } = req.params;
            const { reason } = req.body;

            const institution = await masterDb.institution.update({
                where: { id: String(institutionId) },
                data: {
                    status: 'SUSPENDED',
                    isActive: false,
                },
            });

            // Log the action
            await masterDb.platformAuditLog.create({
                data: {
                    action: 'SUSPEND_INSTITUTION',
                    description: `Suspended institution: ${institution.name}. Reason: ${reason || 'Not specified'}`,
                    institutionId: institution.id,
                    superAdminId: (req as any).superAdmin?.id,
                    ipAddress: req.ip,
                },
            });

            // Send suspension email to IT Admin (don't fail if email fails)
            try {
                // Get IT Admin email from tenant database
                const tenantPrisma = await tenantConnectionManager.getConnection({
                    id: institution.id,
                    subdomain: institution.subdomain,
                    dbHost: institution.dbHost,
                    dbPort: institution.dbPort,
                    dbName: institution.dbName,
                    dbUser: institution.dbUser,
                    dbPassword: institution.dbPassword,
                });
                const itAdmin = await tenantPrisma.user.findFirst({
                    where: { role: 'ICT_ADMIN', institutionId: institution.id },
                    select: { email: true },
                });
                if (itAdmin) {
                    await emailService.sendSuspensionNotice({
                        institutionName: institution.name,
                        adminEmail: itAdmin.email,
                        reason,
                        contactEmail: 'support@univarse.com',
                    });
                }
            } catch (emailError) {
                console.error('[Email] Failed to send suspension notice:', emailError);
            }

            res.json(successResponse('Institution suspended', { status: institution.status }));
        } catch (error) {
            next(error);
        }
    }

    /**
     * Resume Institution
     * POST /super-admin/institutions/:id/resume
     * Re-enables logins for this institution
     */
    async resumeInstitution(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const { id: institutionId } = req.params;

            const institution = await masterDb.institution.update({
                where: { id: String(institutionId) },
                data: {
                    status: 'ACTIVE',
                    isActive: true,
                },
            });

            // Log the action
            await masterDb.platformAuditLog.create({
                data: {
                    action: 'RESUME_INSTITUTION',
                    description: `Resumed institution: ${institution.name}`,
                    institutionId: institution.id,
                    superAdminId: (req as any).superAdmin?.id,
                    ipAddress: req.ip,
                },
            });

            // Send resume email to IT Admin (don't fail if email fails)
            try {
                const tenantPrisma = await tenantConnectionManager.getConnection({
                    id: institution.id,
                    subdomain: institution.subdomain,
                    dbHost: institution.dbHost,
                    dbPort: institution.dbPort,
                    dbName: institution.dbName,
                    dbUser: institution.dbUser,
                    dbPassword: institution.dbPassword,
                });
                const itAdmin = await tenantPrisma.user.findFirst({
                    where: { role: 'ICT_ADMIN', institutionId: institution.id },
                    select: { email: true },
                });
                if (itAdmin) {
                    const loginUrl = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/login?institution=${institution.subdomain}`;
                    await emailService.sendResumeNotice(institution.name, itAdmin.email, loginUrl);
                }
            } catch (emailError) {
                console.error('[Email] Failed to send resume notice:', emailError);
            }

            res.json(successResponse('Institution resumed', { status: institution.status }));
        } catch (error) {
            next(error);
        }
    }

    /**
     * Initiate Institution Deletion (60-day process)
     * POST /super-admin/institutions/:id/initiate-deletion
     */
    async initiateInstitutionDeletion(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const { id: institutionId } = req.params;
            const { reason } = req.body;

            const deletionDate = new Date();
            deletionDate.setDate(deletionDate.getDate() + 60); // 60 days from now

            const institution = await masterDb.institution.update({
                where: { id: String(institutionId) },
                data: {
                    status: 'PENDING_DELETION',
                    isActive: false,
                    deletionRequestedAt: new Date(),
                    deletionScheduledAt: deletionDate,
                    deletionWarningsSent: 0,
                },
            });

            // Log the action
            await masterDb.platformAuditLog.create({
                data: {
                    action: 'INITIATE_DELETION',
                    description: `Initiated 60-day deletion for: ${institution.name}. Reason: ${reason || 'Not specified'}. Scheduled for: ${deletionDate.toISOString()}`,
                    institutionId: institution.id,
                    superAdminId: (req as any).superAdmin?.id,
                    ipAddress: req.ip,
                    metadata: { reason, scheduledDeletion: deletionDate.toISOString() },
                },
            });

            // Create backup of tenant database
            const backupResult = await backupService.exportInstitutionData(institution.id);

            // Send backup notification if backup was successful
            if (backupResult.success && backupResult.backupPath) {
                // Get IT Admin email for notification
                const tenantPrisma = await tenantConnectionManager.getConnection({
                    id: institution.id,
                    subdomain: institution.subdomain,
                    dbHost: institution.dbHost,
                    dbPort: institution.dbPort,
                    dbName: institution.dbName,
                    dbUser: institution.dbUser,
                    dbPassword: institution.dbPassword,
                });

                const itAdmin = await tenantPrisma.user.findFirst({
                    where: { role: 'ICT_ADMIN', institutionId: institution.id },
                    select: { email: true },
                });

                if (itAdmin) {
                    await backupService.sendBackupNotification(
                        institution.id,
                        itAdmin.email,
                        backupResult.backupPath
                    );
                }
            }

            res.json(successResponse('Institution deletion initiated', {
                status: institution.status,
                scheduledDeletionDate: deletionDate,
                daysRemaining: 60,
                backup: backupResult.success ? {
                    created: true,
                    path: backupResult.backupPath,
                    size: backupResult.backupSize,
                } : { created: false, error: backupResult.error },
            }));
        } catch (error) {
            next(error);
        }
    }

    /**
     * Cancel Institution Deletion
     * POST /super-admin/institutions/:id/cancel-deletion
     */
    async cancelInstitutionDeletion(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const { id: institutionId } = req.params;

            const institution = await masterDb.institution.update({
                where: { id: String(institutionId) },
                data: {
                    status: 'ACTIVE',
                    isActive: true,
                    deletionCancelledAt: new Date(),
                    deletionScheduledAt: null,
                },
            });

            // Log the action
            await masterDb.platformAuditLog.create({
                data: {
                    action: 'CANCEL_DELETION',
                    description: `Cancelled deletion for: ${institution.name}`,
                    institutionId: institution.id,
                    superAdminId: (req as any).superAdmin?.id,
                    ipAddress: req.ip,
                },
            });

            res.json(successResponse('Institution deletion cancelled', { status: institution.status }));
        } catch (error) {
            next(error);
        }
    }

    /**
     * Get IT Admins for Institution
     * GET /super-admin/institutions/:id/admins
     */
    async getInstitutionAdmins(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const { id: institutionId } = req.params;

            const institution = await masterDb.institution.findUnique({
                where: { id: String(institutionId) },
            });

            if (!institution) {
                res.status(404).json({ success: false, message: 'Institution not found' });
                return;
            }

            if (!institution.isProvisioned) {
                res.status(400).json({ success: false, message: 'Institution not provisioned yet' });
                return;
            }

            // Connect to tenant DB
            const tenantPrisma = await tenantConnectionManager.getConnection({
                id: institution.id,
                subdomain: institution.subdomain,
                dbHost: institution.dbHost,
                dbPort: institution.dbPort,
                dbName: institution.dbName,
                dbUser: institution.dbUser,
                dbPassword: institution.dbPassword,
            });

            // Get all ICT_ADMIN users
            const admins = await tenantPrisma.user.findMany({
                where: {
                    role: 'ICT_ADMIN',
                    institutionId: institution.id,
                },
                select: {
                    id: true,
                    email: true,
                    firstName: true,
                    lastName: true,
                    status: true,
                    lastLoginAt: true,
                    itAdminRole: true,
                    createdAt: true,
                },
            });

            res.json(successResponse('IT Admins retrieved', { admins }));
        } catch (error) {
            next(error);
        }
    }

    /**
     * Regenerate IT Admin Credentials
     * POST /super-admin/institutions/:id/regenerate-credentials
     */
    async regenerateITAdminCredentials(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const { id: institutionId } = req.params;
            const { adminEmail } = req.body;

            const institution = await masterDb.institution.findUnique({
                where: { id: String(institutionId) },
            });

            if (!institution) {
                res.status(404).json({ success: false, message: 'Institution not found' });
                return;
            }

            // Connect to tenant DB
            const tenantPrisma = await tenantConnectionManager.getConnection({
                id: institution.id,
                subdomain: institution.subdomain,
                dbHost: institution.dbHost,
                dbPort: institution.dbPort,
                dbName: institution.dbName,
                dbUser: institution.dbUser,
                dbPassword: institution.dbPassword,
            });

            // Find the IT Admin
            const admin = await tenantPrisma.user.findFirst({
                where: {
                    email: adminEmail,
                    role: 'ICT_ADMIN',
                },
            });

            if (!admin) {
                res.status(404).json({ success: false, message: 'IT Admin not found' });
                return;
            }

            // Generate new password
            const newPassword = `${institution.code}Admin@${Date.now().toString().slice(-4)}`;
            const bcrypt = await import('bcryptjs');
            const hashedPassword = await bcrypt.hash(newPassword, 12);

            // Update password
            await tenantPrisma.user.update({
                where: { id: admin.id },
                data: {
                    password: hashedPassword,
                    mustChangePassword: true,
                },
            });

            // Log the action
            await masterDb.platformAuditLog.create({
                data: {
                    action: 'REGENERATE_CREDENTIALS',
                    description: `Regenerated credentials for IT Admin: ${adminEmail} at ${institution.name}`,
                    institutionId: institution.id,
                    superAdminId: (req as any).superAdmin?.id,
                    ipAddress: req.ip,
                },
            });

            // Send credentials reset email (don't fail if email fails)
            try {
                const loginUrl = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/login?institution=${institution.subdomain}`;
                await emailService.sendCredentialsReset({
                    institutionName: institution.name,
                    email: adminEmail,
                    temporaryPassword: newPassword,
                    loginUrl,
                });
            } catch (emailError) {
                console.error('[Email] Failed to send credentials reset email:', emailError);
            }

            res.json(successResponse('Credentials regenerated', {
                email: adminEmail,
                temporaryPassword: newPassword,
                message: 'New password generated. Please share securely with the admin.',
            }));
        } catch (error) {
            next(error);
        }
    }

    /**
     * Get Platform Stats
     * GET /super-admin/stats
     */
    async getPlatformStats(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const [totalInstitutions, activeInstitutions, provisionedInstitutions, totalAdmins] = await Promise.all([
                masterDb.institution.count(),
                masterDb.institution.count({ where: { isActive: true } }),
                masterDb.institution.count({ where: { isProvisioned: true } }),
                masterDb.superAdmin.count(),
            ]);

            res.json(successResponse('Platform stats', {
                totalInstitutions,
                activeInstitutions,
                provisionedInstitutions,
                totalAdmins,
                connectionStats: tenantConnectionManager.getStats(),
            }));
        } catch (error) {
            next(error);
        }
    }

    /**
     * Get Connection Stats
     * GET /super-admin/connections
     */
    async getConnectionStats(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            res.json(successResponse('Connection stats', tenantConnectionManager.getStats()));
        } catch (error) {
            next(error);
        }
    }

    /**
     * Get Audit Logs
     * GET /super-admin/audit-logs
     */
    async getAuditLogs(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const logs = await masterDb.platformAuditLog.findMany({
                take: 100,
                orderBy: { createdAt: 'desc' },
            });

            res.json(successResponse('Audit logs', logs));
        } catch (error) {
            next(error);
        }
    }

    /**
     * Get All Super Admins
     * GET /super-admin/admins
     */
    async getAllSuperAdmins(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const admins = await masterDb.superAdmin.findMany({
                select: {
                    id: true,
                    email: true,
                    firstName: true,
                    lastName: true,
                    isActive: true,
                    lastLoginAt: true,
                    createdAt: true,
                },
            });

            res.json(successResponse('Super admins', admins));
        } catch (error) {
            next(error);
        }
    }

    /**
     * Create Super Admin
     * POST /super-admin/admins
     */
    async createSuperAdmin(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                res.status(400).json({ success: false, errors: errors.array() });
                return;
            }

            const { email, password, firstName, lastName } = req.body;

            const existing = await masterDb.superAdmin.findUnique({ where: { email } });
            if (existing) {
                res.status(409).json({ success: false, message: 'Email already exists' });
                return;
            }

            const hashedPassword = await hashPassword(password);

            const admin = await masterDb.superAdmin.create({
                data: {
                    email,
                    password: hashedPassword,
                    firstName,
                    lastName,
                },
            });

            res.status(201).json(successResponse('Super admin created', {
                id: admin.id,
                email: admin.email,
                firstName: admin.firstName,
                lastName: admin.lastName,
            }));
        } catch (error) {
            next(error);
        }
    }

    // ============================================
    // PLATFORM SETTINGS
    // ============================================

    /**
     * Get All Settings
     * GET /super-admin/settings
     */
    async getAllSettings(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const settings = await masterDb.platformSetting.findMany({
                orderBy: [{ category: 'asc' }, { key: 'asc' }],
            });

            // Group by category
            const grouped = settings.reduce((acc: any, setting) => {
                if (!acc[setting.category]) {
                    acc[setting.category] = [];
                }
                acc[setting.category].push(setting);
                return acc;
            }, {});

            res.json(successResponse('Settings retrieved', { settings, grouped }));
        } catch (error) {
            next(error);
        }
    }

    /**
     * Get Settings by Category
     * GET /super-admin/settings/:category
     */
    async getSettingsByCategory(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const category = String(req.params.category);

            const settings = await masterDb.platformSetting.findMany({
                where: { category: category.toUpperCase() as any },
                orderBy: { key: 'asc' },
            });

            res.json(successResponse('Settings retrieved', { settings }));
        } catch (error) {
            next(error);
        }
    }

    /**
     * Update Setting
     * PUT /super-admin/settings/:key
     */
    async updateSetting(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const key = String(req.params.key);
            const { value } = req.body;

            const setting = await masterDb.platformSetting.update({
                where: { key },
                data: {
                    value: String(value),
                    updatedBy: (req as any).superAdmin?.id,
                },
            });

            // Log the action
            await masterDb.platformAuditLog.create({
                data: {
                    action: 'UPDATE_SETTING',
                    description: `Updated setting: ${key} = ${value}`,
                    superAdminId: (req as any).superAdmin?.id,
                    ipAddress: req.ip,
                },
            });

            res.json(successResponse('Setting updated', { setting }));
        } catch (error) {
            next(error);
        }
    }

    /**
     * Seed Default Settings
     * POST /super-admin/settings/seed
     */
    async seedDefaultSettings(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const defaultSettings = [
                // Security
                { key: 'security.sessionTimeout', value: '28800', type: 'NUMBER', category: 'SECURITY', label: 'Session Timeout (seconds)', description: 'How long before user sessions expire' },
                { key: 'security.maxLoginAttempts', value: '5', type: 'NUMBER', category: 'SECURITY', label: 'Max Login Attempts', description: 'Number of failed attempts before lockout' },
                { key: 'security.lockoutDuration', value: '1800', type: 'NUMBER', category: 'SECURITY', label: 'Lockout Duration (seconds)', description: 'How long accounts stay locked' },
                { key: 'security.passwordMinLength', value: '8', type: 'NUMBER', category: 'SECURITY', label: 'Password Minimum Length' },
                { key: 'security.require2FA', value: 'false', type: 'BOOLEAN', category: 'SECURITY', label: 'Require 2FA', description: 'Force two-factor authentication for all users' },

                // Tenant Defaults
                { key: 'tenant.defaultStorageQuota', value: '10737418240', type: 'NUMBER', category: 'TENANT_DEFAULTS', label: 'Default Storage Quota (bytes)', description: '10GB default' },
                { key: 'tenant.maxUsersPerTenant', value: '50000', type: 'NUMBER', category: 'TENANT_DEFAULTS', label: 'Max Users per Tenant' },
                { key: 'tenant.defaultModules', value: '["admissions","academics","fees","results"]', type: 'JSON', category: 'TENANT_DEFAULTS', label: 'Default Modules', description: 'Modules enabled by default for new tenants' },

                // Email
                { key: 'email.fromName', value: 'UniVarse', type: 'STRING', category: 'EMAIL', label: 'From Name' },
                { key: 'email.fromEmail', value: 'noreply@univarse.com', type: 'STRING', category: 'EMAIL', label: 'From Email' },
                { key: 'email.supportEmail', value: 'support@univarse.com', type: 'STRING', category: 'EMAIL', label: 'Support Email' },

                // Features
                { key: 'features.maintenanceMode', value: 'false', type: 'BOOLEAN', category: 'FEATURES', label: 'Maintenance Mode', description: 'Enable platform-wide maintenance mode' },
                { key: 'features.allowRegistration', value: 'true', type: 'BOOLEAN', category: 'FEATURES', label: 'Allow Registration', description: 'Allow new user registrations' },
                { key: 'features.enableWebSocket', value: 'true', type: 'BOOLEAN', category: 'FEATURES', label: 'Enable WebSocket', description: 'Enable real-time updates' },

                // Branding
                { key: 'branding.platformName', value: 'UniVarse', type: 'STRING', category: 'BRANDING', label: 'Platform Name' },
                { key: 'branding.primaryColor', value: '#485550', type: 'STRING', category: 'BRANDING', label: 'Primary Color' },
                { key: 'branding.secondaryColor', value: '#C0EB6A', type: 'STRING', category: 'BRANDING', label: 'Secondary Color' },
                { key: 'branding.backgroundColor', value: '#F4F6F0', type: 'STRING', category: 'BRANDING', label: 'Background Color' },
            ];

            for (const setting of defaultSettings) {
                await masterDb.platformSetting.upsert({
                    where: { key: setting.key },
                    update: {},
                    create: setting as any,
                });
            }

            res.json(successResponse('Default settings seeded', { count: defaultSettings.length }));
        } catch (error) {
            next(error);
        }
    }

    // ============================================
    // PLATFORM ANNOUNCEMENTS
    // ============================================

    /**
     * Get All Announcements
     * GET /super-admin/announcements
     */
    async getAllAnnouncements(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const announcements = await masterDb.platformAnnouncement.findMany({
                orderBy: { createdAt: 'desc' },
            });

            res.json(successResponse('Announcements retrieved', { announcements }));
        } catch (error) {
            next(error);
        }
    }

    /**
     * Create Announcement
     * POST /super-admin/announcements
     */
    async createAnnouncement(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const { title, message, type, startsAt, endsAt, targetRoles } = req.body;

            const announcement = await masterDb.platformAnnouncement.create({
                data: {
                    title,
                    message,
                    type: type || 'info',
                    startsAt: startsAt ? new Date(startsAt) : new Date(),
                    endsAt: endsAt ? new Date(endsAt) : null,
                    targetRoles: targetRoles || [],
                    createdBy: (req as any).superAdmin?.id,
                },
            });

            res.status(201).json(successResponse('Announcement created', { announcement }));
        } catch (error) {
            next(error);
        }
    }

    /**
     * Update Announcement
     * PUT /super-admin/announcements/:id
     */
    async updateAnnouncement(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const id = String(req.params.id);
            const { title, message, type, isActive, startsAt, endsAt, targetRoles } = req.body;

            const announcement = await masterDb.platformAnnouncement.update({
                where: { id },
                data: {
                    title,
                    message,
                    type,
                    isActive,
                    startsAt: startsAt ? new Date(startsAt) : undefined,
                    endsAt: endsAt ? new Date(endsAt) : null,
                    targetRoles,
                },
            });

            res.json(successResponse('Announcement updated', { announcement }));
        } catch (error) {
            next(error);
        }
    }

    /**
     * Delete Announcement
     * DELETE /super-admin/announcements/:id
     */
    async deleteAnnouncement(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const id = String(req.params.id);

            await masterDb.platformAnnouncement.delete({
                where: { id },
            });

            res.json(successResponse('Announcement deleted'));
        } catch (error) {
            next(error);
        }
    }

    // ============================================
    // TWO-FACTOR AUTHENTICATION
    // ============================================

    /**
     * Get 2FA Status
     * GET /super-admin/2fa/status
     */
    async get2FAStatus(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const adminId = (req as any).superAdmin?.id;
            const admin = await masterDb.superAdmin.findUnique({
                where: { id: adminId },
                select: { twoFactorEnabled: true, twoFactorVerified: true },
            });

            if (!admin) {
                res.status(404).json({ success: false, message: 'Admin not found' });
                return;
            }

            res.json(successResponse('2FA status', {
                enabled: admin.twoFactorEnabled && admin.twoFactorVerified,
                setupComplete: admin.twoFactorVerified,
            }));
        } catch (error) {
            next(error);
        }
    }

    /**
     * Setup 2FA - Generate secret and QR code
     * POST /super-admin/2fa/setup
     */
    async setup2FA(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const adminId = (req as any).superAdmin?.id;
            const admin = await masterDb.superAdmin.findUnique({
                where: { id: adminId },
            });

            if (!admin) {
                res.status(404).json({ success: false, message: 'Admin not found' });
                return;
            }

            if (admin.twoFactorEnabled && admin.twoFactorVerified) {
                res.status(400).json({ success: false, message: '2FA is already enabled. Disable it first.' });
                return;
            }

            // Generate new secret
            const { secret, otpauthUrl } = twoFactorService.generateSecret(admin.email);
            const qrCode = await twoFactorService.generateQRCode(otpauthUrl);

            // Store secret (not yet verified)
            await masterDb.superAdmin.update({
                where: { id: adminId },
                data: {
                    twoFactorSecret: secret,
                    twoFactorEnabled: true,
                    twoFactorVerified: false,
                },
            });

            res.json(successResponse('2FA setup initiated', {
                qrCode,
                secret, // Can be manually entered if QR doesn't work
                message: 'Scan this QR code with your authenticator app',
            }));
        } catch (error) {
            next(error);
        }
    }

    /**
     * Verify 2FA Setup - Confirm token and enable 2FA
     * POST /super-admin/2fa/verify-setup
     */
    async verifySetup2FA(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                res.status(400).json({ success: false, errors: errors.array() });
                return;
            }

            const adminId = (req as any).superAdmin?.id;
            const { token } = req.body;

            const admin = await masterDb.superAdmin.findUnique({
                where: { id: adminId },
            });

            if (!admin || !admin.twoFactorSecret) {
                res.status(400).json({ success: false, message: '2FA setup not started' });
                return;
            }

            // Verify the token
            const isValid = twoFactorService.verifyToken(admin.twoFactorSecret, token);
            if (!isValid) {
                res.status(400).json({ success: false, message: 'Invalid verification code' });
                return;
            }

            // Generate recovery codes
            const recoveryCodes = twoFactorService.generateRecoveryCodes(8);
            const hashedCodes = recoveryCodes.map(code => twoFactorService.hashRecoveryCode(code));

            // Enable 2FA
            await masterDb.superAdmin.update({
                where: { id: adminId },
                data: {
                    twoFactorVerified: true,
                    recoveryCodes: hashedCodes,
                    lastTwoFactorAt: new Date(),
                },
            });

            // Log the action
            await masterDb.platformAuditLog.create({
                data: {
                    action: 'ENABLE_2FA',
                    description: `2FA enabled for Super Admin: ${admin.email}`,
                    superAdminId: adminId,
                    ipAddress: req.ip,
                },
            });

            res.json(successResponse('2FA enabled successfully', {
                recoveryCodes,
                message: 'Save these recovery codes securely. Each can only be used once.',
            }));
        } catch (error) {
            next(error);
        }
    }

    /**
     * Disable 2FA
     * POST /super-admin/2fa/disable
     */
    async disable2FA(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                res.status(400).json({ success: false, errors: errors.array() });
                return;
            }

            const adminId = (req as any).superAdmin?.id;
            const { password, token } = req.body;

            const admin = await masterDb.superAdmin.findUnique({
                where: { id: adminId },
            });

            if (!admin) {
                res.status(404).json({ success: false, message: 'Admin not found' });
                return;
            }

            // Verify password
            const isPasswordValid = await comparePassword(password, admin.password);
            if (!isPasswordValid) {
                res.status(401).json({ success: false, message: 'Invalid password' });
                return;
            }

            // Verify 2FA token or recovery code
            let isTokenValid = false;
            if (admin.twoFactorSecret) {
                isTokenValid = twoFactorService.verifyToken(admin.twoFactorSecret, token);
            }

            // Check recovery codes if token didn't work
            if (!isTokenValid && admin.recoveryCodes.length > 0) {
                const recoveryResult = twoFactorService.verifyRecoveryCode(token, admin.recoveryCodes);
                isTokenValid = recoveryResult.valid;
            }

            if (!isTokenValid) {
                res.status(401).json({ success: false, message: 'Invalid 2FA code or recovery code' });
                return;
            }

            // Disable 2FA
            await masterDb.superAdmin.update({
                where: { id: adminId },
                data: {
                    twoFactorEnabled: false,
                    twoFactorVerified: false,
                    twoFactorSecret: null,
                    recoveryCodes: [],
                },
            });

            // Log the action
            await masterDb.platformAuditLog.create({
                data: {
                    action: 'DISABLE_2FA',
                    description: `2FA disabled for Super Admin: ${admin.email}`,
                    superAdminId: adminId,
                    ipAddress: req.ip,
                },
            });

            res.json(successResponse('2FA disabled successfully'));
        } catch (error) {
            next(error);
        }
    }

    /**
     * Regenerate Recovery Codes
     * POST /super-admin/2fa/recovery-codes
     */
    async regenerateRecoveryCodes(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const adminId = (req as any).superAdmin?.id;

            const admin = await masterDb.superAdmin.findUnique({
                where: { id: adminId },
            });

            if (!admin || !admin.twoFactorEnabled || !admin.twoFactorVerified) {
                res.status(400).json({ success: false, message: '2FA is not enabled' });
                return;
            }

            // Generate new recovery codes
            const recoveryCodes = twoFactorService.generateRecoveryCodes(8);
            const hashedCodes = recoveryCodes.map(code => twoFactorService.hashRecoveryCode(code));

            await masterDb.superAdmin.update({
                where: { id: adminId },
                data: { recoveryCodes: hashedCodes },
            });

            // Log the action
            await masterDb.platformAuditLog.create({
                data: {
                    action: 'REGENERATE_RECOVERY_CODES',
                    description: `Recovery codes regenerated for Super Admin: ${admin.email}`,
                    superAdminId: adminId,
                    ipAddress: req.ip,
                },
            });

            res.json(successResponse('Recovery codes regenerated', {
                recoveryCodes,
                message: 'Previous codes are now invalid. Save these new codes securely.',
            }));
        } catch (error) {
            next(error);
        }
    }

    /**
     * Verify 2FA Login (Public route - completes login after password)
     * POST /super-admin/verify-2fa
     */
    async verify2FALogin(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                res.status(400).json({ success: false, errors: errors.array() });
                return;
            }

            const { email, token } = req.body;

            const admin = await masterDb.superAdmin.findUnique({ where: { email } });
            if (!admin) {
                res.status(401).json({ success: false, message: 'Invalid credentials' });
                return;
            }

            if (!admin.twoFactorEnabled || !admin.twoFactorSecret) {
                res.status(400).json({ success: false, message: '2FA is not enabled for this account' });
                return;
            }

            // Try TOTP verification first
            let isValid = twoFactorService.verifyToken(admin.twoFactorSecret, token);
            let usedRecoveryCode = false;

            // If TOTP failed, try recovery codes
            if (!isValid && admin.recoveryCodes.length > 0) {
                const recoveryResult = twoFactorService.verifyRecoveryCode(token, admin.recoveryCodes);
                if (recoveryResult.valid) {
                    isValid = true;
                    usedRecoveryCode = true;
                    // Remove used recovery code
                    const updatedCodes = [...admin.recoveryCodes];
                    updatedCodes.splice(recoveryResult.usedIndex, 1);
                    await masterDb.superAdmin.update({
                        where: { id: admin.id },
                        data: { recoveryCodes: updatedCodes },
                    });
                }
            }

            if (!isValid) {
                res.status(401).json({ success: false, message: 'Invalid 2FA code' });
                return;
            }

            // Update last login and 2FA timestamp
            await masterDb.superAdmin.update({
                where: { id: admin.id },
                data: {
                    lastLoginAt: new Date(),
                    lastTwoFactorAt: new Date(),
                },
            });

            // Generate token
            const accessToken = generateAccessToken({
                userId: admin.id,
                email: admin.email,
                role: 'SUPER_ADMIN',
                institutionId: null,
            });

            res.json(successResponse('Login successful', {
                accessToken,
                user: {
                    id: admin.id,
                    email: admin.email,
                    firstName: admin.firstName,
                    lastName: admin.lastName,
                    role: 'SUPER_ADMIN',
                    twoFactorEnabled: true,
                },
                usedRecoveryCode,
                remainingRecoveryCodes: usedRecoveryCode ? admin.recoveryCodes.length - 1 : undefined,
            }));
        } catch (error) {
            next(error);
        }
    }

    // ============================================
    // SESSION MANAGEMENT
    // ============================================

    /**
     * Get Active Sessions
     * GET /super-admin/sessions
     */
    async getSessions(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const superAdminId = (req as any).superAdmin?.id;
            const currentTokenHash = (req as any).currentTokenHash;

            const sessions = await masterDb.superAdminSession.findMany({
                where: {
                    superAdminId,
                    isActive: true,
                    expiresAt: { gt: new Date() },
                },
                orderBy: { lastActivityAt: 'desc' },
                select: {
                    id: true,
                    ipAddress: true,
                    userAgent: true,
                    deviceInfo: true,
                    location: true,
                    createdAt: true,
                    lastActivityAt: true,
                    tokenHash: true,
                },
            });

            // Mark current session
            const sessionsWithCurrent = sessions.map(s => ({
                ...s,
                isCurrent: s.tokenHash === currentTokenHash,
                tokenHash: undefined, // Don't expose hash
            }));

            res.json(successResponse('Active sessions', { sessions: sessionsWithCurrent }));
        } catch (error) {
            next(error);
        }
    }

    /**
     * Terminate Specific Session
     * DELETE /super-admin/sessions/:id
     */
    async terminateSession(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const superAdminId = (req as any).superAdmin?.id;
            const { id: sessionId } = req.params;

            const session = await masterDb.superAdminSession.findFirst({
                where: { id: String(sessionId), superAdminId: String(superAdminId) },
            });

            if (!session) {
                res.status(404).json({ success: false, message: 'Session not found' });
                return;
            }

            await masterDb.superAdminSession.update({
                where: { id: String(sessionId) },
                data: { isActive: false },
            });

            // Log the action
            await masterDb.platformAuditLog.create({
                data: {
                    action: 'TERMINATE_SESSION',
                    description: `Terminated session from ${session.ipAddress}`,
                    superAdminId,
                    ipAddress: req.ip,
                },
            });

            res.json(successResponse('Session terminated'));
        } catch (error) {
            next(error);
        }
    }

    /**
     * Terminate All Other Sessions
     * DELETE /super-admin/sessions
     */
    async terminateAllSessions(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const superAdminId = (req as any).superAdmin?.id;
            const currentTokenHash = (req as any).currentTokenHash;

            const result = await masterDb.superAdminSession.updateMany({
                where: {
                    superAdminId,
                    isActive: true,
                    tokenHash: { not: currentTokenHash }, // Exclude current session
                },
                data: { isActive: false },
            });

            // Log the action
            await masterDb.platformAuditLog.create({
                data: {
                    action: 'TERMINATE_ALL_SESSIONS',
                    description: `Terminated ${result.count} other sessions`,
                    superAdminId,
                    ipAddress: req.ip,
                },
            });

            res.json(successResponse(`Terminated ${result.count} sessions`));
        } catch (error) {
            next(error);
        }
    }

    // ============================================
    // IP WHITELISTING
    // ============================================

    /**
     * Get IP Whitelist
     * GET /super-admin/security/ip-whitelist
     */
    async getIPWhitelist(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const superAdminId = (req as any).superAdmin?.id;

            const admin = await masterDb.superAdmin.findUnique({
                where: { id: superAdminId },
                select: {
                    ipWhitelist: true,
                    ipWhitelistEnabled: true,
                },
            });

            res.json(successResponse('IP Whitelist', {
                ipWhitelist: admin?.ipWhitelist || [],
                ipWhitelistEnabled: admin?.ipWhitelistEnabled || false,
                currentIP: req.ip,
            }));
        } catch (error) {
            next(error);
        }
    }

    /**
     * Update IP Whitelist
     * PUT /super-admin/security/ip-whitelist
     */
    async updateIPWhitelist(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const superAdminId = (req as any).superAdmin?.id;
            const { ipWhitelist, ipWhitelistEnabled } = req.body;

            // Validate IPs
            const validIPRegex = /^(\d{1,3}\.){3}\d{1,3}$|^([0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}$/;
            if (ipWhitelist && Array.isArray(ipWhitelist)) {
                for (const ip of ipWhitelist) {
                    if (!validIPRegex.test(ip)) {
                        res.status(400).json({ success: false, message: `Invalid IP address: ${ip}` });
                        return;
                    }
                }
            }

            // Ensure current IP is in whitelist if enabling
            const currentIP = req.ip?.replace('::ffff:', '') || '';
            if (ipWhitelistEnabled && ipWhitelist && !ipWhitelist.includes(currentIP)) {
                res.status(400).json({
                    success: false,
                    message: `Your current IP (${currentIP}) must be in the whitelist before enabling`,
                });
                return;
            }

            await masterDb.superAdmin.update({
                where: { id: superAdminId },
                data: {
                    ipWhitelist: ipWhitelist || [],
                    ipWhitelistEnabled: ipWhitelistEnabled || false,
                },
            });

            // Log the action
            await masterDb.platformAuditLog.create({
                data: {
                    action: 'UPDATE_IP_WHITELIST',
                    description: `Updated IP whitelist. Enabled: ${ipWhitelistEnabled}. IPs: ${ipWhitelist?.length || 0}`,
                    superAdminId,
                    ipAddress: req.ip,
                },
            });

            res.json(successResponse('IP Whitelist updated'));
        } catch (error) {
            next(error);
        }
    }

    /**
     * Test IP Address
     * POST /super-admin/security/ip-whitelist/test
     */
    async testIPAddress(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const superAdminId = (req as any).superAdmin?.id;
            const { ipAddress } = req.body;

            const admin = await masterDb.superAdmin.findUnique({
                where: { id: superAdminId },
                select: { ipWhitelist: true, ipWhitelistEnabled: true },
            });

            const testIP = ipAddress || req.ip?.replace('::ffff:', '');
            const isAllowed = !admin?.ipWhitelistEnabled ||
                (admin?.ipWhitelist || []).includes(testIP);

            res.json(successResponse('IP Test Result', {
                ipAddress: testIP,
                isAllowed,
                whitelistEnabled: admin?.ipWhitelistEnabled,
            }));
        } catch (error) {
            next(error);
        }
    }

    // ============================================
    // ANALYTICS
    // ============================================

    /**
     * Get Analytics Overview
     * GET /super-admin/analytics/overview
     */
    async getAnalyticsOverview(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            // Get institution counts by status
            const institutions = await masterDb.institution.findMany({
                select: { status: true, createdAt: true },
            });

            const statusCounts = institutions.reduce((acc: Record<string, number>, i) => {
                acc[i.status] = (acc[i.status] || 0) + 1;
                return acc;
            }, {});

            // Get audit log activity (last 30 days)
            const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
            const recentActivity = await masterDb.platformAuditLog.count({
                where: { createdAt: { gte: thirtyDaysAgo } },
            });

            // Get super admin count
            const superAdminCount = await masterDb.superAdmin.count({
                where: { isActive: true },
            });

            // Get active sessions
            const activeSessions = await masterDb.superAdminSession.count({
                where: { isActive: true, expiresAt: { gt: new Date() } },
            });

            // Institutions created this month vs last month
            const startOfMonth = new Date();
            startOfMonth.setDate(1);
            startOfMonth.setHours(0, 0, 0, 0);

            const startOfLastMonth = new Date(startOfMonth);
            startOfLastMonth.setMonth(startOfLastMonth.getMonth() - 1);

            const thisMonthInstitutions = institutions.filter(i => i.createdAt >= startOfMonth).length;
            const lastMonthInstitutions = institutions.filter(
                i => i.createdAt >= startOfLastMonth && i.createdAt < startOfMonth
            ).length;

            const growthPercentage = lastMonthInstitutions > 0
                ? Math.round(((thisMonthInstitutions - lastMonthInstitutions) / lastMonthInstitutions) * 100)
                : thisMonthInstitutions > 0 ? 100 : 0;

            res.json(successResponse('Analytics Overview', {
                totalInstitutions: institutions.length,
                activeInstitutions: statusCounts['ACTIVE'] || 0,
                pendingInstitutions: statusCounts['PENDING'] || 0,
                suspendedInstitutions: statusCounts['SUSPENDED'] || 0,
                deletionPending: statusCounts['PENDING_DELETION'] || 0,
                provisionedInstitutions: statusCounts['PROVISIONED'] || 0,
                recentActivity,
                superAdminCount,
                activeSessions,
                growth: {
                    thisMonth: thisMonthInstitutions,
                    lastMonth: lastMonthInstitutions,
                    percentage: growthPercentage,
                },
            }));
        } catch (error) {
            next(error);
        }
    }

    /**
     * Get Analytics Trends
     * GET /super-admin/analytics/trends
     */
    async getAnalyticsTrends(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const { period = '30d' } = req.query;

            let days = 30;
            if (period === '7d') days = 7;
            else if (period === '90d') days = 90;
            else if (period === '1y') days = 365;

            // Get institutions created per day
            const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
            const institutions = await masterDb.institution.findMany({
                where: { createdAt: { gte: startDate } },
                select: { createdAt: true },
            });

            // Get activity per day
            const activity = await masterDb.platformAuditLog.findMany({
                where: { createdAt: { gte: startDate } },
                select: { createdAt: true },
            });

            // Group by date
            const dateGroups: Record<string, { institutions: number; activity: number }> = {};

            for (let i = 0; i < days; i++) {
                const date = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
                const key = date.toISOString().split('T')[0];
                dateGroups[key] = { institutions: 0, activity: 0 };
            }

            institutions.forEach(i => {
                const key = i.createdAt.toISOString().split('T')[0];
                if (dateGroups[key]) dateGroups[key].institutions++;
            });

            activity.forEach(a => {
                const key = a.createdAt.toISOString().split('T')[0];
                if (dateGroups[key]) dateGroups[key].activity++;
            });

            // Convert to array sorted by date
            const trends = Object.entries(dateGroups)
                .map(([date, data]) => ({ date, ...data }))
                .sort((a, b) => a.date.localeCompare(b.date));

            res.json(successResponse('Analytics Trends', { period, trends }));
        } catch (error) {
            next(error);
        }
    }

    /**
     * Get Per-Institution Analytics
     * GET /super-admin/analytics/institutions
     */
    async getInstitutionAnalytics(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const institutions = await masterDb.institution.findMany({
                select: {
                    id: true,
                    name: true,
                    code: true,
                    status: true,
                    createdAt: true,
                    updatedAt: true,
                },
                orderBy: { updatedAt: 'desc' },
            });

            // Get activity counts per institution
            const activityCounts = await masterDb.platformAuditLog.groupBy({
                by: ['institutionId'],
                _count: { id: true },
                where: { institutionId: { not: null } },
            });

            const activityMap = activityCounts.reduce((acc: Record<string, number>, item) => {
                if (item.institutionId) acc[item.institutionId] = item._count.id;
                return acc;
            }, {});

            const institutionsWithMetrics = institutions.map(i => ({
                ...i,
                activityCount: activityMap[i.id] || 0,
                daysSinceUpdate: Math.floor((Date.now() - i.updatedAt.getTime()) / (24 * 60 * 60 * 1000)),
            }));

            res.json(successResponse('Institution Analytics', {
                institutions: institutionsWithMetrics,
                total: institutions.length,
            }));
        } catch (error) {
            next(error);
        }
    }

    // ============================================
    // BROADCAST / MASS COMMUNICATION
    // ============================================

    /**
     * Get All Broadcasts
     * GET /super-admin/broadcast
     */
    async getBroadcasts(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const broadcasts = await masterDb.broadcastMessage.findMany({
                orderBy: { sentAt: 'desc' },
                take: 50,
            });

            res.json(successResponse('Broadcasts', { broadcasts }));
        } catch (error) {
            next(error);
        }
    }

    /**
     * Send Broadcast
     * POST /super-admin/broadcast
     */
    async sendBroadcast(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const superAdmin = (req as any).superAdmin;
            const { subject, content, recipients = ['ALL'] } = req.body;

            if (!subject || !content) {
                res.status(400).json({ success: false, message: 'Subject and content are required' });
                return;
            }

            // Get IT Admin emails based on recipients
            let institutionFilter: any = { status: 'ACTIVE' };
            if (!recipients.includes('ALL')) {
                institutionFilter.id = { in: recipients };
            }

            const institutions = await masterDb.institution.findMany({
                where: institutionFilter,
                select: { id: true, name: true, email: true },
            });

            // Filter out institutions without email
            const validRecipients = institutions.filter(i => i.email);

            // Create broadcast record
            const broadcast = await masterDb.broadcastMessage.create({
                data: {
                    subject,
                    content,
                    contentPlain: content.replace(/<[^>]*>/g, ''), // Strip HTML
                    recipients,
                    sentBy: superAdmin.id,
                    sentByName: `${superAdmin.firstName} ${superAdmin.lastName}`,
                    recipientCount: validRecipients.length,
                    status: 'SENT',
                },
            });

            // Send emails (async - don't wait)
            const emailService = require('../services/email.service').emailService;
            for (const recipient of validRecipients) {
                emailService.sendEmail(recipient.email, subject, content).catch((err: Error) => {
                    console.error(`Failed to send broadcast to ${recipient.email}:`, err);
                });
            }

            // Log action
            await masterDb.platformAuditLog.create({
                data: {
                    action: 'SEND_BROADCAST',
                    description: `Sent broadcast "${subject}" to ${validRecipients.length} recipients`,
                    superAdminId: superAdmin.id,
                    ipAddress: req.ip,
                },
            });

            res.json(successResponse('Broadcast sent', {
                broadcast,
                recipientCount: validRecipients.length,
            }));
        } catch (error) {
            next(error);
        }
    }

    /**
     * Get Single Broadcast
     * GET /super-admin/broadcast/:id
     */
    async getBroadcast(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const { id } = req.params;

            const broadcast = await masterDb.broadcastMessage.findUnique({
                where: { id: String(id) },
            });

            if (!broadcast) {
                res.status(404).json({ success: false, message: 'Broadcast not found' });
                return;
            }

            res.json(successResponse('Broadcast', { broadcast }));
        } catch (error) {
            next(error);
        }
    }

    // ============================================
    // SUPPORT TICKETS
    // ============================================

    /**
     * Get All Tickets
     * GET /super-admin/tickets
     */
    async getTickets(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const { status, priority, assignedTo, search } = req.query;

            const where: any = {};
            if (status) where.status = status;
            if (priority) where.priority = priority;
            if (assignedTo) where.assignedTo = assignedTo;
            if (search) {
                where.OR = [
                    { subject: { contains: search as string, mode: 'insensitive' } },
                    { ticketNumber: { contains: search as string, mode: 'insensitive' } },
                ];
            }

            const tickets = await masterDb.supportTicket.findMany({
                where,
                orderBy: { createdAt: 'desc' },
                include: {
                    _count: { select: { responses: true } },
                },
            });

            // Stats
            const stats = {
                total: await masterDb.supportTicket.count(),
                open: await masterDb.supportTicket.count({ where: { status: 'OPEN' } }),
                inProgress: await masterDb.supportTicket.count({ where: { status: 'IN_PROGRESS' } }),
                resolved: await masterDb.supportTicket.count({ where: { status: 'RESOLVED' } }),
            };

            res.json(successResponse('Support Tickets', { tickets, stats }));
        } catch (error) {
            next(error);
        }
    }

    /**
     * Get Single Ticket
     * GET /super-admin/tickets/:id
     */
    async getTicket(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const { id } = req.params;

            const ticket = await masterDb.supportTicket.findUnique({
                where: { id: String(id) },
                include: {
                    responses: {
                        orderBy: { createdAt: 'asc' },
                    },
                },
            });

            if (!ticket) {
                res.status(404).json({ success: false, message: 'Ticket not found' });
                return;
            }

            res.json(successResponse('Ticket', { ticket }));
        } catch (error) {
            next(error);
        }
    }

    /**
     * Update Ticket
     * PUT /super-admin/tickets/:id
     */
    async updateTicket(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const superAdmin = (req as any).superAdmin;
            const { id } = req.params;
            const { status, priority, assignedTo } = req.body;

            const ticket = await masterDb.supportTicket.findUnique({
                where: { id: String(id) },
            });

            if (!ticket) {
                res.status(404).json({ success: false, message: 'Ticket not found' });
                return;
            }

            const updateData: any = {};
            if (status) {
                updateData.status = status;
                if (status === 'RESOLVED') updateData.resolvedAt = new Date();
            }
            if (priority) updateData.priority = priority;
            if (assignedTo !== undefined) {
                if (assignedTo) {
                    const assignee = await masterDb.superAdmin.findUnique({ where: { id: assignedTo } });
                    if (assignee) {
                        updateData.assignedTo = assignedTo;
                        updateData.assignedToName = `${assignee.firstName} ${assignee.lastName}`;
                    }
                } else {
                    updateData.assignedTo = null;
                    updateData.assignedToName = null;
                }
            }

            const updated = await masterDb.supportTicket.update({
                where: { id: String(id) },
                data: updateData,
            });

            // Log action
            await masterDb.platformAuditLog.create({
                data: {
                    action: 'UPDATE_TICKET',
                    description: `Updated ticket ${ticket.ticketNumber}`,
                    superAdminId: superAdmin.id,
                    ipAddress: req.ip,
                    metadata: updateData,
                },
            });

            res.json(successResponse('Ticket updated', { ticket: updated }));
        } catch (error) {
            next(error);
        }
    }

    /**
     * Respond to Ticket
     * POST /super-admin/tickets/:id/respond
     */
    async respondToTicket(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const superAdmin = (req as any).superAdmin;
            const { id } = req.params;
            const { message } = req.body;

            if (!message?.trim()) {
                res.status(400).json({ success: false, message: 'Message is required' });
                return;
            }

            const ticket = await masterDb.supportTicket.findUnique({
                where: { id: String(id) },
            });

            if (!ticket) {
                res.status(404).json({ success: false, message: 'Ticket not found' });
                return;
            }

            // Create response
            const response = await masterDb.ticketResponse.create({
                data: {
                    ticketId: String(id),
                    message: message.trim(),
                    authorType: 'SUPER_ADMIN',
                    authorId: superAdmin.id,
                    authorName: `${superAdmin.firstName} ${superAdmin.lastName}`,
                },
            });

            // Update ticket status to IN_PROGRESS if it was OPEN
            if (ticket.status === 'OPEN') {
                await masterDb.supportTicket.update({
                    where: { id: String(id) },
                    data: { status: 'IN_PROGRESS' },
                });
            }

            res.json(successResponse('Response added', { response }));
        } catch (error) {
            next(error);
        }
    }
}





// Helper function - generates alphanumeric password (no special chars to avoid URL encoding issues)
function generateRandomPassword(length: number): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let password = '';
    for (let i = 0; i < length; i++) {
        password += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return password;
}

// Helper function - generates cryptographically secure key
function generateSecureKey(bytes: number): string {
    const crypto = require('crypto');
    return crypto.randomBytes(bytes).toString('hex');
}

export const superAdminController = new SuperAdminController();
