// Slot barcode values — the permanent physical address of one pick location.
//
// NO IMPORTS — slotCode.test.mjs transpiles this file standalone at runtime.
//
// A slot code is OPAQUE on purpose. It encodes no rack, level or section, so relocating a
// rack on the grid changes the human-readable caption without invalidating a single printed
// label. Baking the address into the barcode would turn every rack move into a reprinting
// job, which is the exact cost this whole design exists to avoid.
//
// The 'LOC-' prefix makes scan routing a prefix test rather than a guess. The picker's
// scanner sees four kinds of barcode and they must never be confused:
//   LOC-7K3QM2XA…  slot label      (this file)
//   SKU1042-7K3Q   SKU label       (inventory_skus.barcode)
//   7K3QM2XAJP     employee badge  (employee_badges.code, bare 10-char)
//   9234…          shipping label  (22-digit USPS IMpb)
//
// The alphabet matches employee_badges: A–Z and 2–9 with O, I, L excluded, so nothing in a
// code can be misread as 0, 1 or confused by someone keying it in by hand.

export const SLOT_CODE_PREFIX = 'LOC-';
export const SLOT_CODE_BODY_LENGTH = 10;

/** A–Z2–9 minus the characters that misread as one another. 31 symbols. */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/**
 * Draw `n` unbiased indices into ALPHABET.
 *
 * Rejection sampling rather than `byte % 31`: 256 is not a multiple of 31, so the naive
 * modulo would make the first eight symbols ~3% likelier than the rest. It costs nothing to
 * be uniform here and it keeps the collision math honest.
 */
function randomIndices(n: number): number[] {
  const limit = Math.floor(256 / ALPHABET.length) * ALPHABET.length; // 248
  const out: number[] = [];
  const buf = new Uint8Array(n * 2);
  while (out.length < n) {
    globalThis.crypto.getRandomValues(buf);
    for (const byte of buf) {
      if (out.length === n) break;
      if (byte < limit) out.push(byte % ALPHABET.length);
    }
  }
  return out;
}

/**
 * Mint a slot code. Uniqueness is ultimately enforced by the DB (pick_slots.slot_code is
 * globally unique); at 31^10 ≈ 8.2e14 values a collision is a retry, not a design concern.
 */
export function generateSlotCode(): string {
  const body = randomIndices(SLOT_CODE_BODY_LENGTH)
    .map((i) => ALPHABET[i])
    .join('');
  return SLOT_CODE_PREFIX + body;
}

/** Whether a scanned string is a slot label, as opposed to a SKU, badge or shipping label. */
export function isSlotCode(raw: string): boolean {
  const s = normalizeSlotCode(raw);
  if (!s.startsWith(SLOT_CODE_PREFIX)) return false;
  const body = s.slice(SLOT_CODE_PREFIX.length);
  if (body.length !== SLOT_CODE_BODY_LENGTH) return false;
  for (const ch of body) if (!ALPHABET.includes(ch)) return false;
  return true;
}

/**
 * Canonicalise a scan before comparing it. Scanners vary in what they append and operators
 * occasionally key a code by hand, so trim, drop whitespace and uppercase — but do NOT
 * "helpfully" map O→0 or I→1: those characters cannot occur in a valid code, so a string
 * containing them is a misread that should fail loudly rather than be silently repaired
 * into a DIFFERENT valid slot.
 */
export function normalizeSlotCode(raw: string): string {
  return raw.trim().replace(/\s+/g, '').toUpperCase();
}
