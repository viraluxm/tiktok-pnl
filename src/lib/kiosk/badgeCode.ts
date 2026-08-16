// Badge code generation. A badge code is the per-employee identifier the kiosk scans; it REPLACES
// the station account's PIN. Codes are random, human-transcribable, and printed as Code 128-B.
//
// Alphabet: A–Z and 2–9, EXCLUDING the visually ambiguous 0 O 1 I L (per the approved spec) — so a
// hand-typed fallback can never confuse O/0 or I/1/L. 31 symbols, 10 chars → 31^10 ≈ 8.2e14 space;
// collisions are astronomically unlikely, and the global UNIQUE(code) constraint (migration 091) is
// the backstop the issuing route retries against.
import { randomInt } from 'node:crypto';

export const BADGE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0 O 1 I L
export const BADGE_CODE_LENGTH = 10;

// Generate one badge code. `rng(n)` must return an integer in [0, n) — defaults to a CSPRNG. It is
// injectable so tests are deterministic without touching production randomness.
export function generateBadgeCode(rng: (n: number) => number = randomInt): string {
  let out = '';
  for (let i = 0; i < BADGE_CODE_LENGTH; i++) {
    out += BADGE_ALPHABET[rng(BADGE_ALPHABET.length)];
  }
  return out;
}

// True iff `code` is exactly BADGE_CODE_LENGTH chars drawn only from BADGE_ALPHABET. Used to reject
// malformed scans before hitting the DB (and to keep the excluded characters out for good).
export function isValidBadgeCode(code: string): boolean {
  if (typeof code !== 'string' || code.length !== BADGE_CODE_LENGTH) return false;
  for (const ch of code) {
    if (!BADGE_ALPHABET.includes(ch)) return false;
  }
  return true;
}
