import bcrypt from 'bcryptjs';
import jwt, { SignOptions } from 'jsonwebtoken';
import { config } from '../config';
import { JWTPayload } from '../types';

export const hashPassword = async (password: string): Promise<string> => {
    return bcrypt.hash(password, config.bcryptRounds);
};

export const comparePassword = async (password: string, hash: string): Promise<boolean> => {
    return bcrypt.compare(password, hash);
};

/**
 * Convert duration string (e.g., '7d', '30d', '1h') to seconds
 */
const durationToSeconds = (duration: string): number => {
    const match = duration.match(/^(\d+)([smhdw])$/);
    if (!match) {
        return 7 * 24 * 60 * 60; // Default 7 days
    }

    const value = parseInt(match[1], 10);
    const unit = match[2];

    switch (unit) {
        case 's':
            return value;
        case 'm':
            return value * 60;
        case 'h':
            return value * 60 * 60;
        case 'd':
            return value * 24 * 60 * 60;
        case 'w':
            return value * 7 * 24 * 60 * 60;
        default:
            return 7 * 24 * 60 * 60;
    }
};

export const generateAccessToken = (payload: JWTPayload): string => {
    const options: SignOptions = {
        expiresIn: durationToSeconds(config.jwt.expiresIn),
    };
    return jwt.sign({ ...payload }, config.jwt.secret, options);
};

export const generateRefreshToken = (payload: JWTPayload): string => {
    const options: SignOptions = {
        expiresIn: durationToSeconds(config.jwt.refreshExpiresIn),
    };
    return jwt.sign({ ...payload }, config.jwt.refreshSecret, options);
};

export const verifyAccessToken = (token: string): JWTPayload => {
    return jwt.verify(token, config.jwt.secret) as JWTPayload;
};

export const verifyRefreshToken = (token: string): JWTPayload => {
    return jwt.verify(token, config.jwt.refreshSecret) as JWTPayload;
};

export const generateRandomToken = (): string => {
    return require('crypto').randomBytes(32).toString('hex');
};

export const getExpirationDate = (duration: string): Date => {
    const seconds = durationToSeconds(duration);
    return new Date(Date.now() + seconds * 1000);
};
