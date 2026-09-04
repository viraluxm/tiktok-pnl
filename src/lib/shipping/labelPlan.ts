// Decide what a label run buys, and the order the labels print in.
//
// NO IMPORTS — labelPlan.test.mjs transpiles this file standalone at runtime.
//
// WHY THE ORDER MATTERS. Measured over the 21 days to 2026-09-03, 47.7% of boxes (13,064 of
// 27,411) hold exactly one unit of one SKU. Those units are interchangeable, so grouping their
// labels by SKU turns packing into a mechanical loop: hold a box of one SKU, one item per
// package, slap, next. Nothing to read, nothing to count.
//
// WHY MULTI-UNIT SAME-SKU BOXES ARE DELIBERATELY EXCLUDED FROM THAT. A 3-unit order of the
// same SKU breaks the loop: the packer has to NOTICE that this one label needs three items,
// which means reading every label and losing the speed the batch existed for. Those boxes go
// with the bundles, where reading and counting is already the job. It costs 1.6% of volume
// (439 boxes) to keep the other 47.7% mechanical.
//
// THE UNIT IS THE BOX, NOT THE ORDER. One label covers one package, and a combine group is one
// package however many orders it contains — on the Snore test set, 159 eligible orders
// collapsed to 62 boxes. Planning per order would have bought 97 labels too many.

/** A SKU line inside a box. */
export interface PlanSkuLine {
  inventory_sku_id: string;
  sku_number: number | null;
  title: string;
  qty: number;
}

/** One box: a combine group, or a single order standing alone. One label each. */
export interface PlanBox {
  group_key: string;
  order_ids: string[];
  skus: PlanSkuLine[];
}

/** A run of same-SKU labels that prints behind one separator slip. */
export interface SkuBatch {
  inventory_sku_id: string;
  sku_number: number | null;
  title: string;
  /** Slip caption, e.g. "#248 PUMPKIN GLITTER". */
  slip: string;
  boxes: PlanBox[];
}

export interface LabelPlan {
  /** Single-SKU/single-unit boxes, grouped by SKU, in print order. */
  batches: SkuBatch[];
  /**
   * Everything that does not pack mechanically, printed after every batch: multi-SKU boxes,
   * multi-unit boxes, and single-SKU groups too small to be worth a slip.
   */
  bundles: PlanBox[];
  totalBoxes: number;
  totalOrders: number;
  /** Boxes in real batches — the share that packs mechanically. Excludes demoted singletons. */
  batchedBoxes: number;
  /**
   * Boxes that WERE batchable — one SKU, one unit — but whose SKU had no other box in this
   * run, so they were demoted to mixed.
   *
   * Reported because `batchedBoxes: 0` alone cannot distinguish "nothing here could ever
   * batch" from "eight could have, each was simply alone" — and that difference is exactly
   * what tells you whether to wait for more volume or whether the mix is wrong. On the first
   * real Snore run it was 0 batched and 8 demoted: eight single-item boxes across eight
   * different SKUs.
   */
  demotedSingletons: number;
  /** Distinct SKUs among the demoted singletons. */
  demotedSkus: number;
}

/**
 * Smallest group worth a separator slip.
 *
 * A slip in front of ONE label is pure paper — it announces a batch that isn't one, and the
 * packer still has to read that single label to know what it is. On the Snore test set this
 * would have printed 7 slips for 7 single-box groups: 8 slips for 16 labels.
 *
 * Groups below this are demoted to the mixed section, which is exactly the right home: what
 * unites everything there is that each label must be read individually.
 */
export const MIN_BATCH_SIZE = 2;

/** Total units across a box's SKU lines. */
function unitsIn(box: PlanBox): number {
  return box.skus.reduce((n, s) => n + (Number(s.qty) || 0), 0);
}

/**
 * Whether a box's label can join a same-SKU batch.
 *
 * Exactly one distinct SKU AND exactly one unit. Both conditions are load-bearing: one SKU so
 * the batch is homogeneous, one unit so the packer's loop stays "one item per label".
 */
export function isBatchable(box: PlanBox): boolean {
  if (box.skus.length !== 1) return false;
  return unitsIn(box) === 1;
}

/** The separator-slip caption for a SKU. */
export function slipCaption(skuNumber: number | null, title: string): string {
  const num = skuNumber == null ? '#?' : `#${skuNumber}`;
  return `${num} ${(title || '').trim().toUpperCase()}`.trim();
}

