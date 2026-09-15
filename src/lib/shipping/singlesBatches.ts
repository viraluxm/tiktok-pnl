import 'server-only';
import { randomBytes } from 'node:crypto';
import { createAdminClient } from '@/lib/supabase/admin';
import { generateBatchCode } from '@/lib/shipping/code128';

// Mint and resolve SINGLES BATCHES — the piles a packer is credited for by scanning the header
// slip when they finish it.
//
// A BATCH IS THE SET OF LABELS ONE SLIP FRONTS. Not a run, and not a (run, SKU) pair. Labels are
// bought per shop and printed COMBINED, so one pile routinely draws from a dozen runs: over the
// 4 days to 2026-09-09, '#428 CRUNCHY SOAP BAR ORIGINAL' spanned 12 runs and 148 labels. Keying a
// batch to a run would have meant no honest code on essentially every real print.
//
// Storing the member group_keys makes merged and single-run prints the same case, with no special
// path to get wrong, and makes crediting a direct insert with no lookup.

export interface SinglesBatch {
  id: string;
  code: string;
  slip_caption: string;
  label_count: number;
  group_keys: string[];
}

export interface PileToMint {
  caption: string;
  groupKeys: string[];
}

/**
 * Mint a batch per pile in one print, returning caption -> code.
 *
 * A NEW BATCH PER PRINT, deliberately. Re-printing a stack mints fresh codes rather than reusing
 * an old one, because the contents may differ: buy more labels, print again, and '#428' now fronts
 * 190 boxes where it fronted 148. A code reused across prints whose contents changed would be a
 * code that lies about what it covers. Both codes resolve to real boxes, and
 * UNIQUE (user_id, group_key) on shipment_verifications still makes the second scan a no-op, so
 * nothing is ever double-credited.
 */
/** Stable identity of a pile's contents: the caption plus its members, order-independent. */
function membershipKey(caption: string, groupKeys: string[]): string {
  return `${caption}\u0000${[...groupKeys].sort().join(',')}`;
}

/**
 * Resolve each pile to a batch code, minting only what does not already exist.
 *
 * A stack is served in PARTS, and every part is its own request that re-derives the same piles.
 * Minting unconditionally would hand each part a different code for the same physical pile, so
 * which code a packer got would depend on which part happened to render their slip.
 *
 * Reuse is keyed on MEMBERSHIP, not on the run or the caption alone, which keeps the
 * new-batch-per-print rule intact where it matters: buy more labels and re-print, and '#428' now
 * fronts 190 boxes where it fronted 148 — different membership, so a fresh code, because the old
 * one would lie about what it covers. Identical membership is the same pile by definition, and
 * one code for it is the correct answer whether it is part 2 of today's print or a clean reprint.
 */
export async function resolveOrMintSinglesBatches(
  ownerId: string,
  storeId: string | null,
  runIds: string[],
  piles: PileToMint[],
): Promise<Map<string, string>> {
  const byCaption = new Map<string, string>();
  const usable = piles.filter((p) => p.groupKeys.length > 0);
  if (usable.length === 0) return byCaption;

  const admin = createAdminClient();
  const { data: existing, error } = await admin
    .from('singles_batches')
    .select('code, slip_caption, group_keys')
    .eq('user_id', ownerId)
    // Narrowed to THIS print's runs as well as its captions. Reuse candidates are the other parts
    // of the stack being printed now, and a caption alone accumulates a row per print forever —
    // PostgREST caps a response at 1000 rows and says nothing about it, so an unnarrowed read
    // would quietly start missing the very row it is looking for.
    .overlaps('run_ids', runIds)
    .in('slip_caption', [...new Set(usable.map((p) => p.caption))]);
  // A read failure is not fatal — fall through and mint. A duplicate code is survivable (both
  // resolve to real boxes, and UNIQUE (user_id, group_key) on shipment_verifications still makes
  // the second scan a no-op); losing the codes entirely would print an uncreditable stack.
  if (error) console.error('[singles batches] reuse lookup failed, minting fresh:', error);

  const known = new Map<string, string>();
  for (const r of existing ?? []) {
    known.set(
      membershipKey(String(r.slip_caption), (r.group_keys as string[] | null) ?? []),
      String(r.code),
    );
  }

  const toMint: PileToMint[] = [];
  for (const p of usable) {
    const hit = known.get(membershipKey(p.caption, p.groupKeys));
    if (hit) byCaption.set(p.caption, hit);
    else toMint.push(p);
  }

  if (toMint.length > 0) {
    const minted = await mintSinglesBatches(ownerId, storeId, runIds, toMint);
    for (const [caption, code] of minted) byCaption.set(caption, code);
  }
  return byCaption;
}

export async function mintSinglesBatches(
  ownerId: string,
  storeId: string | null,
  runIds: string[],
  piles: PileToMint[],
): Promise<Map<string, string>> {
  const byCaption = new Map<string, string>();
  const usable = piles.filter((p) => p.groupKeys.length > 0);
  if (usable.length === 0) return byCaption;

  const admin = createAdminClient();
  const rows = usable.map((p) => ({
    user_id: ownerId,
    store_id: storeId,
    slip_caption: p.caption,
    code: generateBatchCode((n) => new Uint8Array(randomBytes(n))),
    label_count: p.groupKeys.length,
    group_keys: p.groupKeys,
    run_ids: runIds,            // provenance only — nothing resolves a scan through this
  }));

  const { data, error } = await admin
    .from('singles_batches')
    .insert(rows)
    .select('code, slip_caption');
  if (error) throw new Error(`singles batches: mint failed: ${error.message}`);

  for (const r of data ?? []) byCaption.set(String(r.slip_caption), String(r.code));
  return byCaption;
}

/** Resolve a scanned code. Null for anything unknown — the caller 404s without leaking detail. */
export async function resolveBatchByCode(ownerId: string, code: string): Promise<SinglesBatch | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from('singles_batches')
    .select('id, code, slip_caption, label_count, group_keys')
    .eq('user_id', ownerId)            // explicit owner scope; service-role bypasses RLS
    .eq('code', code)
    .maybeSingle();
  if (error || !data) return null;
  return {
    id: String(data.id),
    code: String(data.code),
    slip_caption: String(data.slip_caption),
    label_count: Number(data.label_count),
    group_keys: (data.group_keys as string[] | null) ?? [],
  };
}
