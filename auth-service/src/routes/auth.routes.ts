import { Router } from 'express';
import { authController } from '../controllers/auth.controller';
import { authenticate } from '../middleware/auth.middleware';
import {
    registerValidator,
    loginValidator,
    refreshTokenValidator,
    requestPasswordResetValidator,
    resetPasswordValidator,
    changePasswordFirstLoginValidator,
} from '../validators/auth.validator';

const router = Router();

// Public routes
router.post('/register', registerValidator, authController.register.bind(authController));
router.post('/login', loginValidator, authController.login.bind(authController));
router.post('/refresh', refreshTokenValidator, authController.refresh.bind(authController));
router.post('/password-reset/request', requestPasswordResetValidator, authController.requestPasswordReset.bind(authController));
router.post('/password-reset/confirm', resetPasswordValidator, authController.resetPassword.bind(authController));

// Protected routes
router.post('/logout', authenticate, authController.logout.bind(authController));
router.get('/me', authenticate, authController.me.bind(authController));
router.post('/change-password-first', authenticate, changePasswordFirstLoginValidator, authController.changePasswordFirstLogin.bind(authController));

export default router;
