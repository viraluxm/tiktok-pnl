// Dependency-free Code 128 (subset B) → SVG renderer.
//
// We avoid pulling in jsbarcode / bwip-js for a single symbology: inventory
// barcodes are ASCII-printable SKU tokens ("SKU1042-7K3Q"), which are fully
// covered by Code 128 set B (ASCII 32–126). The output is a self-contained
// SVG string (no <img>, no canvas) so it renders identically on screen and
// in a print window.
//
// Reference: the canonical 107-entry Code 128 width table (each symbol is a
// run of bar/space module widths). Index 104 = Start B, 106 = Stop.

// Bar/space module widths per symbol value (index 0–106).
const PATTERNS: string[] = [
  "212222", "222122", "222221", "121223", "121322", "131222", "122213", "122312",
  "132212", "221213", "221312", "231212", "112232", "122132", "122231", "113222",
  "123122", "123221", "223211", "221132", "221231", "213212", "223112", "312131",
  "311222", "321122", "321221", "312212", "322112", "322211", "212123", "212321",
  "232121", "111323", "131123", "131321", "112313", "132113", "132311", "211313",
  "231113", "231311", "112133", "112331", "132131", "113123", "113321", "133121",
  "313121", "211331", "231131", "213113", "213311", "213131", "311123", "311321",
  "331121", "312113", "312311", "332111", "314111", "221411", "431111", "111224",
  "111422", "121124", "121421", "141122", "141221", "112214", "112412", "122114",
  "122411", "142112", "142211", "241211", "221114", "413111", "241112", "134111",
  "111242", "121142", "121241", "114212", "124112", "124211", "411212", "421112",
  "421211", "212141", "214121", "412121", "111143", "111341", "131141", "114113",
  "114311", "411113", "411311", "113141", "114131", "311141", "411131", "211412",
  "211214", "211232", "2331112", // 106 = Stop
];

const START_B = 104;
const STOP = 106;

// Encode an ASCII string to Code 128-B symbol values (start + data + checksum + stop).
function encodeB(data: string): number[] {
  const values: number[] = [];
  for (const ch of data) {
    const v = ch.charCodeAt(0) - 32;
    if (v < 0 || v > 94) {
      throw new Error(`code128: unsupported character ${JSON.stringify(ch)} (Code 128-B is ASCII 32–126)`);
    }
    values.push(v);
  }
  let checksum = START_B;
  values.forEach((v, i) => {
    checksum += v * (i + 1);
  });
  return [START_B, ...values, checksum % 103, STOP];
}

export interface Code128Options {
  /** Module (narrowest bar) width in px. Default 2. */
  moduleWidth?: number;
  /** Bar height in px. Default 64. */
  barHeight?: number;
  /** Quiet-zone width in modules on each side. Default 10 (per spec). */
  quietModules?: number;
  /** Human-readable caption rendered below the bars. Pass "" to omit. */
  caption?: string;
  /** Caption font size in px. Default 13. */
  captionSize?: number;
}

// Render a Code 128-B barcode as a standalone SVG string. `caption` (e.g.
// "SKU 1042") is drawn centered below the bars as the human-readable line.
export function code128ToSvg(value: string, opts: Code128Options = {}): string {
  const moduleWidth = opts.moduleWidth ?? 2;
  const barHeight = opts.barHeight ?? 64;
  const quiet = opts.quietModules ?? 10;
  const caption = opts.caption;
  const captionSize = opts.captionSize ?? 13;

  const symbols = encodeB(value);

  // Build the run of module widths, then emit a <rect> per black bar.
  // Each symbol's pattern alternates bar, space, bar, … starting with a bar.
  let x = quiet;
  const rects: string[] = [];
  for (const sym of symbols) {
    const pattern = PATTERNS[sym];
    let isBar = true;
    for (const widthChar of pattern) {
      const w = parseInt(widthChar, 10);
      if (isBar) {
        rects.push(
          `<rect x="${(x * moduleWidth).toFixed(2)}" y="0" width="${(w * moduleWidth).toFixed(2)}" height="${barHeight}" />`,
        );
      }
      x += w;
      isBar = !isBar;
    }
  }

  const totalModules = x + quiet;
  const width = totalModules * moduleWidth;
  const captionGap = caption ? captionSize + 6 : 0;
  const height = barHeight + captionGap;

  const captionEl = caption
    ? `<text x="${(width / 2).toFixed(2)}" y="${barHeight + captionSize}" text-anchor="middle" font-family="monospace" font-size="${captionSize}" fill="#000">${escapeXml(caption)}</text>`
    : "";

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width.toFixed(2)}" height="${height}" ` +
    `viewBox="0 0 ${width.toFixed(2)} ${height}" shape-rendering="crispEdges">` +
    `<rect x="0" y="0" width="${width.toFixed(2)}" height="${height}" fill="#fff" />` +
    `<g fill="#000">${rects.join("")}</g>` +
    captionEl +
    `</svg>`
  );
}

function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) =>
    c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === "&" ? "&amp;" : c === '"' ? "&quot;" : "&apos;",
  );
}
