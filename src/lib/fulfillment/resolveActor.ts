import type { SupabaseClient } from '@supabase/supabase-js';

// Resolve/validate the acting worker + shift for stamping attribution (chunk 5).
//
// Option (i): both absent → no-op (null,null) — current behavior; ready for chunk 7/8 to
// supply the values. Provided → validate EXISTENCE / OWNERSHIP / ACTIVE only. Role and
// device-kind eligibility are intentionally NOT checked here — that's chunk 7's device+API
// gate — so this stays forward-compatible without half-building chunk 7.
export type ActorResult =
  | { ok: true; workerId: string | null; shiftId: string | null }
  | { ok: false; error: string };

export async function resolveActor(
  supabase: SupabaseClient,
  orgId: string,
  workerId?: string | null,
  shiftId?: string | null,
): Promise<ActorResult> {
  const w = typeof workerId === 'string' && workerId ? workerId : null;
  const s = typeof shiftId === 'string' && shiftId ? shiftId : null;
  if (!w && !s) return { ok: true, workerId: null, shiftId: null }; // no actor → no-op stamp
  if (!w || !s) return { ok: false, error: 'workerId and shiftId must be provided together' };

  // worker exists in this org and is active
  const { data: worker } = await supabase
    .from('fulfillment_workers').select('id, is_active')
    .eq('id', w).eq('org_id', orgId).maybeSingle();
  if (!worker || worker.is_active !== true) return { ok: false, error: 'worker not found or inactive in this org' };

  // shift belongs to that worker, same org, and is not ended
  const { data: shift } = await supabase
    .from('fulfillment_shifts').select('id, state')
    .eq('id', s).eq('org_id', orgId).eq('worker_id', w).maybeSingle();
  if (!shift) return { ok: false, error: 'shift not found for this worker/org' };
  if (shift.state === 'ended') return { ok: false, error: 'shift has ended' };

  return { ok: true, workerId: w, shiftId: s };
}
