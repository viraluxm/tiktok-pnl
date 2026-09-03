import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

// Override PINs.
//
// A PIN is a terrible secret — four digits is ten thousand guesses — so the two things that
// actually protect it are a SLOW hash and a rate limit on attempts. scrypt gives the first;
// the endpoint gives the second. Never store or log the PIN itself.
//
// Format: `scrypt$<saltHex>$<hashHex>`. The scheme is written into the string so a future
// change of algorithm can be told apart from an old hash rather than silently failing every
// existing PIN.
//
// Only node:crypto is imported, so pin.test.mjs can still transpile this file standalone.

const SCHEME = 'scrypt';
const KEYLEN = 32;
const SALT_BYTES = 16;

/** PINs are 4–8 digits. Short enough to type on a floor device, long enough to not be 1234. */
export function isValidPinFormat(pin: string): boolean {
  return /^\d{4,8}$/.test(pin);
}

function derive(pin: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(pin, salt, KEYLEN, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

export async function hashPin(pin: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(pin, salt);
  return `${SCHEME}$${salt.toString('hex')}$${key.toString('hex')}`;
}

/**
 * Constant-time check. Returns false — never throws — for a malformed or unknown-scheme
 * stored value, so a corrupted row denies access rather than 500ing the pick screen and
 * blocking the floor.
 */
export async function verifyPin(pin: string, stored: string | null | undefined): Promise<boolean> {
  if (!stored || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== SCHEME) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[1], 'hex');
    expected = Buffer.from(parts[2], 'hex');
  } catch {
    return false;
  }
  if (salt.length !== SALT_BYTES || expected.length !== KEYLEN) return false;

  let actual: Buffer;
  try {
    actual = await derive(pin, salt);
  } catch {
    return false;
  }
  // Lengths are already known equal, so timingSafeEqual cannot throw here.
  return timingSafeEqual(actual, expected);
}
