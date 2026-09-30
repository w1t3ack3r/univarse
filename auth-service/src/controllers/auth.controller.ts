import { Request, Response, NextFunction } from 'express';
import { validationResult } from 'express-validator';
import { authService } from '../services/auth.service';
import { AuthenticatedRequest, RegisterDTO, LoginDTO } from '../types';
import { successResponse, BadRequestError } from '../utils/errors';

export class AuthController {
    /**
     * Register new user
     * POST /auth/register
     */
    async register(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                res.status(400).json({
                    success: false,
                    message: 'Validation failed',
                    errors: errors.array(),
                });
                return;
            }

            const data: RegisterDTO = req.body;
            const ipAddress = req.ip || req.socket.remoteAddress;
            const userAgent = req.get('User-Agent');

            const result = await authService.register(data, ipAddress, userAgent);

            res.status(201).json(successResponse('Registration successful', result));
        } catch (error) {
            next(error);
        }
    }

    /**
     * Login user
     * POST /auth/login
     */
    async login(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                res.status(400).json({
                    success: false,
                    message: 'Validation failed',
                    errors: errors.array(),
                });
                return;
            }

            const data: LoginDTO = req.body;
            const ipAddress = req.ip || req.socket.remoteAddress;
            const userAgent = req.get('User-Agent');

            const result = await authService.login(data, ipAddress, userAgent);

            res.json(successResponse('Login successful', result));
        } catch (error) {
            next(error);
        }
    }

    /**
     * Logout user
     * POST /auth/logout
     */
    async logout(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const { refreshToken } = req.body;
            const ipAddress = req.ip || req.socket.remoteAddress;
            const userAgent = req.get('User-Agent');

            if (!req.user) {
                res.status(401).json({ success: false, message: 'Not authenticated' });
                return;
            }

            await authService.logout(refreshToken, req.user.userId, ipAddress, userAgent);

            res.json(successResponse('Logout successful'));
        } catch (error) {
            next(error);
        }
    }

    /**
     * Refresh tokens
     * POST /auth/refresh
     */
    async refresh(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                res.status(400).json({
                    success: false,
                    message: 'Validation failed',
                    errors: errors.array(),
                });
                return;
            }

            const { refreshToken } = req.body;
            const result = await authService.refreshTokens(refreshToken);

            res.json(successResponse('Tokens refreshed', result));
        } catch (error) {
            next(error);
        }
    }

    /**
     * Request password reset
     * POST /auth/password-reset/request
     */
    async requestPasswordReset(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                res.status(400).json({
                    success: false,
                    message: 'Validation failed',
                    errors: errors.array(),
                });
                return;
            }

            const { email, institutionId } = req.body;
            const message = await authService.requestPasswordReset(email, institutionId);

            res.json(successResponse(message));
        } catch (error) {
            next(error);
        }
    }

    /**
     * Reset password with token
     * POST /auth/password-reset/confirm
     */
    async resetPassword(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                res.status(400).json({
                    success: false,
                    message: 'Validation failed',
                    errors: errors.array(),
                });
                return;
            }

            const { token, password } = req.body;
            const ipAddress = req.ip || req.socket.remoteAddress;
            const userAgent = req.get('User-Agent');

            await authService.resetPassword(token, password, ipAddress, userAgent);

            res.json(successResponse('Password reset successful'));
        } catch (error) {
            next(error);
        }
    }

    /**
     * Get current user profile
     * GET /auth/me
     */
    async me(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            if (!req.user) {
                res.status(401).json({ success: false, message: 'Not authenticated' });
                return;
            }

            const user = await authService.getUserWithProfiles(req.user.userId);

            if (!user) {
                res.status(404).json({ success: false, message: 'User not found' });
                return;
            }

            // Remove password from response
            const { password, ...safeUser } = user;

            res.json(successResponse('User profile retrieved', safeUser));
        } catch (error) {
            next(error);
        }
    }

    /**
     * Change password on first login (temporary password)
     * POST /auth/change-password-first
     */
    async changePasswordFirstLogin(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                res.status(400).json({
                    success: false,
                    message: 'Validation failed',
                    errors: errors.array(),
                });
                return;
            }

            if (!req.user) {
                res.status(401).json({ success: false, message: 'Not authenticated' });
                return;
            }

            const { currentPassword, newPassword } = req.body;
            const ipAddress = req.ip || req.socket.remoteAddress;
            const userAgent = req.get('User-Agent');

            const result = await authService.changePasswordFirstLogin(
                req.user.userId,
                currentPassword,
                newPassword,
                ipAddress,
                userAgent
            );

            res.json(successResponse('Password changed successfully', result));
        } catch (error) {
            next(error);
        }
    }
}

export const authController = new AuthController();
