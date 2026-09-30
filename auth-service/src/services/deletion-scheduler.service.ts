// Deletion Warning Scheduler Service
// Runs daily to send deletion warning emails at key milestones
// Uses Nigeria/West Africa Time (WAT - UTC+1)

import cron from 'node-cron';
import { masterDb } from '../config/master-db';
import { tenantConnectionManager } from '../config/tenant-db';
import { emailService } from './email.service';

// Warning milestones (days remaining)
const WARNING_MILESTONES = [45, 30, 14, 7, 1];

class DeletionSchedulerService {
    private isRunning = false;

    /**
     * Start the deletion warning cron job
     * Runs daily at midnight Nigeria Time (WAT = UTC+1)
     * Cron: "0 0 * * *" = At 00:00 every day
     * But we offset by -1 hour to account for WAT timezone
     * So we run at 23:00 UTC which is 00:00 WAT
     */
    start(): void {
        // Run at 23:00 UTC = 00:00 WAT (Nigeria Time)
        cron.schedule('0 23 * * *', async () => {
            await this.processWarnings();
        });

        console.log('[DeletionScheduler] Cron job scheduled - runs daily at midnight WAT (23:00 UTC)');
    }

    /**
     * Process all institutions pending deletion and send warnings
     * Can also be called manually for testing
     */
    async processWarnings(): Promise<{ processed: number; emailsSent: number }> {
        if (this.isRunning) {
            console.log('[DeletionScheduler] Already running, skipping...');
            return { processed: 0, emailsSent: 0 };
        }

        this.isRunning = true;
        console.log('[DeletionScheduler] Starting deletion warning check...');

        let processed = 0;
        let emailsSent = 0;

        try {
            // Get all institutions pending deletion
            const institutions = await masterDb.institution.findMany({
                where: {
                    status: 'PENDING_DELETION',
                    deletionScheduledAt: { not: null },
                },
            });

            console.log(`[DeletionScheduler] Found ${institutions.length} institutions pending deletion`);

            for (const institution of institutions) {
                processed++;
                const daysRemaining = this.calculateDaysRemaining(institution.deletionScheduledAt!);

                // Check if this is a warning milestone
                const milestone = this.findMilestone(daysRemaining, institution.deletionWarningsSent);

                if (milestone) {
                    const emailSent = await this.sendWarningEmail(institution, milestone, daysRemaining);
                    if (emailSent) {
                        emailsSent++;
                        // Update warnings count
                        await masterDb.institution.update({
                            where: { id: institution.id },
                            data: { deletionWarningsSent: institution.deletionWarningsSent + 1 },
                        });
                    }
                }
            }

            console.log(`[DeletionScheduler] Complete. Processed: ${processed}, Emails sent: ${emailsSent}`);
        } catch (error) {
            console.error('[DeletionScheduler] Error:', error);
        } finally {
            this.isRunning = false;
        }

        return { processed, emailsSent };
    }

    /**
     * Calculate days remaining until deletion
     */
    private calculateDaysRemaining(deletionDate: Date): number {
        const now = new Date();
        const diffMs = deletionDate.getTime() - now.getTime();
        return Math.ceil(diffMs / (1000 * 60 * 60 * 24));
    }

    /**
     * Find if we've hit a milestone that needs a warning
     * Uses warningsSent count to determine which milestone to check
     */
    private findMilestone(daysRemaining: number, warningsSent: number): number | null {
        // Map warningsSent count to expected milestone index
        // 0 warnings sent -> check for 45 day milestone
        // 1 warning sent -> check for 30 day milestone
        // etc.
        const milestoneIndex = warningsSent;

        if (milestoneIndex >= WARNING_MILESTONES.length) {
            return null; // All warnings sent
        }

        const targetMilestone = WARNING_MILESTONES[milestoneIndex];

        // Send warning if we're at or past the milestone
        if (daysRemaining <= targetMilestone) {
            return targetMilestone;
        }

        return null;
    }

    /**
     * Send warning email to IT Admin
     */
    private async sendWarningEmail(
        institution: any,
        milestone: number,
        daysRemaining: number
    ): Promise<boolean> {
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

            if (!itAdmin) {
                console.log(`[DeletionScheduler] No IT Admin found for ${institution.name}`);
                return false;
            }

            // Construct cancel URL
            const cancelUrl = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/super-admin/institutions`;

            await emailService.sendDeletionWarning({
                institutionName: institution.name,
                adminEmail: itAdmin.email,
                daysRemaining: Math.max(1, daysRemaining), // At least 1 day
                scheduledDate: institution.deletionScheduledAt!,
                cancelUrl,
            });

            console.log(`[DeletionScheduler] Sent ${milestone}-day warning to ${institution.name}`);
            return true;
        } catch (error) {
            console.error(`[DeletionScheduler] Failed to send email for ${institution.name}:`, error);
            return false;
        }
    }
}

export const deletionSchedulerService = new DeletionSchedulerService();
