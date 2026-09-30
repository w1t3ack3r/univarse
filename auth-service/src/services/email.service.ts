// Email Notification Service
// Handles all platform email communications

import nodemailer from 'nodemailer';

interface EmailConfig {
    to: string;
    subject: string;
    html: string;
    text?: string;
}

interface ITAdminCredentials {
    institutionName: string;
    email: string;
    temporaryPassword: string;
    loginUrl: string;
}

interface DeletionWarning {
    institutionName: string;
    adminEmail: string;
    daysRemaining: number;
    scheduledDate: Date;
    cancelUrl: string;
}

interface SuspensionNotice {
    institutionName: string;
    adminEmail: string;
    reason?: string;
    contactEmail: string;
}

class EmailService {
    private transporter: nodemailer.Transporter;
    private fromEmail: string;
    private fromName: string;

    constructor() {
        // Configure transporter based on environment
        this.fromEmail = process.env.EMAIL_FROM || 'noreply@univarse.com';
        this.fromName = process.env.EMAIL_FROM_NAME || 'UniVarse Platform';

        if (process.env.NODE_ENV === 'production') {
            // Production: Use actual SMTP
            this.transporter = nodemailer.createTransport({
                host: process.env.SMTP_HOST,
                port: parseInt(process.env.SMTP_PORT || '587'),
                secure: process.env.SMTP_SECURE === 'true',
                auth: {
                    user: process.env.SMTP_USER,
                    pass: process.env.SMTP_PASS,
                },
            });
        } else {
            // Development: Use Ethereal (fake email)
            this.transporter = nodemailer.createTransport({
                host: 'smtp.ethereal.email',
                port: 587,
                auth: {
                    user: process.env.ETHEREAL_USER || 'test@ethereal.email',
                    pass: process.env.ETHEREAL_PASS || 'testpass',
                },
            });
        }
    }

    /**
     * Send a generic email
     */
    async send(config: EmailConfig): Promise<boolean> {
        try {
            const info = await this.transporter.sendMail({
                from: `"${this.fromName}" <${this.fromEmail}>`,
                to: config.to,
                subject: config.subject,
                html: config.html,
                text: config.text || this.stripHtml(config.html),
            });

            console.log(`[Email] Sent to ${config.to}: ${info.messageId}`);

            // In development, log the preview URL
            if (process.env.NODE_ENV !== 'production') {
                console.log(`[Email] Preview: ${nodemailer.getTestMessageUrl(info)}`);
            }

            return true;
        } catch (error: any) {
            console.error(`[Email] Failed to send to ${config.to}:`, error.message);
            return false;
        }
    }

    /**
     * Send IT Admin welcome email with credentials
     */
    async sendITAdminWelcome(data: ITAdminCredentials): Promise<boolean> {
        const html = `
            <div style="font-family: 'Poppins', Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #F4F6F0; padding: 40px;">
                <div style="background: #485550; padding: 30px; border-radius: 12px 12px 0 0; text-align: center;">
                    <h1 style="color: #C0EB6A; margin: 0; font-size: 28px;">Welcome to UniVarse</h1>
                </div>
                <div style="background: white; padding: 30px; border-radius: 0 0 12px 12px;">
                    <h2 style="color: #485550; margin-top: 0;">Your IT Admin Account is Ready!</h2>
                    <p style="color: #666;">Congratulations! Your institution <strong>${data.institutionName}</strong> has been set up on the UniVarse platform.</p>
                    
                    <div style="background: #F4F6F0; padding: 20px; border-radius: 8px; margin: 20px 0;">
                        <h3 style="color: #485550; margin-top: 0;">Your Login Credentials</h3>
                        <p style="margin: 8px 0;"><strong>Email:</strong> ${data.email}</p>
                        <p style="margin: 8px 0;"><strong>Temporary Password:</strong> <code style="background: #485550; color: #C0EB6A; padding: 4px 8px; border-radius: 4px;">${data.temporaryPassword}</code></p>
                    </div>
                    
                    <p style="color: #EF4444; font-weight: 500;">⚠️ Please change your password immediately after first login.</p>
                    
                    <a href="${data.loginUrl}" style="display: inline-block; background: #C0EB6A; color: #485550; padding: 14px 28px; text-decoration: none; border-radius: 8px; font-weight: 600; margin: 20px 0;">Login to Your Portal</a>
                    
                    <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">
                    <p style="color: #999; font-size: 12px;">This is an automated message from UniVarse. If you did not expect this email, please ignore it.</p>
                </div>
            </div>
        `;

        return this.send({
            to: data.email,
            subject: `Welcome to UniVarse - ${data.institutionName} IT Admin Account`,
            html,
        });
    }

