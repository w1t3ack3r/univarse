// Super Admin Routes
// Platform-level administration endpoints

import { Router } from 'express';
import { superAdminController } from '../controllers/super-admin.controller';
import { authenticateSuperAdmin } from '../middleware/super-admin.middleware';
import { body } from 'express-validator';

const router = Router();

// ===========================================
// PUBLIC ROUTES (Super Admin login)
// ===========================================

router.post('/login', [
    body('email').isEmail().withMessage('Valid email required'),
    body('password').notEmpty().withMessage('Password required'),
], superAdminController.login);

// ===========================================
// PROTECTED ROUTES
// ===========================================

// Apply Super Admin auth middleware
router.use(authenticateSuperAdmin);

// Institution Management
router.get('/institutions', superAdminController.getAllInstitutions);
router.post('/institutions', [
    body('code').trim().notEmpty().withMessage('Institution code required'),
    body('name').trim().notEmpty().withMessage('Institution name required'),
    body('subdomain').trim().notEmpty().withMessage('Subdomain required'),
], superAdminController.createInstitution);
router.get('/institutions/:id', superAdminController.getInstitution);
router.put('/institutions/:id', superAdminController.updateInstitution);
router.delete('/institutions/:id', superAdminController.deleteInstitution);

// Database Provisioning
router.post('/institutions/:id/provision', superAdminController.provisionDatabase);
router.post('/institutions/:id/migrate', superAdminController.runMigrations);

// Institution Lifecycle Management
router.post('/institutions/:id/suspend', superAdminController.suspendInstitution);
router.post('/institutions/:id/resume', superAdminController.resumeInstitution);
router.post('/institutions/:id/initiate-deletion', superAdminController.initiateInstitutionDeletion);
router.post('/institutions/:id/cancel-deletion', superAdminController.cancelInstitutionDeletion);

// IT Admin Management for Institution
router.get('/institutions/:id/admins', superAdminController.getInstitutionAdmins);
router.post('/institutions/:id/regenerate-credentials', superAdminController.regenerateITAdminCredentials);

// Stats & Monitoring
router.get('/stats', superAdminController.getPlatformStats);
router.get('/connections', superAdminController.getConnectionStats);
router.get('/audit-logs', superAdminController.getAuditLogs);

// Super Admin Management
router.get('/admins', superAdminController.getAllSuperAdmins);
router.post('/admins', [
    body('email').isEmail().withMessage('Valid email required'),
    body('password').isLength({ min: 8 }).withMessage('Password min 8 chars'),
    body('firstName').trim().notEmpty(),
    body('lastName').trim().notEmpty(),
], superAdminController.createSuperAdmin);

// Platform Settings
router.get('/settings', superAdminController.getAllSettings);
router.get('/settings/:category', superAdminController.getSettingsByCategory);
router.put('/settings/:key', superAdminController.updateSetting);
router.post('/settings/seed', superAdminController.seedDefaultSettings);

// Platform Announcements
router.get('/announcements', superAdminController.getAllAnnouncements);
router.post('/announcements', superAdminController.createAnnouncement);
router.put('/announcements/:id', superAdminController.updateAnnouncement);
router.delete('/announcements/:id', superAdminController.deleteAnnouncement);

// Two-Factor Authentication
router.get('/2fa/status', superAdminController.get2FAStatus);
router.post('/2fa/setup', superAdminController.setup2FA);
router.post('/2fa/verify-setup', [
    body('token').isLength({ min: 6, max: 6 }).withMessage('Token must be 6 digits'),
], superAdminController.verifySetup2FA);
router.post('/2fa/disable', [
    body('password').notEmpty().withMessage('Password required'),
    body('token').notEmpty().withMessage('2FA token or recovery code required'),
], superAdminController.disable2FA);
router.post('/2fa/recovery-codes', superAdminController.regenerateRecoveryCodes);

// Session Management
router.get('/sessions', superAdminController.getSessions);
router.delete('/sessions/:id', superAdminController.terminateSession);
router.delete('/sessions', superAdminController.terminateAllSessions);

// IP Whitelisting
router.get('/security/ip-whitelist', superAdminController.getIPWhitelist);
router.put('/security/ip-whitelist', superAdminController.updateIPWhitelist);
router.post('/security/ip-whitelist/test', superAdminController.testIPAddress);

// Analytics
router.get('/analytics/overview', superAdminController.getAnalyticsOverview);
router.get('/analytics/trends', superAdminController.getAnalyticsTrends);
router.get('/analytics/institutions', superAdminController.getInstitutionAnalytics);

// Broadcast / Mass Communication
router.get('/broadcast', superAdminController.getBroadcasts);
router.post('/broadcast', superAdminController.sendBroadcast);
router.get('/broadcast/:id', superAdminController.getBroadcast);

// Support Tickets
router.get('/tickets', superAdminController.getTickets);
router.get('/tickets/:id', superAdminController.getTicket);
router.put('/tickets/:id', superAdminController.updateTicket);
router.post('/tickets/:id/respond', superAdminController.respondToTicket);

export default router;

// ===========================================
// PUBLIC 2FA VERIFICATION ROUTE
// This is exported separately and added in index.ts
// ===========================================
export const verify2FARoute = Router();
verify2FARoute.post('/verify-2fa', [
    body('email').isEmail().withMessage('Valid email required'),
    body('token').notEmpty().withMessage('Token required'),
], superAdminController.verify2FALogin);
