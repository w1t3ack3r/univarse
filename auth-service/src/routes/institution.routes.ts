import { Router } from 'express';
import { institutionController } from '../controllers/institution.controller';

const router = Router();

// Public routes - no auth required
router.get('/', institutionController.getAll);
router.get('/:id', institutionController.getById);

export default router;
