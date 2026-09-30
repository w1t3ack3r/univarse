import { Response, NextFunction } from 'express';
import { Role } from '@prisma/client';
import { AuthenticatedRequest, JWTPayload } from '../types';
import { verifyAccessToken } from '../utils/auth';
import { ForbiddenError, UnauthorizedError } from '../utils/errors';

/**
 * Authenticate JWT token
 */
export const authenticate = (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
): void => {
    try {
        const authHeader = req.headers.authorization;

        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            throw new UnauthorizedError('No token provided');
        }

        const token = authHeader.split(' ')[1];
        const payload = verifyAccessToken(token);

        req.user = payload;
        next();
    } catch (error) {
        if (error instanceof UnauthorizedError) {
            res.status(401).json({ success: false, message: error.message });
        } else {
            res.status(401).json({ success: false, message: 'Invalid or expired token' });
        }
    }
};

/**
 * Authorize by roles
 */
export const authorize = (...allowedRoles: Role[]) => {
    return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
        if (!req.user) {
            res.status(401).json({ success: false, message: 'Not authenticated' });
            return;
        }

        if (!allowedRoles.includes(req.user.role)) {
            res.status(403).json({
                success: false,
                message: 'You do not have permission to perform this action'
            });
            return;
        }

        next();
    };
};

/**
 * Ensure user belongs to institution
 */
export const ensureInstitution = (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
): void => {
    const institutionId = req.params.institutionId || req.body.institutionId;

    if (!req.user) {
        res.status(401).json({ success: false, message: 'Not authenticated' });
        return;
    }

    // Super admins can access any institution
    if (req.user.role === Role.SUPER_ADMIN) {
        next();
        return;
    }

    if (req.user.institutionId !== institutionId) {
        res.status(403).json({
            success: false,
            message: 'You do not have access to this institution'
        });
        return;
    }

    next();
};
