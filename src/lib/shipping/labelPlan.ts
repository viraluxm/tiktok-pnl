// Decide what a label run buys, and the order the labels print in.
//
// NO IMPORTS — labelPlan.test.mjs transpiles this file standalone at runtime.
//
// WHY THE ORDER MATTERS. Measured over the 21 days to 2026-09-03, 47.7% of boxes (13,064 of
// 27,411) hold exactly one unit of one SKU. Those units are interchangeable, so grouping their
// labels by SKU turns packing into a mechanical loop: hold a box of one SKU, one item per
// package, slap, next. Nothing to read, nothing to count.
//
// MIXED MEANS TWO OR MORE SKUS ON ONE LABEL — nothing else. A box holding one SKU always gets
// that SKU's header, even when it is the only such box in the run. An earlier version demoted
// those lone boxes into mixed on the theory that "a slip in front of one label is pure paper",
// which had it backwards: the slip's job is not to amortise itself over a long run, it is to
// tell the packer WHAT TO GRAB without reading. A lone "#302 JUMBO UV STRAWBERRY" does that
// perfectly; burying the same box in mixed forces exactly the read this whole feature exists
// to remove. Paper is cheaper than a misread.
//
// MULTI-UNIT BOXES GET THEIR OWN HEADER, NOT THE SINGLE-UNIT ONE. A 3-unit order of the same
// SKU is still one SKU, so it is not mixed — but it cannot sit under the same heading as the
// 1-unit boxes either, because the packer working that pile puts one item per package and
// would under-ship it. Single-SKU boxes are therefore grouped by (SKU, units per box) and the
// header states the count, so the pile in front of the packer is always uniform.
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

/** A run of labels for one SKU at one units-per-box, printing behind a single separator slip. */
export interface SkuBatch {
  inventory_sku_id: string;
  sku_number: number | null;
  title: string;
  /** Slip caption, e.g. "#248 PUMPKIN GLITTER". */
  slip: string;
  boxes: PlanBox[];
}

export interface LabelPlan {
  /** Single-SKU boxes, grouped by (SKU, units per box), in print order. */
  batches: SkuBatch[];
  /**
   * Genuine bundles: boxes whose label covers TWO OR MORE SKUs, so each must be read
   * individually. Printed after every SKU section. Nothing else lands here — a single-SKU box
   * always gets its own header, however few of them there are.
   */
  bundles: PlanBox[];
  totalBoxes: number;
  totalOrders: number;
  /** Boxes under a SKU header — the share that packs without reading a label. */
  batchedBoxes: number;
  /**
   * Single-box sections: a SKU with exactly one box in this run.
   *
   * Reported because it is the honest measure of how much the stack is really batching. Ten
   * sections of one are ten slips for ten labels — still worth printing, since each says what
   * to grab, but nothing like the mechanical run that eight boxes of one SKU gives.
   */
  singleBoxSections: number;
  /** Boxes needing multiple items each, so their header carries a per-box count. */
  multiUnitBoxes: number;
}

/** Total units across a box's SKU lines. */
function unitsIn(box: PlanBox): number {
  return box.skus.reduce((n, s) => n + (Number(s.qty) || 0), 0);
}

/**
 * Whether a box holds exactly one SKU, and so gets that SKU's header rather than going to mixed.
 *
 * Units do not enter into it: a 3-unit box of one SKU is still one SKU. What units decide is
 * WHICH header it goes under — see sectionKeyOf. A box whose lines sum to less than one unit is
 * treated as mixed: the data is wrong and a label that must be read is the safe outcome.
 */
export function isSingleSku(box: PlanBox): boolean {
  return box.skus.length === 1 && unitsIn(box) >= 1;
}

/**
 * Section identity for a single-SKU box: the SKU, plus how many units the box needs.
 *
 * Units are part of the key so a 3-unit box never lands under a heading the packer is working
 * one-item-per-package. Every pile in front of them is uniform.
 */
export function sectionKeyOf(box: PlanBox): string {
  return `${box.skus[0].inventory_sku_id}::${unitsIn(box)}`;
}

/**
 * The separator-slip caption for a SKU section.
 *
 * When a box needs more than one unit the count is stated, because the packer's default is one
 * item per package and silence would under-ship it. The slip's own footer already gives the
 * number of LABELS, so the two numbers never mean the same thing: "3 PER BOX" with "2 LABELS"
 * reads as six items across two parcels.
 */
export function slipCaption(skuNumber: number | null, title: string, units = 1): string {
  // Assembled from parts rather than interpolated, so an absent title cannot leave a double
  // space before the count — the caption is compared byte-for-byte in the ledger's
  // slip_caption, where a stray space would split one section into two.
  const parts = [skuNumber == null ? '#?' : `#${skuNumber}`];
  const t = (title || '').trim().toUpperCase();
  if (t) parts.push(t);
  if (units > 1) parts.push(`— ${units} PER BOX`);
  return parts.join(' ');
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
  const singleSku: PlanBox[] = [];
  const bundles: PlanBox[] = [];
  for (const b of boxes) (isSingleSku(b) ? singleSku : bundles).push(b);

  // Keyed by (SKU, units per box), so a 3-unit box never joins the one-per-package pile.
  const sections = new Map<string, SkuBatch>();
  for (const box of singleSku) {
    const line = box.skus[0];
    const key = sectionKeyOf(box);
    const existing = sections.get(key);
    if (existing) { existing.boxes.push(box); continue; }
    const units = box.skus.reduce((n, x) => n + (Number(x.qty) || 0), 0);
    sections.set(key, {
      inventory_sku_id: line.inventory_sku_id,
      sku_number: line.sku_number,
      title: line.title,
      slip: slipCaption(line.sku_number, line.title, units),
      boxes: [box],
    });
  }

  // No demotion. Every single-SKU section keeps its header however few boxes it has: the header
  // exists to say what to grab, and one box needs that as much as eight do.
  const batches = [...sections.values()].sort(
    (a, b) => b.boxes.length - a.boxes.length
      || (a.sku_number ?? Number.MAX_SAFE_INTEGER) - (b.sku_number ?? Number.MAX_SAFE_INTEGER)
      || a.inventory_sku_id.localeCompare(b.inventory_sku_id)
      || a.slip.localeCompare(b.slip),
  );

  // Stable order within a section and among bundles, for the same reason as the tie-break above.
  for (const b of batches) b.boxes.sort((x, y) => x.group_key.localeCompare(y.group_key));
  bundles.sort((x, y) => x.group_key.localeCompare(y.group_key));

  const orderIds = new Set<string>();
  for (const b of boxes) for (const o of b.order_ids) orderIds.add(o);

  return {
    batches,
    bundles,
    totalBoxes: boxes.length,
    totalOrders: orderIds.size,
    // Every box under a SKU header — the share that packs without reading a label.
    batchedBoxes: batches.reduce((n, b) => n + b.boxes.length, 0),
    singleBoxSections: batches.filter((b) => b.boxes.length === 1).length,
    multiUnitBoxes: singleSku.filter(
      (b) => b.skus.reduce((n, x) => n + (Number(x.qty) || 0), 0) > 1,
    ).length,
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
