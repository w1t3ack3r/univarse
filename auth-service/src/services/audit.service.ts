import prisma from '../config/database';
import { AuditAction } from '@prisma/client';

interface AuditLogData {
    action: AuditAction;
    description?: string;
    userId?: string;
    institutionId?: string | null;
    ipAddress?: string;
    userAgent?: string;
    metadata?: Record<string, any>;
}

export class AuditService {
    async log(data: AuditLogData): Promise<void> {
        try {
            await prisma.auditLog.create({
                data: {
                    action: data.action,
                    description: data.description,
                    userId: data.userId,
                    institutionId: data.institutionId,
                    ipAddress: data.ipAddress,
                    userAgent: data.userAgent,
                    metadata: data.metadata,
                },
            });
        } catch (error) {
            // Log to console but don't throw - audit logging should not break main flow
            console.error('Failed to create audit log:', error);
        }
    }

    async getLogsByUser(userId: string, limit: number = 50) {
        return prisma.auditLog.findMany({
            where: { userId },
            orderBy: { createdAt: 'desc' },
            take: limit,
        });
    }

    async getLogsByInstitution(institutionId: string, limit: number = 100) {
        return prisma.auditLog.findMany({
            where: { institutionId },
            orderBy: { createdAt: 'desc' },
            take: limit,
        });
    }

    async getLogsByAction(action: AuditAction, institutionId?: string, limit: number = 100) {
        return prisma.auditLog.findMany({
            where: {
                action,
                ...(institutionId && { institutionId }),
            },
            orderBy: { createdAt: 'desc' },
            take: limit,
        });
    }
}

export const auditService = new AuditService();
