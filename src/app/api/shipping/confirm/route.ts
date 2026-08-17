import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { validatePicker } from '@/lib/shipping/pickerPerformance';
import { buildVerificationRow } from '@/lib/shipping/confirmRow';

export const dynamic = 'force-dynamic';

// POST: mark a box (combine group, or singleton order) picked/verified.
// The single write the pick-verify flow makes. Idempotent on (user, group_key).
//
// Phase 1 fulfillment-picker attribution: an OPTIONAL picker_employee_id may be supplied.
// When it names a valid fulfillment picker for THIS account, we stamp picker_employee_id +
// picker_name_snapshot on the same insert (one atomic write — no second row). Attribution is
// strictly best-effort: an absent picker (older client) or an invalid/foreign/host/former
// picker NEVER blocks the verification write — the box still records, just as "Unassigned".
//
// IMMUTABLE AFTER FIRST CONFIRM: the write uses ON CONFLICT (user_id, group_key) DO NOTHING
// (ignoreDuplicates). The first successful confirmation establishes verified_at,
// pick_started_at, and picker attribution; any duplicate/re-confirm is a successful NO-OP that
// never rewrites those KPI fields and never backfills a historical Unassigned row.
export async function POST(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: { group_key?: string; order_ids?: string[]; picker_employee_id?: string; pick_started_at?: string};
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Expected JSON body' }, { status: 400 }); }

  const groupKey = typeof body.group_key === 'string' ? body.group_key.trim() : '';
  if (!groupKey) return NextResponse.json({ error: 'Missing group_key' }, { status: 400 });
  const orderIds = Array.isArray(body.order_ids)
    ? body.order_ids.filter((x): x is string => typeof x === 'string')
    : [];

  // ── Resolve + validate the picker (best-effort attribution). ──
  // Fetched account-scoped (.eq user_id) so a foreign employee simply comes back null and is
  // rejected. Only role 'fulfillment' (trim/lowercase) with status active/probation is stamped.
  const rawPicker = typeof body.picker_employee_id === 'string' ? body.picker_employee_id.trim() : '';
  let pickerEmployeeId: string | null = null;
  let pickerNameSnapshot: string | null = null;
  if (rawPicker) {
    const { data: emp } = await supabase
      .from('employees')
      .select('id, name, role, status')
      .eq('user_id', user.id)
      .eq('id', rawPicker)
      .maybeSingle();
    const v = validatePicker(emp);
    if (v.valid && emp) {
      pickerEmployeeId = emp.id as string;
      pickerNameSnapshot = emp.name as string;
    } else {
      // Never fail the completion — record Unassigned, but log so a bad client is visible.
      console.warn(`[shipping/confirm] picker not attributed (${v.reason}) for group ${groupKey}`);
    }
  }

  // Derive store from the orders in this box (fulfillment context, not a session).
  // Orders in a box share a store; take the first synced order's store_id. Null →
  // the set_store_id trigger backstops it (e.g. orders not yet synced).
  let storeId: string | null = null;
  if (orderIds.length) {
    const { data: ord } = await supabase
      .from('synced_order_ids')
      .select('store_id')
      .in('order_id', orderIds)
      .not('store_id', 'is', null)
      .limit(1)
      .maybeSingle();
    storeId = (ord?.store_id as string | null) ?? null;
  }

  // Pick start time (box-load instant) — independent of attribution; enables true per-box
  // duration (verified_at − pick_started_at). Normalized only when a parseable timestamp is sent.
  const rawStart = typeof body.pick_started_at === 'string' ? body.pick_started_at.trim() : '';
  const pickStartedAt = rawStart && Number.isFinite(Date.parse(rawStart)) ? new Date(rawStart).toISOString() : null;

  const row = buildVerificationRow({
    userId: user.id,
    groupKey,
    orderIds,
    verifiedAt: new Date().toISOString(),
    storeId,
    pickerEmployeeId,
    pickerNameSnapshot,
    pickStartedAt,
  });

  // ON CONFLICT (user_id, group_key) DO NOTHING — first confirm wins; a re-confirm is a
  // successful no-op that preserves the original verified_at / pick_started_at / picker.
  const { error } = await supabase
    .from('shipment_verifications')
    .upsert(row, { onConflict: 'user_id,group_key', ignoreDuplicates: true });

  if (error) {
    console.error('[shipping/confirm] insert error:', error);
    return NextResponse.json({ error: 'Failed to save verification' }, { status: 500 });
  }
  return NextResponse.json({ ok: true, group_key: groupKey });
}
