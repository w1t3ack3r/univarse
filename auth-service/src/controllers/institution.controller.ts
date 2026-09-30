import { Request, Response } from 'express';
import { masterDb } from '../config/master-db';
import { successResponse } from '../utils/errors';

export class InstitutionController {
    /**
     * Get all active AND provisioned institutions (public endpoint for login/register)
     * Only returns institutions that have been provisioned (have a working database)
     */
    async getAll(req: Request, res: Response) {
        const institutions = await masterDb.institution.findMany({
            where: {
                isActive: true,
                isProvisioned: true, // Only provisioned institutions can be logged into
            },
            select: {
                id: true,
                name: true,
                code: true,
                logo: true,
            },
            orderBy: { name: 'asc' },
        });

        return res.json(successResponse('Institutions retrieved successfully', institutions));
    }

    /**
     * Get institution by ID
     */
    async getById(req: Request, res: Response) {
        const id = req.params.id as string;

        const institution = await masterDb.institution.findUnique({
            where: { id },
            select: {
                id: true,
                name: true,
                code: true,
                logo: true,
                address: true,
                phone: true,
                email: true,
                website: true,
                isProvisioned: true,
            },
        });

        if (!institution) {
            return res.status(404).json({
                success: false,
                message: 'Institution not found',
            });
        }

        return res.json(successResponse('Institution retrieved successfully', institution));
    }
}

export const institutionController = new InstitutionController();
