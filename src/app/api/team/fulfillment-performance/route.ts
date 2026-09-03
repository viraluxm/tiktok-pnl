import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import {
  SHOP_TIMEZONE, MAX_PICK_DURATION_MS, zonedDayKey, zonedDayRangeUtcMs, addDaysISO,
  aggregateFulfillmentDay, type PickEvent,
} from '@/lib/shipping/pickerPerformance';
import {
  buildFulfillmentEconomics, employeeCostForDay, isFulfillmentTrack,
  shiftFulfillmentDay,
  type CostShift, type CostEmployee, type FulfillmentTrack, type OpenPunch,
  type CostBox, type PunchWindow,
} from '@/lib/shipping/pickCostEconomics';

export const dynamic = 'force-dynamic';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

// PostgREST caps a single response at 1000 rows server-side, silently — no error, no marker,
// just a short array. A busy fulfillment day exceeds that: 2026-08-31 completed 1,159 boxes and
// this route reported exactly 1000 of them (2,705 SKUs instead of 3,181), which understated
// Orders, Boxes and Average Pick Time and would have divided real labor cost by a truncated
// box count. So every verifications read is PAGED to exhaustion rather than issued once.
const PAGE_SIZE = 1000;

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

  // Completed-box events for the day, read to EXHAUSTION (see PAGE_SIZE — a single response is
  // capped at 1000 rows and a busy day exceeds it). RLS scopes to this account; the
  // (user_id, verified_at) index (migration 066) serves this range scan, and ordering by
  // verified_at makes the pages a stable, non-overlapping partition of the window.
  const rows: Record<string, unknown>[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data: page, error } = await supabase
      .from('shipment_verifications')
      .select('group_key, picker_employee_id, picker_name_snapshot, pick_started_at, order_ids, verified_at')
      .gte('verified_at', startISO)
      .lt('verified_at', endISO)
      .order('verified_at', { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) {
      console.error('[team/fulfillment-performance] verifications error:', error);
      return NextResponse.json({ error: 'Failed to load picker performance' }, { status: 500 });
    }
    rows.push(...(page ?? []));
    // A short page is the last page. aggregateFulfillmentDay de-dupes by group_key, so even if
    // a concurrent insert shifted the window mid-scan a repeated box could not be double-counted.
    if (!page || page.length < PAGE_SIZE) break;
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

  // IN-PROGRESS punches. A `shifts` row is only written at CLOCK-OUT, so without this the
  // whole working day has zero hours to divide by and both cost figures render "—" until the
  // crew punches out. Read the open entries and count elapsed time as live hours.
  const { data: openEntries, error: openErr } = await supabase
    .from('employee_time_entries')
    .select('id, employee_id, clocked_in_at')
    .is('clocked_out_at', null);
  if (openErr) {
    console.error('[team/fulfillment-performance] open time entries error:', openErr);
    return NextResponse.json({ error: 'Failed to load fulfillment hours' }, { status: 500 });
  }

  // Breaks belonging to those open punches — closed ones AND any still running, so somebody
  // sitting on lunch does not accrue paid minutes into the live figure.
  const openEntryIds = (openEntries ?? []).map((e) => e.id as string);
  let breakRows: Record<string, unknown>[] = [];
  if (openEntryIds.length > 0) {
    const { data: brk, error: brkErr } = await supabase
      .from('employee_time_breaks')
      .select('time_entry_id, started_at, ended_at')
      .in('time_entry_id', openEntryIds);
    if (brkErr) {
      console.error('[team/fulfillment-performance] breaks error:', brkErr);
      return NextResponse.json({ error: 'Failed to load fulfillment hours' }, { status: 500 });
    }
    breakRows = brk ?? [];
  }

  const nowMs = Date.now();
  const breakMinutesByEntry = new Map<string, number>();
  for (const b of breakRows) {
    const startMs = Date.parse(String(b.started_at));
    if (!Number.isFinite(startMs)) continue;
    const endRaw = b.ended_at as string | null;
    const endMs = endRaw ? Date.parse(endRaw) : nowMs; // null = break still running
    if (!Number.isFinite(endMs) || endMs <= startMs) continue;
    const id = String(b.time_entry_id);
    breakMinutesByEntry.set(id, (breakMinutesByEntry.get(id) ?? 0) + (endMs - startMs) / 60_000);
  }

  const openPunches: OpenPunch[] = (openEntries ?? []).map((e) => ({
    employee_id: String(e.employee_id),
    clocked_in_at: String(e.clocked_in_at),
    break_minutes_so_far: breakMinutesByEntry.get(String(e.id)) ?? 0,
  }));

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

  const boxes: CostBox[] = events.map((e) => ({
    picker_employee_id: e.picker_employee_id,
    picker_name_snapshot: e.picker_name_snapshot,
    order_ids: e.order_ids,
    verified_at: e.verified_at,
  }));

  // TRUE unit counts. $/SKU divides by UNITS, and an order can hold more than one (139 of
  // 148,647 since July do), so the length of order_ids is not a safe denominator. Read the
  // day's orders in chunks — an `in()` list of a few thousand ids exceeds the URL limit — and
  // page each chunk, since the 1000-row cap applies here too.
  const allOrderIds = [...new Set(boxes.flatMap((b) => b.order_ids))];
  const unitsByOrderId = new Map<string, number>();
  const ID_CHUNK = 200;
  for (let i = 0; i < allOrderIds.length; i += ID_CHUNK) {
    const chunk = allOrderIds.slice(i, i + ID_CHUNK);
    for (let from = 0; ; from += PAGE_SIZE) {
      const { data: page, error: unitErr } = await supabase
        .from('synced_order_ids')
        .select('order_id, units')
        .in('order_id', chunk)
        .range(from, from + PAGE_SIZE - 1);
      if (unitErr) {
        console.error('[team/fulfillment-performance] units error:', unitErr);
        return NextResponse.json({ error: 'Failed to load SKU counts' }, { status: 500 });
      }
      for (const r of page ?? []) {
        unitsByOrderId.set(String(r.order_id), Math.max(1, Number(r.units) || 1));
      }
      if (!page || page.length < PAGE_SIZE) break;
    }
  }

  const costByEmployee = employeeCostForDay(
    costEmployees,
    (shiftRows ?? []) as unknown as CostShift[],
    day,
    SHOP_TIMEZONE,
    openPunches,
    nowMs,
  );

  // Punch windows for the off-clock check — closed punches from `shifts`, plus the open ones
  // (end null = still running). A box completed outside every window means its hours are
  // missing from the numerator, so $/box reads too cheap; that is surfaced, not corrected.
  const fulfillmentIds = new Set(costEmployees.filter((e) => e.role === 'fulfillment').map((e) => e.id));
  const punchWindows: PunchWindow[] = [];
  let shiftsExamined = 0;
  let shiftsWithBreak = 0;
  for (const sh of (shiftRows ?? []) as unknown as CostShift[]) {
    if (!fulfillmentIds.has(sh.employee_id)) continue;
    if (sh.clock_in_at && sh.clock_out_at) {
      punchWindows.push({ employee_id: sh.employee_id, start: sh.clock_in_at, end: sh.clock_out_at });
    }
    if (shiftFulfillmentDay(sh, SHOP_TIMEZONE) !== day) continue;
    shiftsExamined += 1;
    if ((sh.break_minutes ?? 0) > 0) shiftsWithBreak += 1;
  }
  for (const op of openPunches) {
    if (!fulfillmentIds.has(op.employee_id)) continue;
    punchWindows.push({ employee_id: op.employee_id, start: op.clocked_in_at, end: null });
  }

  // result.summary counts attributed + UNASSIGNED boxes; passing it makes the crew denominator
  // the day's total completed work, so paid hours are not charged against only the attributed
  // boxes (which overstated the crew rate — see buildFulfillmentEconomics).
  const economics = buildFulfillmentEconomics({
    pickers: result.pickers,
    costByEmployee,
    nameById,
    trackById,
    boxes,
    unitsByOrderId,
    punchWindows,
    dayTotals: {
      boxes_completed: result.summary.boxes_completed,
      orders_picked: result.summary.orders_picked,
    },
    breakStats: { shifts: shiftsExamined, withBreak: shiftsWithBreak },
    nowMs,
  });

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
    skus_picked: economics.skus_picked,
    unproductive_hours: economics.unproductive_hours,
    unproductive_cents: economics.unproductive_cents,
    suspect_hours: economics.suspect_hours,
    suspect_punches: economics.suspect_punches,
    quality: economics.quality,
  });
}
