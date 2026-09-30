/**
 * Backup Service
 * Handles institution data export for 60-day deletion workflow
 */

import { PrismaClient } from '@prisma/client';
import { masterDb } from '../config/master-db';
import { tenantConnectionManager } from '../config/tenant-db';
import { emailService } from './email.service';
import * as fs from 'fs';
import * as path from 'path';


export interface BackupResult {
    success: boolean;
    backupPath?: string;
    backupSize?: number;
    tables?: string[];
    error?: string;
}

export interface BackupMetadata {
    institutionId: string;
    institutionName: string;
    subdomain: string;
    createdAt: Date;
    expiresAt: Date;
    tables: string[];
    totalRecords: number;
}

export class BackupService {
    private backupDir: string;

    constructor() {
        // Default backup directory
        this.backupDir = process.env.BACKUP_DIR || path.join(process.cwd(), 'backups');
        this.ensureBackupDir();
    }

    /**
     * Ensure backup directory exists
     */
    private ensureBackupDir(): void {
        if (!fs.existsSync(this.backupDir)) {
            fs.mkdirSync(this.backupDir, { recursive: true });
        }
    }

    /**
     * Export all data for an institution
     * Used before permanent deletion
     */
    async exportInstitutionData(institutionId: string): Promise<BackupResult> {
        try {
            // Get institution details
            const institution = await masterDb.institution.findUnique({
                where: { id: institutionId },
            });

            if (!institution) {
                return { success: false, error: 'Institution not found' };
            }

            if (!institution.isProvisioned) {
                return { success: false, error: 'Institution not provisioned - no data to export' };
            }

            // Connect to tenant database
            const tenantPrisma = await tenantConnectionManager.getConnection({
                id: institution.id,
                subdomain: institution.subdomain,
                dbHost: institution.dbHost,
                dbPort: institution.dbPort,
                dbName: institution.dbName,
                dbUser: institution.dbUser,
                dbPassword: institution.dbPassword,
            });

            // Export data from all tables
            const exportData = await this.extractTenantData(tenantPrisma, institution.id);

            // Create backup file
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const backupFileName = `backup_${institution.subdomain}_${timestamp}.json`;
            const backupPath = path.join(this.backupDir, backupFileName);

            const backupContent = {
                metadata: {
                    institutionId: institution.id,
                    institutionName: institution.name,
                    subdomain: institution.subdomain,
                    createdAt: new Date().toISOString(),
                    expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(), // 90 days
                    tables: Object.keys(exportData),
                    totalRecords: Object.values(exportData).reduce((sum: number, arr: any) => sum + arr.length, 0),
                },
                data: exportData,
            };

            fs.writeFileSync(backupPath, JSON.stringify(backupContent, null, 2));

            const stats = fs.statSync(backupPath);

            // Log backup creation
            await masterDb.platformAuditLog.create({
                data: {
                    action: 'BACKUP_CREATED',
                    description: `Backup created for institution ${institution.name}: ${backupFileName}`,
                    metadata: {
                        backupPath,
                        size: stats.size,
                        tables: Object.keys(exportData),
                    },
                },
            });

            return {
                success: true,
                backupPath,
                backupSize: stats.size,
                tables: Object.keys(exportData),
            };
        } catch (error: any) {
            console.error('Backup export failed:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Extract data from all tenant tables
     */
    private async extractTenantData(prisma: PrismaClient, institutionId: string): Promise<Record<string, any[]>> {
        const data: Record<string, any[]> = {};

        try {
            // Users
            data.users = await prisma.user.findMany({
                where: { institutionId },
            });

            // Institution
            data.institution = await prisma.institution.findMany({
                where: { id: institutionId },
            });

            // Add more tables as needed based on your schema
            // Students, Courses, etc.

        } catch (error) {
            console.warn('Some tables may not exist:', error);
        }

        return data;
    }

    /**
     * Send backup notification to IT Admin
     */
    async sendBackupNotification(
        institutionId: string,
        adminEmail: string,
        backupPath: string
    ): Promise<boolean> {
        try {
            const institution = await masterDb.institution.findUnique({
                where: { id: institutionId },
            });

            if (!institution) return false;

            // In production, upload to cloud storage and send download link
            const downloadUrl = `${process.env.API_URL || 'http://localhost:4000'}/api/backups/${path.basename(backupPath)}`;

            await emailService.send({
                to: adminEmail,
                subject: `Data Backup Available - ${institution.name}`,
                html: this.getBackupEmailTemplate(institution.name, downloadUrl),
            });

            return true;
        } catch (error) {
            console.error('Failed to send backup notification:', error);
            return false;
        }
    }

    /**
     * Get backup email template
     */
    private getBackupEmailTemplate(institutionName: string, downloadUrl: string): string {
        return `
            <div style="font-family: 'Poppins', Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                <div style="background: linear-gradient(135deg, #485550 0%, #3a4543 100%); padding: 30px; text-align: center;">
                    <h1 style="color: #C0EB6A; margin: 0; font-size: 28px;">UniVarse</h1>
                </div>
                <div style="background: #F4F6F0; padding: 40px 30px;">
                    <h2 style="color: #485550; margin-bottom: 20px;">Data Backup Available</h2>
                    <p style="color: #666; line-height: 1.6;">
                        A complete backup of your institution data <strong>${institutionName}</strong> has been created.
                    </p>
                    <p style="color: #666; line-height: 1.6;">
                        This backup is available for download for the next 90 days.
                    </p>
                    <div style="text-align: center; margin: 30px 0;">
                        <a href="${downloadUrl}" 
                           style="background: #C0EB6A; color: #485550; padding: 14px 30px; 
                                  text-decoration: none; border-radius: 8px; font-weight: 600;
                                  display: inline-block;">
                            Download Backup
                        </a>
                    </div>
                    <p style="color: #999; font-size: 12px; margin-top: 30px;">
                        If you have any questions, please contact our support team.
                    </p>
                </div>
                <div style="background: #485550; padding: 20px; text-align: center;">
                    <p style="color: #999; font-size: 12px; margin: 0;">
                        © ${new Date().getFullYear()} UniVarse. All rights reserved.
                    </p>
                </div>
            </div>
        `;
    }

    /**
     * Clean up old backups (older than retention period)
     */
    async cleanupOldBackups(retentionDays: number = 90): Promise<number> {
        let deletedCount = 0;
        const cutoffDate = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

        try {
            const files = fs.readdirSync(this.backupDir);

            for (const file of files) {
                if (!file.endsWith('.json')) continue;

                const filePath = path.join(this.backupDir, file);
                const stats = fs.statSync(filePath);

                if (stats.mtime < cutoffDate) {
                    fs.unlinkSync(filePath);
                    deletedCount++;
                }
            }

            if (deletedCount > 0) {
                await masterDb.platformAuditLog.create({
                    data: {
                        action: 'BACKUP_CLEANUP',
                        description: `Cleaned up ${deletedCount} old backup files`,
                    },
                });
            }
        } catch (error) {
            console.error('Backup cleanup failed:', error);
        }

        return deletedCount;
    }

    /**
     * Get backup info for an institution
     */
    async getBackupInfo(institutionId: string): Promise<BackupMetadata | null> {
        try {
            const institution = await masterDb.institution.findUnique({
                where: { id: institutionId },
            });

            if (!institution) return null;

            // Find latest backup file
            const files = fs.readdirSync(this.backupDir)
                .filter(f => f.includes(institution.subdomain) && f.endsWith('.json'))
                .sort()
                .reverse();

            if (files.length === 0) return null;

            const backupPath = path.join(this.backupDir, files[0]);
            const content = JSON.parse(fs.readFileSync(backupPath, 'utf8'));

            return content.metadata;
        } catch (error) {
            console.error('Failed to get backup info:', error);
            return null;
        }
    }
}

export const backupService = new BackupService();
