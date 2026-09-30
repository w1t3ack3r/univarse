/**
 * Tenant Token Middleware
 * Validates tenant-scoped JWT tokens and checks institution status
 */

import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../types';
import { masterDb } from '../config/master-db';
import { UnauthorizedError, ForbiddenError } from '../utils/errors';

/**
 * Validates that the user's token is scoped to a valid, active tenant
 * Checks institution status and tenantSecretKey validity
 */
export const validateTenantScope = async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
): Promise<void> => {
    try {
        if (!req.user) {
            throw new UnauthorizedError('Authentication required');
        }

        const { institutionId } = req.user;

        if (!institutionId) {
            // Super admins may not have institutionId
            if (req.user.role === 'SUPER_ADMIN') {
                next();
                return;
            }
            throw new UnauthorizedError('Token missing institution scope');
        }

        // Fetch institution from master DB
        const institution = await masterDb.institution.findUnique({
            where: { id: institutionId },
            select: {
                id: true,
                status: true,
                isProvisioned: true,
                tenantSecretKey: true,
            },
        });

        if (!institution) {
            throw new UnauthorizedError('Institution not found');
        }

        // Check institution status
        switch (institution.status) {
            case 'SUSPENDED':
                throw new ForbiddenError('Institution is suspended. Please contact support.');
            case 'PENDING_DELETION':
                throw new ForbiddenError('Institution is pending deletion. Access is disabled.');
            case 'DELETED':
                throw new ForbiddenError('Institution no longer exists.');
            case 'PENDING':
                if (!institution.isProvisioned) {
                    throw new ForbiddenError('Institution setup is not complete.');
                }
                break;
        }

        // Attach institution info to request
        (req as any).institution = {
            id: institution.id,
            status: institution.status,
        };

        next();
    } catch (error) {
        if (error instanceof UnauthorizedError) {
            res.status(401).json({ success: false, message: error.message });
        } else if (error instanceof ForbiddenError) {
            res.status(403).json({ success: false, message: error.message });
        } else {
            res.status(500).json({ success: false, message: 'Token validation failed' });
        }
    }
};

/**
 * Validates inter-service calls using tenantSecretKey
 * Used for backend-to-backend communication
 */
export const validateServiceToken = async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
): Promise<void> => {
    try {
        const serviceToken = req.headers['x-service-token'];
        const institutionId = req.headers['x-institution-id'];

        if (!serviceToken || !institutionId) {
            throw new UnauthorizedError('Service authentication required');
        }

        // Verify the service token matches the institution's tenantSecretKey
        const institution = await masterDb.institution.findUnique({
            where: { id: String(institutionId) },
            select: {
                id: true,
                tenantSecretKey: true,
                status: true,
            },
        });

        if (!institution) {
            throw new UnauthorizedError('Invalid institution');
        }

        if (institution.tenantSecretKey !== serviceToken) {
            throw new UnauthorizedError('Invalid service token');
        }

        if (institution.status !== 'ACTIVE') {
            throw new ForbiddenError('Institution is not active');
        }

        (req as any).serviceAuth = {
            institutionId: institution.id,
            authenticated: true,
        };

        next();
    } catch (error) {
        if (error instanceof UnauthorizedError) {
            res.status(401).json({ success: false, message: error.message });
        } else if (error instanceof ForbiddenError) {
            res.status(403).json({ success: false, message: error.message });
        } else {
            res.status(500).json({ success: false, message: 'Service token validation failed' });
        }
    }
};

/**
 * Middleware to ensure request is from an active institution
 * Lighter weight check - just verifies institution is active
 */
export const requireActiveInstitution = async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
): Promise<void> => {
    try {
        const institutionId = req.user?.institutionId || req.params.institutionId || req.body.institutionId;

        if (!institutionId) {
            next(); // Skip for requests without institution context
            return;
        }

        const institution = await masterDb.institution.findUnique({
            where: { id: institutionId },
            select: { status: true },
        });

        if (!institution) {
            throw new UnauthorizedError('Institution not found');
        }

        if (institution.status !== 'ACTIVE' && institution.status !== 'PROVISIONED') {
            throw new ForbiddenError(`Institution access denied (status: ${institution.status})`);
        }

        next();
    } catch (error) {
        if (error instanceof UnauthorizedError) {
            res.status(401).json({ success: false, message: error.message });
        } else if (error instanceof ForbiddenError) {
            res.status(403).json({ success: false, message: error.message });
        } else {
            next(error);
        }
    }
};
