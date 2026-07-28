import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import {
  SHOP_TIMEZONE, MAX_PICK_DURATION_MS, zonedDayKey, zonedDayRangeUtcMs, aggregateFulfillmentDay,
  type PickEvent,
} from '@/lib/shipping/pickerPerformance';

export const dynamic = 'force-dynamic';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

// GET: daily fulfillment-picker performance for ONE business day (America/Los_Angeles).
//   ?date=YYYY-MM-DD  (defaults to today in the shop timezone)
//
// Reads ONLY the selected day's shipment_verifications for this account (RLS auto-scopes to
// the caller — single-account model). Employee rows are read name-only (id, name, role,
// status) — hourly_rate / pay is NEVER selected here. KPI math runs in the pure, unit-tested
// aggregateFulfillmentDay(); no averages are persisted.
export async function GET(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const dateParam = searchParams.get('date');
  const day = dateParam && DAY_RE.test(dateParam) ? dateParam : zonedDayKey(Date.now(), SHOP_TIMEZONE);

  const { startMs, endMs } = zonedDayRangeUtcMs(day, SHOP_TIMEZONE);
  const startISO = new Date(startMs).toISOString();
  const endISO = new Date(endMs).toISOString();

  // Completed-box events for the day. RLS scopes to this account; the (user_id, verified_at)
  // index (migration 066) serves this range scan.
  const { data: rows, error } = await supabase
    .from('shipment_verifications')
    .select('group_key, picker_employee_id, picker_name_snapshot, pick_started_at, order_ids, verified_at')
    .gte('verified_at', startISO)
    .lt('verified_at', endISO)
    .order('verified_at', { ascending: true });
  if (error) {
    console.error('[team/fulfillment-performance] verifications error:', error);
    return NextResponse.json({ error: 'Failed to load picker performance' }, { status: 500 });
  }

  // Name-only employee read (NO pay). nameById covers ALL employees so a renamed picker shows
  // their current name; eligible = active/probation fulfillment (roster context only).
  const { data: emps, error: empErr } = await supabase
    .from('employees')
    .select('id, name, role, status');
  if (empErr) {
    console.error('[team/fulfillment-performance] employees error:', empErr);
    return NextResponse.json({ error: 'Failed to load team' }, { status: 500 });
  }
  const nameById: Record<string, string> = {};
  let eligiblePickerCount = 0;
  for (const e of emps ?? []) {
    nameById[e.id as string] = e.name as string;
    if ((e.role ?? '').trim().toLowerCase() === 'fulfillment' && (e.status === 'active' || e.status === 'probation')) {
      eligiblePickerCount += 1;
    }
  }

  const events: PickEvent[] = (rows ?? []).map((r) => ({
    group_key: String(r.group_key),
    picker_employee_id: (r.picker_employee_id as string | null) ?? null,
    picker_name_snapshot: (r.picker_name_snapshot as string | null) ?? null,
    pick_started_at: (r.pick_started_at as string | null) ?? null,
    verified_at: String(r.verified_at),
    order_ids: Array.isArray(r.order_ids) ? (r.order_ids as string[]) : [],
  }));

  const result = aggregateFulfillmentDay(events, nameById);

  return NextResponse.json({
    day,
    tz: SHOP_TIMEZONE,
    max_pick_ms: MAX_PICK_DURATION_MS,
    eligible_picker_count: eligiblePickerCount,
    ...result,
  });
}
