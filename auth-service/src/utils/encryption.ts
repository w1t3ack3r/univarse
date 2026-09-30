/**
 * Encryption Utility
 * AES-256-GCM encryption for sensitive data at rest
 */

import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const SALT_LENGTH = 32;

/**
 * Get encryption key from environment
 * Must be 32 bytes (256 bits) for AES-256
 */
function getEncryptionKey(): Buffer {
    const key = process.env.PLATFORM_ENCRYPTION_KEY;

    if (!key) {
        throw new Error('PLATFORM_ENCRYPTION_KEY environment variable is required');
    }

    // If key is hex-encoded (64 chars = 32 bytes)
    if (key.length === 64 && /^[0-9a-fA-F]+$/.test(key)) {
        return Buffer.from(key, 'hex');
    }

    // If key is base64-encoded
    if (key.length === 44 && /^[A-Za-z0-9+/]+=*$/.test(key)) {
        return Buffer.from(key, 'base64');
    }

    // Otherwise derive key from passphrase using PBKDF2
    const salt = 'univarse-platform-salt'; // Static salt for consistent key derivation
    return crypto.pbkdf2Sync(key, salt, 100000, 32, 'sha256');
}

/**
 * Encrypt a string value
 * Returns format: base64(salt + iv + authTag + ciphertext)
 */
export function encrypt(plaintext: string): string {
    if (!plaintext) return plaintext;

    const key = getEncryptionKey();
    const iv = crypto.randomBytes(IV_LENGTH);
    const salt = crypto.randomBytes(SALT_LENGTH);

    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

    let encrypted = cipher.update(plaintext, 'utf8');
    encrypted = Buffer.concat([encrypted, cipher.final()]);

    const authTag = cipher.getAuthTag();

    // Combine: salt + iv + authTag + ciphertext
    const combined = Buffer.concat([salt, iv, authTag, encrypted]);

    return combined.toString('base64');
}

/**
 * Decrypt an encrypted string
 * Expects format: base64(salt + iv + authTag + ciphertext)
 */
export function decrypt(encryptedText: string): string {
    if (!encryptedText) return encryptedText;

    try {
        const key = getEncryptionKey();
        const combined = Buffer.from(encryptedText, 'base64');

        // Extract components
        const salt = combined.subarray(0, SALT_LENGTH);
        const iv = combined.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
        const authTag = combined.subarray(SALT_LENGTH + IV_LENGTH, SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH);
        const ciphertext = combined.subarray(SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH);

        const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
        decipher.setAuthTag(authTag);

        let decrypted = decipher.update(ciphertext);
        decrypted = Buffer.concat([decrypted, decipher.final()]);

        return decrypted.toString('utf8');
    } catch (error) {
        // If decryption fails, might be unencrypted legacy data
        console.warn('Decryption failed, returning original value');
        return encryptedText;
    }
}

/**
 * Encrypt database password specifically
 * Adds prefix to identify encrypted values
 */
export function encryptDbPassword(password: string): string {
    if (!password) return password;
    if (password.startsWith('ENC:')) return password; // Already encrypted

    return 'ENC:' + encrypt(password);
}

/**
 * Decrypt database password
 * Handles both encrypted and legacy unencrypted values
 */
export function decryptDbPassword(password: string): string {
    if (!password) return password;

    if (password.startsWith('ENC:')) {
        return decrypt(password.substring(4));
    }

    // Legacy unencrypted password
    return password;
}

/**
 * Generate a new encryption key (for initial setup)
 * Returns a 64-character hex string
 */
export function generateEncryptionKey(): string {
    return crypto.randomBytes(32).toString('hex');
}

/**
 * Verify if encryption is properly configured
 */
export function verifyEncryptionSetup(): { valid: boolean; message: string } {
    try {
        const testValue = 'encryption-test-' + Date.now();
        const encrypted = encrypt(testValue);
        const decrypted = decrypt(encrypted);

        if (decrypted === testValue) {
            return { valid: true, message: 'Encryption is properly configured' };
        } else {
            return { valid: false, message: 'Encryption roundtrip failed' };
        }
    } catch (error: any) {
        return { valid: false, message: error.message };
    }
}
