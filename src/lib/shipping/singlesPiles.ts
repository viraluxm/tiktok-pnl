// Singles piles, and the part window — together, because the bug was in how they INTERACT.
//
// NO IMPORTS — singlesPiles.test.mjs transpiles this file standalone at runtime.
//
// A PILE is the stack one slip fronts. A PART is a slice of the printed document, capped at a
// label count so a response fits Vercel's 4.5MB ceiling. The two are independent: a pile is a
// physical stack the packer builds and scans, a part is a download boundary.
//
// They were not kept independent. Piles were collected from the pages AFTER the part window was
// applied, which broke crediting two ways:
//
//   1. A pile split across a boundary minted a batch holding only the labels that shared a part
//      with its slip. The slip still printed its true count, so the paper said 6 LABELS while the
//      barcode credited 2.
//   2. A part OPENING mid-pile carried no slip — the header lookback stops at the first label —
//      so `current` stayed null and every label in it joined no pile and no batch. Those boxes
//      were uncreditable by any barcode that existed.
//
// On 2026-09-13 one '#309 JUMBO GREY SHARK' pile of 6 minted a batch of 2 and stranded 4; across
// the ledger 209 labels in 28 batches were stranded this way.
//
// The rule this file encodes: COLLECT PILES FROM THE WHOLE DOCUMENT, THEN SLICE FOR DELIVERY.

export type PilePage =
  | { kind: 'banner'; caption: string; count: number }
  | { kind: 'slip'; caption: string; count: number }
  | { kind: 'label'; group_key: string; [k: string]: unknown };

export interface Pile {
  caption: string;
  groupKeys: string[];
}

/**
 * The piles in a document: each slip, plus the label pages following it up to the next slip or
 * banner. A banner ends the pile above it, because it starts a different section of the stack.
 *
 * MUST be given the whole document. Handing it a part is the defect described above.
 */
export function collectPiles(pages: PilePage[]): Pile[] {
  const piles: Pile[] = [];
  let current: Pile | null = null;
  for (const page of pages) {
    if (page.kind === 'slip') {
      current = { caption: page.caption, groupKeys: [] };
      piles.push(current);
    } else if (page.kind === 'banner') {
      current = null;
    } else if (current) {
      current.groupKeys.push(page.group_key);
    }
  }
  return piles;
}

/**
 * The pages of one part: labels `from`..`to` inclusive, plus the section headers they sit under.
 *
 * The window is over LABELS, not pages, so a label's pages are never split across parts. The
 * headers are reached back for so a part opens by saying what it holds; a part opening mid-pile
 * finds a label immediately and correctly carries none, which is why pile collection cannot be
 * driven from this output.
 */
export function sliceToPart(pages: PilePage[], from: number, to: number): PilePage[] {
  const labelIdx: number[] = [];
  pages.forEach((p, i) => { if (p.kind === 'label') labelIdx.push(i); });
  const total = labelIdx.length;
  if (!total || (from <= 0 && to >= total - 1)) return pages;

  const firstPage = labelIdx[from] ?? 0;
  const lastPage = labelIdx[to] ?? pages.length - 1;
  const heads: PilePage[] = [];
  for (let i = firstPage - 1; i >= 0; i--) {
    if (pages[i].kind === 'label') break;
    heads.unshift(pages[i]);
  }
  return [...heads, ...pages.slice(firstPage, lastPage + 1)];
}

/**
 * Plan one part's delivery: what to mint, and what to send.
 *
 * Both halves are derived HERE, from the same whole-document input, so the ordering that caused
 * the 2026-09-13 stranding cannot be expressed by a caller. Collecting piles from an
 * already-sliced page list is the defect; taking one argument and returning both results removes
 * the chance to do it.
 */
export function planDelivery(
  pages: PilePage[],
  from: number,
  to: number,
): { piles: Pile[]; pages: PilePage[] } {
  return { piles: collectPiles(pages), pages: sliceToPart(pages, from, to) };
}
