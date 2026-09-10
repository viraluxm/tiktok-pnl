import 'server-only';
import { randomBytes } from 'node:crypto';
import { createAdminClient } from '@/lib/supabase/admin';
import { generateBatchCode } from '@/lib/shipping/code128';

// Mint and resolve SINGLES BATCHES — the piles a packer is credited for by scanning the header
// slip when they finish it.
//
// A pile is (run_id, slip_caption): exactly the stack one header sits in front of. Member labels
// are never copied here; they are always
// `shipping_label_purchases where run_id = ? and slip_caption = ?`. One source of truth.

export interface SinglesBatch {
  id: string;
  code: string;
  run_id: string;
  slip_caption: string;
  label_count: number;
}

/**
 * Get or create the batch for each (run_id, slip_caption) in a print, returning caption -> code.
 *
 * IDEMPOTENT BY (run_id, slip_caption): re-printing a run must resolve to the SAME code, because
 * the physical pile is the same pile. A second code for one stack would let the same work be
 * credited twice.
 *
 * MERGED PRINTS ARE DELIBERATELY NOT CODED. When several runs are printed as one stack the same
 * caption spans multiple run_ids, so a single slip would front labels from several batches and one
 * code could not honestly cover them. Rather than credit a pile only partially — silently, with no
 * way for the packer to tell — those slips print with no barcode, exactly as they do today, and
 * the caller says so. Closing this properly needs the batch to carry a set of run_ids, which is a
 * schema change; a half-fix here would mis-credit real work.
 */
export async function mintSinglesBatches(
  ownerId: string,
  runId: string,
  storeId: string | null,
  piles: { caption: string; count: number }[],
): Promise<Map<string, string>> {
  const admin = createAdminClient();
  const byCaption = new Map<string, string>();
  if (piles.length === 0) return byCaption;

  const captions = piles.map((p) => p.caption);

  // Existing batches for this run first — a re-print must not mint anything.
  const { data: existing, error: readErr } = await admin
    .from('singles_batches')
    .select('code, slip_caption')
    .eq('user_id', ownerId)            // explicit owner scope; service-role bypasses RLS
    .eq('run_id', runId)
    .in('slip_caption', captions);
  if (readErr) throw new Error(`singles batches: read failed: ${readErr.message}`);
  for (const r of existing ?? []) byCaption.set(String(r.slip_caption), String(r.code));

  const missing = piles.filter((p) => !byCaption.has(p.caption));
  if (missing.length === 0) return byCaption;

  const rows = missing.map((p) => ({
    user_id: ownerId,
    store_id: storeId,
    run_id: runId,
    slip_caption: p.caption,
    code: generateBatchCode((n) => new Uint8Array(randomBytes(n))),
    label_count: p.count,
  }));

  // ON CONFLICT (run_id, slip_caption) DO NOTHING: two people hitting print at the same moment
  // must end up with one batch, not two codes for one pile. The read-back below is what the caller
  // gets, so a losing insert still returns the winner's code.
  const { error: insErr } = await admin
    .from('singles_batches')
    .upsert(rows, { onConflict: 'run_id,slip_caption', ignoreDuplicates: true });
  if (insErr) throw new Error(`singles batches: mint failed: ${insErr.message}`);

  const { data: after, error: reErr } = await admin
    .from('singles_batches')
    .select('code, slip_caption')
    .eq('user_id', ownerId)
    .eq('run_id', runId)
    .in('slip_caption', captions);
  if (reErr) throw new Error(`singles batches: read-back failed: ${reErr.message}`);
  for (const r of after ?? []) byCaption.set(String(r.slip_caption), String(r.code));

  return byCaption;
}

/** Resolve a scanned code to its batch. Null for anything unknown — the caller 404s without detail. */
export async function resolveBatchByCode(ownerId: string, code: string): Promise<SinglesBatch | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from('singles_batches')
    .select('id, code, run_id, slip_caption, label_count')
    .eq('user_id', ownerId)            // explicit owner scope
    .eq('code', code)
    .maybeSingle();
  if (error || !data) return null;
  return data as SinglesBatch;
}
