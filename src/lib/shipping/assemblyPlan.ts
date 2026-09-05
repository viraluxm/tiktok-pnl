// Turn a print plan plus the purchase ledger into the exact page sequence to assemble.
//
// NO IMPORTS — assemblyPlan.test.mjs transpiles this file standalone at runtime.
//
// WHY THIS IS NOT JUST planPageSequence. That function says what the plan WANTED to print. This
// one says what can ACTUALLY be printed, which is different: a box may have been claimed but
// never confirmed, or bought before this run with no package_id of ours to fetch by. Those
// boxes have no label bytes available, and the honest thing is to report them rather than let
// them vanish out of a stack the packer assumes is complete.
//
// AND THE SLIP COUNTS MUST FOLLOW. A slip reading "#248 PUMPKIN GLITTER · 12" in front of ten
// labels is worse than no slip: the packer counts twelve items out of stock and two are left
// over with nothing to stick them to. So counts are recomputed from the labels that survive,
// and a slip whose whole section is unprintable is dropped entirely.

/** Re-fetch a doc_url expiring within this margin. TikTok's are good for ~24h. */
export const DOC_REFETCH_MARGIN_MS = 60 * 60_000;

/**
 * The exact column list a caller must SELECT to build LedgerRow.
 *
 * Lives next to the type because the two drifted once and it was invisible: banner_caption was
 * added to the migration, the write, this type, the grouping, the renderer and the tests — but
 * not to the PDF route's select. A missing column reads as `undefined`, which the code treats
 * as "no banner", so a whole day printed with its pile dividers silently absent. Nothing threw.
 *
 * Unit tests cannot catch this class of bug: they construct rows directly and never issue the
 * query. Keeping the string beside the interface at least puts the two in one field of view.
 */
export const LEDGER_COLUMNS =
  'group_key, status, package_id, doc_url, doc_url_expires_at, tracking_number, '
  + 'print_seq, slip_caption, banner_caption';

/** The ledger fields assembly needs. Keep in step with LEDGER_COLUMNS above. */
export interface LedgerRow {
  group_key: string;
  status: string;
  package_id: string | null;
  doc_url: string | null;
  doc_url_expires_at: string | null;
  tracking_number: string | null;
  /** Position in the run's print stack, assigned at purchase. Null on pre-migration rows. */
  print_seq?: number | null;
  /** SKU section this box prints under, or null for no section. */
  slip_caption?: string | null;
  /** Pile this box prints under. Null on rows written before the column existed. */
  banner_caption?: string | null;
}

/** One page of the assembled document. */
export type AssemblyPage =
  | { kind: 'banner'; caption: string; count: number }
  | { kind: 'slip'; caption: string; count: number }
  | { kind: 'label'; group_key: string; package_id: string; doc_url: string | null };

export interface AssemblySequence {
  pages: AssemblyPage[];
  /** Boxes the plan wanted but that cannot be printed. Reported, never silently skipped. */
  missing: Array<{ group_key: string; reason: string }>;
  /** Labels whose doc_url is absent or near expiry and must be re-fetched before assembly. */
  refetch: string[];
  labelCount: number;
  slipCount: number;
  bannerCount: number;
}

/**
 * One box to print, and the section header it belongs under.
 *
 * WHY THE CAPTION LIVES ON THE LABEL rather than in separate slip markers. A flat
 * slip/label/label/slip list cannot express "this section ended and no new one began" — a
 * caption-less box following a section gets silently absorbed into it, inflating that slip's
 * count. Attaching the caption to each box makes sections fall out of consecutive grouping,
 * and the ambiguity cannot be represented at all.
 */
export interface AssemblyItem {
  group_key: string;
  /** Pile this box belongs to: singles / mixed / no-SKU. Null for a box with no pile. */
  banner: string | null;
  /** SKU section within the pile, or null where the pile has no per-SKU split. */
  caption: string | null;
}

/**
 * Rebuild the print stack from the ledger alone.
 *
 * This is what makes assembly independent of live data. Each row carries its print position
 * and the caption of the section it belongs to, so consecutive rows sharing a caption form one
 * section and each slip's count falls out of the grouping. A run bought last week reprints
 * identically; re-planning could never manage that, because its orders have long since
 * advanced out of the candidate set.
 *
 * Rows with no `print_seq` (written before that column existed) sort last by group_key rather
 * than being dropped — a label with an unknown position is still a label that was paid for.
 */
