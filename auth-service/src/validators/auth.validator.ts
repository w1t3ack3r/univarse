import { body } from 'express-validator';
import { Role } from '@prisma/client';

export const registerValidator = [
    body('email')
        .isEmail()
        .normalizeEmail()
        .withMessage('Please provide a valid email'),
    body('password')
        .isLength({ min: 8 })
        .withMessage('Password must be at least 8 characters')
        .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/)
        .withMessage('Password must contain at least one uppercase, one lowercase, and one number'),
    body('firstName')
        .trim()
        .notEmpty()
        .withMessage('First name is required')
        .isLength({ max: 50 })
        .withMessage('First name must be less than 50 characters'),
    body('lastName')
        .trim()
        .notEmpty()
        .withMessage('Last name is required')
        .isLength({ max: 50 })
        .withMessage('Last name must be less than 50 characters'),
    body('role')
        .isIn(Object.values(Role))
        .withMessage('Invalid role'),
    body('institutionId')
        .optional() // Optional for SUPER_ADMIN
        .isUUID()
        .withMessage('Invalid institution ID'),
    body('matricNumber')
        .optional()
        .trim()
        .notEmpty()
        .withMessage('Matric number cannot be empty if provided'),
    body('staffId')
        .optional()
        .trim()
        .notEmpty()
        .withMessage('Staff ID cannot be empty if provided'),
];

export const loginValidator = [
    body('email')
        .isEmail()
        .normalizeEmail()
        .withMessage('Please provide a valid email'),
    body('password')
        .notEmpty()
        .withMessage('Password is required'),
    body('institutionId')
        .optional() // Optional for SUPER_ADMIN login
        .isUUID()
        .withMessage('Invalid institution ID'),
];

export const refreshTokenValidator = [
    body('refreshToken')
        .notEmpty()
        .withMessage('Refresh token is required'),
];

export const requestPasswordResetValidator = [
    body('email')
        .isEmail()
        .normalizeEmail()
        .withMessage('Please provide a valid email'),
    body('institutionId')
        .isUUID()
        .withMessage('Invalid institution ID'),
];

export const resetPasswordValidator = [
    body('token')
        .notEmpty()
        .withMessage('Reset token is required'),
    body('password')
        .isLength({ min: 8 })
        .withMessage('Password must be at least 8 characters')
        .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/)
        .withMessage('Password must contain at least one uppercase, one lowercase, and one number'),
];

export const changePasswordFirstLoginValidator = [
    body('currentPassword')
        .notEmpty()
        .withMessage('Current password is required'),
    body('newPassword')
        .isLength({ min: 8 })
        .withMessage('New password must be at least 8 characters')
        .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/)
        .withMessage('New password must contain at least one uppercase, one lowercase, and one number'),
];
