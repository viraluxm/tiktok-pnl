import { NextResponse } from 'next/server';
import { requireStationScope } from '@/lib/station/guard';
import { validatePicker } from '@/lib/shipping/pickerPerformance';
import { buildVerificationRow } from '@/lib/shipping/confirmRow';

export const dynamic = 'force-dynamic';

// POST /api/station/confirm — mark a box picked/verified from the station. Same as
// /api/shipping/confirm (picker validation + shipment_verifications upsert), but service_role and
// scoped to the store owners. CRITICAL: the upsert conflict key is (user_id, group_key) and the
// row's user_id MUST be the box OWNER's, not the station account — otherwise the box would record
// under an id that owns no data and never dedupe against the operator flow.
export async function POST(req: Request) {
  const scope = await requireStationScope();
  if (!scope.ok) return scope.response;
  const { admin, ownerIds } = scope;

  let body: { group_key?: string; order_ids?: string[]; picker_employee_id?: string; pick_started_at?: string};
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Expected JSON body' }, { status: 400 }); }

  const groupKey = typeof body.group_key === 'string' ? body.group_key.trim() : '';
  if (!groupKey) return NextResponse.json({ error: 'Missing group_key' }, { status: 400 });
  const orderIds = Array.isArray(body.order_ids)
    ? body.order_ids.filter((x): x is string => typeof x === 'string')
    : [];
  if (!orderIds.length) return NextResponse.json({ error: 'Missing order_ids' }, { status: 400 });

  // Resolve the box OWNER (whose user_id keys the verification) + its store from the orders,
  // constrained to the station's owner scope. All orders in a box share one owner user_id.
  const { data: ownerRow } = await admin
    .from('synced_order_ids')
    .select('user_id')
    .in('order_id', orderIds)
    .in('user_id', ownerIds)
    .limit(1)
    .maybeSingle();
  const ownerUserId = (ownerRow?.user_id as string | null) ?? null;
  if (!ownerUserId) {
    return NextResponse.json({ error: 'Could not resolve box owner for confirmation' }, { status: 400 });
  }
  // Store: first order in the box with a non-null store_id (mirrors /api/shipping/confirm).
  const { data: storeRow } = await admin
    .from('synced_order_ids')
    .select('store_id')
    .in('order_id', orderIds)
    .eq('user_id', ownerUserId)
    .not('store_id', 'is', null)
    .limit(1)
    .maybeSingle();
  const storeId = (storeRow?.store_id as string | null) ?? null;

  // Validate the picker against the OWNER's employees (role fulfillment, active/probation).
  // Best-effort: an invalid/absent picker records Unassigned and never blocks the write.
  const rawPicker = typeof body.picker_employee_id === 'string' ? body.picker_employee_id.trim() : '';
  let pickerEmployeeId: string | null = null;
  let pickerNameSnapshot: string | null = null;
  if (rawPicker) {
    const { data: emp } = await admin
      .from('employees')
      .select('id, name, role, status')
      .eq('user_id', ownerUserId)
      .eq('id', rawPicker)
      .maybeSingle();
    const v = validatePicker(emp);
    if (v.valid && emp) {
      pickerEmployeeId = emp.id as string;
      pickerNameSnapshot = emp.name as string;
    } else {
      console.warn(`[station/confirm] picker not attributed (${v.reason}) for group ${groupKey}`);
    }
  }

  const rawStart = typeof body.pick_started_at === 'string' ? body.pick_started_at.trim() : '';
  const pickStartedAt = rawStart && Number.isFinite(Date.parse(rawStart)) ? new Date(rawStart).toISOString() : null;

  const row = buildVerificationRow({
    userId: ownerUserId,           // the OWNER's id, not the station account
    groupKey,
    orderIds,
    verifiedAt: new Date().toISOString(),
    storeId,
    pickerEmployeeId,
    pickerNameSnapshot,
    pickStartedAt,
  });

  const { error } = await admin
    .from('shipment_verifications')
    .upsert(row, { onConflict: 'user_id,group_key', ignoreDuplicates: true });
  if (error) {
    console.error('[station/confirm] insert error:', error);
    return NextResponse.json({ error: 'Failed to save verification' }, { status: 500 });
  }
  return NextResponse.json({ ok: true, group_key: groupKey });
}
