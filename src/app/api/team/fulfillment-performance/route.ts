import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import {
  SHOP_TIMEZONE, MAX_PICK_DURATION_MS, zonedDayKey, zonedDayRangeUtcMs, addDaysISO,
  aggregateFulfillmentDay, type PickEvent,
} from '@/lib/shipping/pickerPerformance';
import {
  buildFulfillmentEconomics, employeeCostForDay, isFulfillmentTrack,
  type CostShift, type CostEmployee, type FulfillmentTrack,
} from '@/lib/shipping/pickCostEconomics';

export const dynamic = 'force-dynamic';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

// GET: daily fulfillment performance + unit economics for ONE fulfillment day (America/Los_Angeles).
//   ?date=YYYY-MM-DD  (defaults to the fulfillment day in progress)
//
// A fulfillment day runs local 04:00 → 04:00 (SHIFT_DAY_START_HOUR), NOT midnight → midnight.
// The night crew works ~17:00–01:00, so a midnight boundary split every night shift into two
// partial days and reported the tail of one shift alongside the head of the next. All day
// math goes through zonedDayKey / zonedDayRangeUtcMs, which own that boundary.
//
// PAY DATA: this route DOES read hourly_rate, deliberately — reversing an earlier "no pay
// here" rule, because $/box and $/SKU cannot be computed without it. What that costs and why
// it is acceptable:
//   • Reach is owner-only, and enforced upstream rather than here. This path appears in
//     neither STATION_CONFINEMENT.allow nor MEMBER_SCOPE_PATHS (src/lib/supabase/middleware.ts),
//     so station and member sessions get a hard 403 before the handler runs. Adding this path
//     to either allowlist would leak labor cost — and, by division, individual pay rates.
//   • No individual rate is ever returned. Only aggregated money (cents per box, cents per
//     SKU, hours, and dollar totals) leaves this route. hourly_rate is multiplied into cents
//     inside the pure module and never echoed.
// The payroll gate is NOT weakened to make numbers appear: hours that a manager has not yet
// confirmed are reported as `pending_*`, separately from what payroll will actually pay.
//
// KPI math runs in the pure, unit-tested aggregateFulfillmentDay() + pickCostEconomics; no
// averages, rates or costs are persisted.
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

  // Employees: name + role + status for the roster, plus hourly_rate and fulfillment_track for
  // the cost math. nameById covers ALL employees so a renamed picker shows their current name.
  const { data: emps, error: empErr } = await supabase
    .from('employees')
    .select('id, name, role, status, hourly_rate, fulfillment_track');
  if (empErr) {
    console.error('[team/fulfillment-performance] employees error:', empErr);
    return NextResponse.json({ error: 'Failed to load team' }, { status: 500 });
  }

  // Shifts spanning [day-1, day+1] by shifts.date — a deliberate SUPERSET. A night punch that
  // clocks in 17:00 and out 01:30 carries the earlier date, and a manual shift has no punch
  // instants at all, so a same-date-only filter would drop both. shiftFulfillmentDay() inside
  // employeeCostForDay() then narrows to the exact 04:00→04:00 day. Filtering on `date`
  // (indexed, plain range) rather than composing an .or() across two columns.
  const { data: shiftRows, error: shiftErr } = await supabase
    .from('shifts')
    .select('employee_id, date, start_time, end_time, source, source_rule_id, confirmed_at, break_minutes, clock_in_at, clock_out_at')
    .gte('date', addDaysISO(day, -1))
    .lte('date', addDaysISO(day, 1));
  if (shiftErr) {
    console.error('[team/fulfillment-performance] shifts error:', shiftErr);
    return NextResponse.json({ error: 'Failed to load fulfillment hours' }, { status: 500 });
  }

  const nameById: Record<string, string> = {};
  const trackById: Record<string, FulfillmentTrack | null> = {};
  const costEmployees: CostEmployee[] = [];
  let eligiblePickerCount = 0;

  for (const e of emps ?? []) {
    const id = e.id as string;
    nameById[id] = e.name as string;
    // role is free text in the schema, so normalise defensively (same as validatePicker).
    const role = (e.role as string | null ?? '').trim().toLowerCase();
    const rawTrack = e.fulfillment_track as string | null;
    trackById[id] = isFulfillmentTrack(rawTrack) ? rawTrack : null;
    costEmployees.push({ id, role, hourly_rate: Number(e.hourly_rate) || 0, fulfillment_track: trackById[id] });
    if (role === 'fulfillment' && (e.status === 'active' || e.status === 'probation')) {
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

  const costByEmployee = employeeCostForDay(
    costEmployees,
    (shiftRows ?? []) as unknown as CostShift[],
    day,
    SHOP_TIMEZONE,
  );
  // result.summary counts attributed + UNASSIGNED boxes; passing it makes the crew denominator
  // the day's total completed work, so paid hours are not charged against only the attributed
  // boxes (which overstated the crew rate — see buildFulfillmentEconomics).
  const economics = buildFulfillmentEconomics(
    result.pickers, costByEmployee, nameById, trackById,
    { boxes_completed: result.summary.boxes_completed, orders_picked: result.summary.orders_picked },
  );

  return NextResponse.json({
    day,
    tz: SHOP_TIMEZONE,
    max_pick_ms: MAX_PICK_DURATION_MS,
    eligible_picker_count: eligiblePickerCount,
    ...result,
    // `pickers` above stays exactly as aggregateFulfillmentDay produced it (unchanged contract);
    // `rows` is that list plus track, cost, and the on-clock-but-zero-boxes people.
    rows: economics.rows,
    cost: economics.cost,
    unproductive_hours: economics.unproductive_hours,
    unproductive_cents: economics.unproductive_cents,
    suspect_hours: economics.suspect_hours,
    suspect_punches: economics.suspect_punches,
  });
}