/**
 * Build the print plan.
 *
 * Batches are ordered LARGEST FIRST, ties broken by SKU number. Largest-first puts the long
 * mechanical runs at the front, while the packer is freshest and before any interruption is
 * likely; the tie-break keeps two runs over the same data identical, so a reviewed dry run and
 * the real thing print in the same order.
 *
 * (A later refinement worth considering: order batches by the picking route from the rack
 * mapping, so whoever pulls the stock walks the floor once. Deliberately not done here —
 * mapping is only partly populated, and a half-known route would produce an order that looks
 * arbitrary without being explainable.)
 */
export function buildLabelPlan(boxes: PlanBox[]): LabelPlan {
  const batchable: PlanBox[] = [];
  const bundles: PlanBox[] = [];
  for (const b of boxes) (isBatchable(b) ? batchable : bundles).push(b);

  const bySku = new Map<string, SkuBatch>();
  for (const box of batchable) {
    const line = box.skus[0];
    const existing = bySku.get(line.inventory_sku_id);
    if (existing) { existing.boxes.push(box); continue; }
    bySku.set(line.inventory_sku_id, {
      inventory_sku_id: line.inventory_sku_id,
      sku_number: line.sku_number,
      title: line.title,
      slip: slipCaption(line.sku_number, line.title),
      boxes: [box],
    });
  }

  // Demote groups too small to be a batch. Done AFTER grouping, not during: whether a SKU has
  // enough boxes is only knowable once every box has been assigned.
  const grouped = [...bySku.values()];
  const tooSmall = grouped.filter((g) => g.boxes.length < MIN_BATCH_SIZE);
  for (const g of tooSmall) bundles.push(...g.boxes);
  const demotedSingletons = tooSmall.reduce((n, g) => n + g.boxes.length, 0);

  const batches = grouped.filter((g) => g.boxes.length >= MIN_BATCH_SIZE).sort(
    (a, b) => b.boxes.length - a.boxes.length
      || (a.sku_number ?? Number.MAX_SAFE_INTEGER) - (b.sku_number ?? Number.MAX_SAFE_INTEGER)
      || a.inventory_sku_id.localeCompare(b.inventory_sku_id),
  );

  // Stable order within a batch and among bundles, for the same reason as the tie-break above.
  for (const b of batches) b.boxes.sort((x, y) => x.group_key.localeCompare(y.group_key));
  bundles.sort((x, y) => x.group_key.localeCompare(y.group_key));

  const orderIds = new Set<string>();
  for (const b of boxes) for (const o of b.order_ids) orderIds.add(o);

  return {
    batches,
    bundles,
    totalBoxes: boxes.length,
    totalOrders: orderIds.size,
    // Boxes that actually pack mechanically — i.e. in a real batch. NOT every single-SKU box:
    // a demoted singleton is packed one-at-a-time like a bundle, and counting it as batched
    // would overstate the only number this feature exists to improve.
    batchedBoxes: batches.reduce((n, b) => n + b.boxes.length, 0),
    demotedSingletons,
    demotedSkus: tooSmall.length,
  };
}

/**
 * Flatten a plan into the page sequence a printer would receive: a slip, then that batch's
 * labels, repeating, then every bundle label.
 */
export function planPageSequence(plan: LabelPlan): Array<
  | { kind: 'slip'; caption: string; count: number }
  | { kind: 'label'; group_key: string }
> {
  const out: Array<
    | { kind: 'slip'; caption: string; count: number }
    | { kind: 'label'; group_key: string }
  > = [];
  for (const b of plan.batches) {
    out.push({ kind: 'slip', caption: b.slip, count: b.boxes.length });
    for (const box of b.boxes) out.push({ kind: 'label', group_key: box.group_key });
  }
  if (plan.bundles.length) {
    // The mixed section gets a slip too. Without one, its first label reads as part of the last
    // SKU batch — the exact confusion slips exist to prevent.
    //
    // The caption names the ACTION, not the contents: this section holds multi-SKU boxes,
    // multi-unit boxes and demoted singletons, and what they share is that each label must be
    // read individually.
    out.push({ kind: 'slip', caption: 'MIXED — READ EACH LABEL', count: plan.bundles.length });
    for (const box of plan.bundles) out.push({ kind: 'label', group_key: box.group_key });
  }
  return out;
}