export function itemsFromLedger(rows: LedgerRow[]): AssemblyItem[] {
  return rows.slice().sort((a, b) => {
    const as = a.print_seq, bs = b.print_seq;
    const aNull = as == null || !Number.isFinite(as);
    const bNull = bs == null || !Number.isFinite(bs);
    if (aNull !== bNull) return aNull ? 1 : -1;
    if (!aNull && !bNull && as !== bs) return (as as number) - (bs as number);
    return a.group_key.localeCompare(b.group_key);
  }).map((r) => ({
    group_key: r.group_key,
    banner: r.banner_caption ?? null,
    caption: r.slip_caption ?? null,
  }));
}


/**
 * Whether a purchased row's label document must be fetched again before assembly.
 *
 * A URL that expires mid-assembly yields a 403 and a hole in the stack, so anything without a
 * usable expiry is treated as stale rather than assumed good. Cheap to re-fetch; expensive to
 * discover at the printer.
 */
export function needsRefetch(row: LedgerRow, nowMs: number): boolean {
  if (!row.doc_url) return true;
  if (!row.doc_url_expires_at) return true;
  const t = Date.parse(row.doc_url_expires_at);
  if (!Number.isFinite(t)) return true;
  return t - nowMs <= DOC_REFETCH_MARGIN_MS;
}

/**
 * Why a box cannot be printed, or null if it can.
 *
 * 'claimed' is the important one. It means a purchase was started and never confirmed, so we do
 * not know whether a label exists. Printing nothing is right; so is NOT quietly dropping it,
 * because a human has to reconcile that box either way.
 */
function unprintableReason(row: LedgerRow | undefined): string | null {
  if (!row) return 'no purchase recorded for this box';
  if (row.status === 'failed') return 'purchase failed — no label was bought';
  if (row.status === 'claimed') return 'purchase unconfirmed — left claimed, needs reconciling by hand';
  if (row.status !== 'purchased') return `unexpected ledger status "${row.status}"`;
  // The "already purchased at TikTok" case: the label exists, but it was bought outside this
  // system and we hold no package_id, so there is nothing to fetch the document by. It must be
  // printed from Seller Center.
  if (!row.package_id) return 'label bought outside Lensed — no package_id; print from Seller Center';
  return null;
}

/**
 * Resolve the stack against the ledger.
 *
 * Slip counts are computed from the labels that actually survive, and a section left empty is
 * dropped along with its slip, so the assembled stack always describes itself accurately even
 * when boxes fall out.
 */
export function buildAssemblySequence(
  items: AssemblyItem[],
  rows: LedgerRow[],
  nowMs: number = Date.now(),
): AssemblySequence {
  const byKey = new Map<string, LedgerRow>();
  for (const r of rows) byKey.set(r.group_key, r);

  const missing: Array<{ group_key: string; reason: string }> = [];
  const refetch: string[] = [];

  // Resolve first, keeping each survivor's caption. Sections are then grouped over the
  // survivors, which is why a lost box can never leave a slip overstating its section.
  const survivors: Array<{
    page: AssemblyPage & { kind: 'label' };
    banner: string | null;
    caption: string | null;
  }> = [];
  for (const it of items) {
    const row = byKey.get(it.group_key);
    const reason = unprintableReason(row);
    if (reason || !row) { missing.push({ group_key: it.group_key, reason: reason ?? 'unknown' }); continue; }
    const stale = needsRefetch(row, nowMs);
    if (stale) refetch.push(row.package_id as string);
    survivors.push({
      banner: it.banner,
      caption: it.caption,
      page: {
        kind: 'label',
        group_key: row.group_key,
        package_id: row.package_id as string,
        // A stale URL is nulled so it cannot be used by mistake; the caller re-fetches by id.
        doc_url: stale ? null : row.doc_url,
      },
    });
  }

  // Group two deep: pile first, then SKU section within it. Counts come from the SURVIVORS at
  // each level, so a lost box shrinks both its slip and its banner rather than leaving either
  // overstating what follows.
  const pages: AssemblyPage[] = [];
  let i = 0;
  while (i < survivors.length) {
    const banner = survivors[i].banner;
    let bEnd = i;
    while (bEnd < survivors.length && survivors[bEnd].banner === banner) bEnd++;
    if (banner != null) pages.push({ kind: 'banner', caption: banner, count: bEnd - i });

    let j = i;
    while (j < bEnd) {
      const caption = survivors[j].caption;
      let sEnd = j;
      while (sEnd < bEnd && survivors[sEnd].caption === caption) sEnd++;
      if (caption != null) pages.push({ kind: 'slip', caption, count: sEnd - j });
      for (let k = j; k < sEnd; k++) pages.push(survivors[k].page);
      j = sEnd;
    }
    i = bEnd;
  }

  return {
    pages,
    missing,
    refetch,
    labelCount: survivors.length,
    slipCount: pages.filter((x) => x.kind === 'slip').length,
    bannerCount: pages.filter((x) => x.kind === 'banner').length,
  };
}
