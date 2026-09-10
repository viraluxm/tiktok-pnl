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
