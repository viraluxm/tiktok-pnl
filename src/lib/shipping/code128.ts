/**
 * Code 128-B encoder — module widths only, no rendering, no dependencies.
 *
 * NO IMPORTS: code128.test.mjs transpiles this file standalone at runtime, and the label PDF is
 * built with pdf-lib, which has no barcode support. Rather than take a dependency for one
 * symbology we emit the bar/space widths and let the caller draw rectangles.
 *
 * WHY 128-B: it covers the full printable ASCII range, so the batch code can stay human-readable
 * underneath the bars. 128-C would pack digits denser, but a code a person can read back over the
 * phone when a scanner is broken is worth more here than a shorter symbol.
 *
 * A Code 128 symbol is: quiet zone, START-B, one symbol per character, a modulo-103 check symbol,
 * STOP, quiet zone. Every symbol is 11 modules wide except STOP, which is 13.
 */

// The 107 Code 128 patterns (values 0-106). Each is the width, in modules, of six alternating
// elements starting with a BAR: bar, space, bar, space, bar, space. Value 106 (STOP) has seven.
const PATTERNS: string[] = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
  '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
  '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
  '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
  '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
  '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
  '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
  '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
  '114131', '311141', '411131', '211412', '211214', '211232', '2331112',
];

export const START_B = 104;
export const STOP = 106;

/** Quiet zone either side, in modules. The spec's minimum is 10; scanners are happier with more. */
export const QUIET_MODULES = 10;

/** Characters Code 128-B can encode: printable ASCII, space (32) through '~' (126). */
export function isEncodable(text: string): boolean {
  return text.length > 0 && [...text].every((ch) => {
    const c = ch.charCodeAt(0);
    return c >= 32 && c <= 126;
  });
}

/**
 * Encode `text` to alternating element widths, in modules, starting with a BAR.
 *
 * Returns the full symbol WITHOUT quiet zones — the caller adds those, because whether the quiet
 * zone is drawn as blank paper or as an explicit white rectangle depends on the medium.
 *
 * Throws on unencodable input rather than silently dropping characters: a barcode that scans as
 * the wrong string is far worse than one that fails loudly at build time.
 */
export function encodeCode128B(text: string): number[] {
  if (!isEncodable(text)) {
    throw new Error(`code128: "${text}" contains characters outside printable ASCII 32-126`);
  }

  const values: number[] = [START_B];
  for (const ch of text) values.push(ch.charCodeAt(0) - 32);

  // Modulo-103 checksum, weighted by position (the start symbol has weight 1).
  let sum = START_B;
  for (let i = 1; i < values.length; i++) sum += values[i] * i;
  values.push(sum % 103);
  values.push(STOP);

  const widths: number[] = [];
  for (const v of values) {
    const pattern = PATTERNS[v];
    if (!pattern) throw new Error(`code128: no pattern for value ${v}`);
    for (const d of pattern) widths.push(Number(d));
  }
  return widths;
}

/** Total width of an encoded symbol in modules, quiet zones included. */
export function symbolModules(widths: number[]): number {
  return widths.reduce((a, b) => a + b, 0) + QUIET_MODULES * 2;
}

export interface BarRect { x: number; width: number }

/**
 * Lay the encoded symbol out across `targetWidth` points, returning only the BARS (odd elements
 * are spaces and need no rectangle).
 *
 * The module width is NOT rounded to whole points. On a 203dpi thermal printer a point is ~2.8
 * dots, so rounding to integer points would distort the ratios between wide and narrow bars —
 * exactly what a scanner measures. Sub-point positions rasterise fine; wrong ratios do not.
 */
export function layoutBars(widths: number[], x0: number, targetWidth: number): BarRect[] {
  const total = symbolModules(widths);
  const module = targetWidth / total;
  const bars: BarRect[] = [];
  let cursor = x0 + QUIET_MODULES * module;
  for (let i = 0; i < widths.length; i++) {
    const w = widths[i] * module;
    if (i % 2 === 0) bars.push({ x: cursor, width: w }); // even index = bar
    cursor += w;
  }
  return bars;
}

// ─────────────────────────────────────────────────────────────────────────────
// Batch codes
// ─────────────────────────────────────────────────────────────────────────────

// Deliberately excludes I, L, O, U, 0 and 1: a code gets read aloud or typed in when a scanner is
// down, and those are the characters people confuse. 30 symbols over 10 places is ~5.9e14 codes.
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_BODY_LENGTH = 10;

/** 'SB' marks a singles batch, so a scan handler can route it without a database lookup. */
export const BATCH_CODE_PREFIX = 'SB';

/** A batch code is the prefix plus body, e.g. 'SB7F3K9M2QX4'. */
export function isBatchCode(text: string): boolean {
  if (!text.startsWith(BATCH_CODE_PREFIX)) return false;
  const body = text.slice(BATCH_CODE_PREFIX.length);
  return body.length === CODE_BODY_LENGTH && [...body].every((c) => ALPHABET.includes(c));
}

/**
 * Generate a batch code from a caller-supplied random source.
 *
 * `randomBytes` is injected so this module stays import-free and the test can pin the output.
 * Rejection sampling keeps the alphabet uniform — a plain modulo would bias the first few symbols,
 * which matters less for collision odds than for not having a subtly non-uniform id space.
 */
export function generateBatchCode(randomBytes: (n: number) => Uint8Array): string {
  let body = '';
  while (body.length < CODE_BODY_LENGTH) {
    const chunk = randomBytes(CODE_BODY_LENGTH * 2);
    for (const b of chunk) {
      if (body.length >= CODE_BODY_LENGTH) break;
      if (b < 256 - (256 % ALPHABET.length)) body += ALPHABET[b % ALPHABET.length];
    }
  }
  return BATCH_CODE_PREFIX + body;
}
