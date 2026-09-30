// Super Admin Authentication Middleware
// Protects routes that require Super Admin access

import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { masterDb } from '../config/master-db';
import { config } from '../config';

interface SuperAdminPayload {
    userId: string;
    email: string;
    role: 'SUPER_ADMIN';
}

declare global {
    namespace Express {
        interface Request {
            superAdmin?: {
                id: string;
                email: string;
                firstName: string;
                lastName: string;
            };
        }
    }
}

export async function authenticateSuperAdmin(
    req: Request,
    res: Response,
    next: NextFunction
): Promise<void> {
    try {
        const authHeader = req.headers.authorization;

        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            res.status(401).json({
                success: false,
                message: 'Authorization header required',
            });
            return;
        }

        const token = authHeader.split(' ')[1];

        // Verify token
        const decoded = jwt.verify(token, config.jwt.secret) as SuperAdminPayload;

        if (decoded.role !== 'SUPER_ADMIN') {
            res.status(403).json({
                success: false,
                message: 'Super Admin access required',
            });
            return;
        }

        // Get admin from Master DB
        const admin = await masterDb.superAdmin.findUnique({
            where: { id: decoded.userId },
            select: {
                id: true,
                email: true,
                firstName: true,
                lastName: true,
                isActive: true,
            },
        });

        if (!admin) {
            res.status(401).json({
                success: false,
                message: 'Super Admin not found',
            });
            return;
        }

        if (!admin.isActive) {
            res.status(403).json({
                success: false,
                message: 'Account is inactive',
            });
            return;
        }

        // Attach to request
        req.superAdmin = {
            id: admin.id,
            email: admin.email,
            firstName: admin.firstName,
            lastName: admin.lastName,
        };

        next();
    } catch (error: any) {
        if (error.name === 'TokenExpiredError') {
            res.status(401).json({ success: false, message: 'Token expired' });
            return;
        }

        if (error.name === 'JsonWebTokenError') {
            res.status(401).json({ success: false, message: 'Invalid token' });
            return;
        }

        res.status(500).json({ success: false, message: 'Authentication failed' });
    }
}
