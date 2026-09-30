// Two-Factor Authentication Service
// TOTP-based 2FA for Super Admins

import speakeasy from 'speakeasy';
import QRCode from 'qrcode';
import crypto from 'crypto';

class TwoFactorService {
    /**
     * Generate a new TOTP secret for a user
     */
    generateSecret(email: string): { secret: string; otpauthUrl: string } {
        const secret = speakeasy.generateSecret({
            name: `UniVarse:${email}`,
            issuer: 'UniVarse Platform',
            length: 32,
        });

        return {
            secret: secret.base32,
            otpauthUrl: secret.otpauth_url!,
        };
    }

    /**
     * Generate a QR code as a data URL for authenticator apps
     */
    async generateQRCode(otpauthUrl: string): Promise<string> {
        try {
            return await QRCode.toDataURL(otpauthUrl, {
                width: 256,
                margin: 2,
                color: {
                    dark: '#000000',
                    light: '#FFFFFF',
                },
            });
        } catch (error) {
            throw new Error('Failed to generate QR code');
        }
    }

    /**
     * Verify a TOTP token
     * @param secret - The user's TOTP secret (base32 encoded)
     * @param token - The 6-digit token from authenticator app
     * @returns true if valid, false otherwise
     */
    verifyToken(secret: string, token: string): boolean {
        return speakeasy.totp.verify({
            secret,
            encoding: 'base32',
            token,
            window: 1, // Allow 1 step before/after for clock drift (30 seconds)
        });
    }

    /**
     * Generate recovery codes for account recovery
     * @param count - Number of codes to generate (default: 8)
     * @returns Array of recovery codes
     */
    generateRecoveryCodes(count: number = 8): string[] {
        const codes: string[] = [];
        for (let i = 0; i < count; i++) {
            // Generate 8-character hex codes (e.g., "A1B2C3D4")
            const code = crypto.randomBytes(4).toString('hex').toUpperCase();
            codes.push(code);
        }
        return codes;
    }

    /**
     * Hash a recovery code for storage
     * We store hashed codes so they can't be recovered if DB is compromised
     */
    hashRecoveryCode(code: string): string {
        return crypto.createHash('sha256').update(code.toUpperCase()).digest('hex');
    }

    /**
     * Verify a recovery code against stored hashed codes
     */
    verifyRecoveryCode(inputCode: string, hashedCodes: string[]): { valid: boolean; usedIndex: number } {
        const inputHash = this.hashRecoveryCode(inputCode);
        const index = hashedCodes.indexOf(inputHash);
        return {
            valid: index !== -1,
            usedIndex: index,
        };
    }

    /**
     * Generate a current TOTP token (for testing purposes)
     */
    generateCurrentToken(secret: string): string {
        return speakeasy.totp({
            secret,
            encoding: 'base32',
        });
    }
}

export const twoFactorService = new TwoFactorService();
