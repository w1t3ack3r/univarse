// Tenant Resolution Middleware
// Extracts subdomain and resolves tenant from Master DB

import { Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { masterDb, InstitutionConfig } from '../config/master-db';
import { tenantConnectionManager } from '../config/tenant-db';

// Extend Express Request to include tenant info
declare global {
    namespace Express {
        interface Request {
            tenant?: InstitutionConfig;
            tenantDb?: PrismaClient;
        }
    }
}

/**
 * Extract subdomain from hostname
 * Examples:
 * - unilag.univarse.com -> "unilag"
 * - oau.univarse.com -> "oau"
 * - localhost:4000 -> null (for local dev)
 */
function extractSubdomain(hostname: string): string | null {
    // Remove port if present
    const host = hostname.split(':')[0];

    // Check for localhost (development mode)
    if (host === 'localhost' || host === '127.0.0.1') {
        // In development, check X-Tenant-Subdomain header
        return null;
    }

    // Split hostname by dots
    const parts = host.split('.');

    // Need at least 3 parts: subdomain.domain.tld
    if (parts.length >= 3) {
        return parts[0];
    }

    return null;
}

/**
 * Tenant Resolution Middleware
 * Resolves tenant from subdomain or header and attaches DB connection
 */
export async function resolveTenant(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
        // Try to get subdomain from hostname
        let subdomain = extractSubdomain(req.hostname);

        // Fallback to header for development/testing
        if (!subdomain) {
            subdomain = req.headers['x-tenant-subdomain'] as string | undefined ?? null;
        }

        // If still no subdomain, this might be a super admin request
        if (!subdomain) {
            // Check if this is a super admin route (they don't need tenant)
            if (req.path.startsWith('/api/v1/super-admin') || req.path.startsWith('/api/v1/institutions')) {
                return next();
            }

            res.status(400).json({
                success: false,
                message: 'Tenant subdomain is required. Use X-Tenant-Subdomain header or access via subdomain URL.',
            });
            return;
        }

        // Look up institution in Master DB
        const institution = await masterDb.institution.findUnique({
            where: { subdomain },
        });

        if (!institution) {
            res.status(404).json({
                success: false,
                message: `Institution not found: ${subdomain}`,
            });
            return;
        }

        if (!institution.isActive) {
            res.status(403).json({
                success: false,
                message: 'This institution is currently inactive. Please contact support.',
            });
            return;
        }

        if (!institution.isProvisioned) {
            res.status(503).json({
                success: false,
                message: 'This institution is being set up. Please try again later.',
            });
            return;
        }

        // Get or create tenant database connection
        const tenantDb = await tenantConnectionManager.getConnection({
            id: institution.id,
            subdomain: institution.subdomain,
            dbHost: institution.dbHost,
            dbPort: institution.dbPort,
            dbName: institution.dbName,
            dbUser: institution.dbUser,
            dbPassword: institution.dbPassword,
        });

        // Attach to request
        req.tenant = institution as InstitutionConfig;
        req.tenantDb = tenantDb;

        next();
    } catch (error) {
        console.error('[TenantMiddleware] Error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to resolve tenant',
        });
    }
}

/**
 * Optional tenant middleware (for routes that may or may not have a tenant)
 */
export async function optionalTenant(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
        let subdomain = extractSubdomain(req.hostname);

        if (!subdomain) {
            subdomain = req.headers['x-tenant-subdomain'] as string | undefined ?? null;
        }

        if (subdomain) {
            const institution = await masterDb.institution.findUnique({
                where: { subdomain },
            });

            if (institution && institution.isActive && institution.isProvisioned) {
                const tenantDb = await tenantConnectionManager.getConnection({
                    id: institution.id,
                    subdomain: institution.subdomain,
                    dbHost: institution.dbHost,
                    dbPort: institution.dbPort,
                    dbName: institution.dbName,
                    dbUser: institution.dbUser,
                    dbPassword: institution.dbPassword,
                });

                req.tenant = institution as InstitutionConfig;
                req.tenantDb = tenantDb;
            }
        }

        next();
    } catch (error) {
        console.error('[OptionalTenantMiddleware] Error:', error);
        next();
    }
}
