import { createAdminClient } from '@/lib/supabase/admin';

// Daily-cron RECONCILIATION for the non-atomic claim tail (Flag 1). The claim flips
// shift_instances (atomic) and then inserts shift_claims + a 'claimed' attendance_event in a
// separate, non-transactional step. If that tail fails, a shift is CLAIMED with no offsetting
// drop event — silent and money-adjacent. This sweep converts that into a number + ids in a log
// that's already read daily. No migration, no writes — read-only.
//
// Also surfaces PENDING (OT) claims: as of Deploy B they have no resolution path (the approval UI
// is Phase 7), so an unresolved pending claim must at least be visible somewhere.
//
// TENANCY. `ownerId` is OPTIONAL and that asymmetry is the whole design:
//   • omitted  → GLOBAL sweep. This is the cron's job and must stay that way: the backstop exists
//                to catch drift in ANY account, and a per-tenant cron would need a tenant list and
//                would silently stop covering a new account.
//   • provided → scoped to that one account. This is what an authenticated admin gets, so a manual
//                trigger can never read another tenant's instance ids, event ids or claim counts.
// Same function, same query shape, one predicate — no duplicated sweep to drift out of sync.
export interface ReconcileResult {
  claimed_without_event: string[]; // shift_instances.id (claimed via claim, but no 'claimed' event)
  event_without_claimed_instance: string[]; // attendance_events.id ('claimed' event, instance not claimed)
  pending_claims: number;
  /** true when this sweep covered every account (the cron path). */
  global: boolean;
}

export async function reconcileClaims(ownerId?: string): Promise<ReconcileResult> {
  const admin = createAdminClient();

  // Instances claimed via the board (source='claim').
  let instQ = admin.from('shift_instances').select('id').eq('status', 'claimed').eq('source', 'claim');
  if (ownerId) instQ = instQ.eq('user_id', ownerId);
  const { data: claimedInst } = await instQ;
  const claimedInstIds = new Set((claimedInst ?? []).map((r) => r.id as string));

  // 'claimed' attendance events, with the instance they point at.
  let evQ = admin.from('attendance_events').select('id, shift_instance_id').eq('event_type', 'claimed');
  if (ownerId) evQ = evQ.eq('user_id', ownerId);
  const { data: claimedEvents } = await evQ;
  const eventInstIds = new Set((claimedEvents ?? []).map((e) => e.shift_instance_id).filter(Boolean) as string[]);

  const claimed_without_event = [...claimedInstIds].filter((id) => !eventInstIds.has(id));
  const event_without_claimed_instance = (claimedEvents ?? [])
    .filter((e) => !e.shift_instance_id || !claimedInstIds.has(e.shift_instance_id))
    .map((e) => e.id as string);

  let pendQ = admin.from('shift_claims').select('id', { count: 'exact', head: true }).eq('status', 'pending');
  if (ownerId) pendQ = pendQ.eq('user_id', ownerId);
  const { count: pending } = await pendQ;

  return {
    claimed_without_event,
    event_without_claimed_instance,
    pending_claims: pending ?? 0,
    global: !ownerId,
  };
}