    /**
     * Send deletion warning email
     */
    async sendDeletionWarning(data: DeletionWarning): Promise<boolean> {
        const html = `
            <div style="font-family: 'Poppins', Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #F4F6F0; padding: 40px;">
                <div style="background: #EF4444; padding: 30px; border-radius: 12px 12px 0 0; text-align: center;">
                    <h1 style="color: white; margin: 0; font-size: 24px;">⚠️ Institution Deletion Warning</h1>
                </div>
                <div style="background: white; padding: 30px; border-radius: 0 0 12px 12px;">
                    <h2 style="color: #485550; margin-top: 0;">Action Required</h2>
                    <p style="color: #666;">Your institution <strong>${data.institutionName}</strong> is scheduled for deletion.</p>
                    
                    <div style="background: #FEF2F2; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #EF4444;">
                        <p style="margin: 0; font-size: 24px; color: #EF4444; font-weight: bold;">${data.daysRemaining} days remaining</p>
                        <p style="margin: 8px 0 0 0; color: #666;">Scheduled deletion: ${data.scheduledDate.toLocaleDateString()}</p>
                    </div>
                    
                    <p style="color: #666;">If this is a mistake or you want to cancel the deletion, please click the button below or contact support immediately.</p>
                    
                    <a href="${data.cancelUrl}" style="display: inline-block; background: #485550; color: white; padding: 14px 28px; text-decoration: none; border-radius: 8px; font-weight: 600; margin: 20px 0;">Cancel Deletion</a>
                    
                    <p style="color: #EF4444; font-size: 14px;"><strong>Warning:</strong> After deletion, all institution data including users, courses, and records will be permanently removed.</p>
                </div>
            </div>
        `;

        return this.send({
            to: data.adminEmail,
            subject: `⚠️ URGENT: ${data.institutionName} - ${data.daysRemaining} Days Until Deletion`,
            html,
        });
    }

    /**
     * Send suspension notification
     */
    async sendSuspensionNotice(data: SuspensionNotice): Promise<boolean> {
        const html = `
            <div style="font-family: 'Poppins', Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #F4F6F0; padding: 40px;">
                <div style="background: #F59E0B; padding: 30px; border-radius: 12px 12px 0 0; text-align: center;">
                    <h1 style="color: white; margin: 0; font-size: 24px;">Institution Suspended</h1>
                </div>
                <div style="background: white; padding: 30px; border-radius: 0 0 12px 12px;">
                    <h2 style="color: #485550; margin-top: 0;">Service Temporarily Unavailable</h2>
                    <p style="color: #666;">Your institution <strong>${data.institutionName}</strong> has been temporarily suspended on the UniVarse platform.</p>
                    
                    ${data.reason ? `
                    <div style="background: #FEF3C7; padding: 20px; border-radius: 8px; margin: 20px 0;">
                        <p style="margin: 0; color: #92400E;"><strong>Reason:</strong> ${data.reason}</p>
                    </div>
                    ` : ''}
                    
                    <p style="color: #666;">During suspension, all users will be unable to log in to the platform. If you believe this is an error or need assistance, please contact support.</p>
                    
                    <a href="mailto:${data.contactEmail}" style="display: inline-block; background: #485550; color: white; padding: 14px 28px; text-decoration: none; border-radius: 8px; font-weight: 600; margin: 20px 0;">Contact Support</a>
                </div>
            </div>
        `;

        return this.send({
            to: data.adminEmail,
            subject: `Institution Suspended - ${data.institutionName}`,
            html,
        });
    }

