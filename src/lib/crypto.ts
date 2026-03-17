// AES-256-GCM encryption for sensitive data at rest (TikTok tokens).
// Ciphertext format: base64(IV + authTag + ciphertext)
// IV = 12 bytes, authTag = 16 bytes, remainder = ciphertext.

import crypto from 'crypto';
import { ENCRYPTION_KEY } from '@/lib/env';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

function getKeyBuffer(): Buffer {
  const buf = Buffer.from(ENCRYPTION_KEY, 'hex');
  if (buf.length !== 32) {
    throw new Error('ENCRYPTION_KEY must be a 32-byte (64-char) hex string');
  }
  return buf;
}

export function encrypt(plaintext: string): string {
  const key = getKeyBuffer();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  // Pack as: IV + authTag + ciphertext
  return Buffer.concat([iv, authTag, encrypted]).toString('base64');
}

export function decrypt(ciphertext: string): string {
  const key = getKeyBuffer();
  const buf = Buffer.from(ciphertext, 'base64');

  if (buf.length < IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error('Invalid ciphertext: too short');
  }

  const iv = buf.subarray(0, IV_LENGTH);
  const authTag = buf.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const encrypted = buf.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  return decipher.update(encrypted) + decipher.final('utf8');
}

/**
 * Safely decrypt a value that may be plaintext (pre-encryption migration)
 * or encrypted. Logs a warning if fallback to plaintext is used.
 */
export function decryptOrFallback(value: string, label: string): string {
  try {
    return decrypt(value);
  } catch {
    console.warn(`Could not decrypt ${label} — assuming plaintext (pre-encryption row)`);
    return value;
  }
}