    /**
     * Send resume notification
     */
    async sendResumeNotice(institutionName: string, adminEmail: string, loginUrl: string): Promise<boolean> {
        const html = `
            <div style="font-family: 'Poppins', Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #F4F6F0; padding: 40px;">
                <div style="background: #10B981; padding: 30px; border-radius: 12px 12px 0 0; text-align: center;">
                    <h1 style="color: white; margin: 0; font-size: 24px;">✓ Institution Restored</h1>
                </div>
                <div style="background: white; padding: 30px; border-radius: 0 0 12px 12px;">
                    <h2 style="color: #485550; margin-top: 0;">Your Service is Active</h2>
                    <p style="color: #666;">Good news! Your institution <strong>${institutionName}</strong> has been restored and is now fully operational.</p>
                    
                    <p style="color: #666;">All users can now log in and access the platform as normal.</p>
                    
                    <a href="${loginUrl}" style="display: inline-block; background: #C0EB6A; color: #485550; padding: 14px 28px; text-decoration: none; border-radius: 8px; font-weight: 600; margin: 20px 0;">Go to Portal</a>
                </div>
            </div>
        `;

        return this.send({
            to: adminEmail,
            subject: `Service Restored - ${institutionName}`,
            html,
        });
    }

    /**
     * Send credentials reset email to IT Admin
     */
    async sendCredentialsReset(data: {
        institutionName: string;
        email: string;
        temporaryPassword: string;
        loginUrl: string;
    }): Promise<boolean> {
        const html = `
            <div style="font-family: 'Poppins', Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #F4F6F0; padding: 40px;">
                <div style="background: #485550; padding: 30px; border-radius: 12px 12px 0 0; text-align: center;">
                    <h1 style="color: #C0EB6A; margin: 0; font-size: 24px;">🔐 Password Reset</h1>
                </div>
                <div style="background: white; padding: 30px; border-radius: 0 0 12px 12px;">
                    <h2 style="color: #485550; margin-top: 0;">Your Password Has Been Reset</h2>
                    <p style="color: #666;">Your IT Admin password for <strong>${data.institutionName}</strong> has been reset by a Super Admin.</p>
                    
                    <div style="background: #F4F6F0; padding: 20px; border-radius: 8px; margin: 20px 0;">
                        <h3 style="color: #485550; margin-top: 0;">Your New Login Credentials</h3>
                        <p style="margin: 8px 0;"><strong>Email:</strong> ${data.email}</p>
                        <p style="margin: 8px 0;"><strong>Temporary Password:</strong> <code style="background: #485550; color: #C0EB6A; padding: 4px 8px; border-radius: 4px;">${data.temporaryPassword}</code></p>
                    </div>
                    
                    <p style="color: #EF4444; font-weight: 500;">⚠️ You are required to change this password immediately after logging in.</p>
                    
                    <a href="${data.loginUrl}" style="display: inline-block; background: #C0EB6A; color: #485550; padding: 14px 28px; text-decoration: none; border-radius: 8px; font-weight: 600; margin: 20px 0;">Login to Your Portal</a>
                    
                    <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">
                    <p style="color: #999; font-size: 12px;">If you did not request this password reset, please contact your system administrator immediately.</p>
                </div>
            </div>
        `;

        return this.send({
            to: data.email,
            subject: `Password Reset - ${data.institutionName} IT Admin`,
            html,
        });
    }

    private stripHtml(html: string): string {
        return html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
    }
}

export const emailService = new EmailService();
