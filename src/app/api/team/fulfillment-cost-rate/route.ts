import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import {
  SHOP_TIMEZONE, zonedDayKey, zonedDayStartUtcMs, addDaysISO,
} from '@/lib/shipping/pickerPerformance';
import { isFulfillmentTrack, type CostEmployee, type CostShift, type OpenPunch } from '@/lib/shipping/pickCostEconomics';
import { trailingFulfillmentRate, type WindowVolume } from '@/lib/shipping/trailingFulfillmentRate';

export const dynamic = 'force-dynamic';

// GET /api/team/fulfillment-cost-rate?days=30
//
// The crew's pooled fulfillment labor cost per unit SOLD over the last N COMPLETED fulfillment
// days — the rate the Shows tab allocates picking labor at. See
// src/lib/shipping/trailingFulfillmentRate.ts for why the denominator is units sold rather than
// units picked (the picked basis over-allocated real payroll by 46%), and
// src/lib/shows/netEconomics.ts for why this is an allocation at all.
//
// THE DAY IN PROGRESS IS EXCLUDED. Early in a fulfillment day the crew has accrued hours but
// few boxes have been verified, so including it makes picking look several times more expensive
// for a few hours every morning. The window is [today−N, today) in fulfillment days.
//
// PAY DATA: like /api/team/fulfillment-performance, this reads hourly_rate because a cost per
// unit cannot be computed without it, and for the same reasons that is acceptable here:
//   • Owner-only, enforced upstream. '/api/team' appears in neither STATION_CONFINEMENT.allow
//     nor MEMBER_SCOPE_PATHS (src/lib/supabase/claims.ts), and confinementFor() fails closed, so
//     station / member / timeclock sessions are bounced before the handler runs.
//   • No individual rate is ever returned — only pooled hours and cents, and cents-per-unit.
// The payroll gate is not weakened: unconfirmed hours are reported as pending_* alongside the
// confirmed figures, exactly as the performance route does.
export async function GET(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const raw = Number(searchParams.get('days'));
  // 1..60 days, defaulting to 30. Clamped rather than rejected — a smoothing window, not an
  // identifier. 30 is the default because the rate is an ALLOCATION, so stability matters more
  // than recency: at 7 days it read $0.449/unit against $0.500 at 30, the difference being one
  // bad week of pick recording rather than any real change in what fulfillment costs. At 30 days
  // the labor is also almost entirely manager-confirmed ($46,274 of $47,488), so the figure is
  // close to settled rather than a projection.
  const days = Number.isFinite(raw) ? Math.min(60, Math.max(1, Math.trunc(raw))) : 30;

  const today = zonedDayKey(Date.now(), SHOP_TIMEZONE);
  const firstDay = addDaysISO(today, -days);
  const dayKeys = Array.from({ length: days }, (_, i) => addDaysISO(firstDay, i));

  // Window bounds come from the SAME helper that owns the 04:00 boundary, so the RPC's unit
  // count and trailingPickRate's hours cover identical time by construction.
  const startISO = new Date(zonedDayStartUtcMs(firstDay, SHOP_TIMEZONE)).toISOString();
  const endISO = new Date(zonedDayStartUtcMs(today, SHOP_TIMEZONE)).toISOString();

  // Window volume in TWO round trips (migrations 123 and 122). Reading the raw rows instead
  // would be ~19 paged verification requests plus a chunked synced_order_ids read for a 7-day
  // window alone, and PostgREST truncates a single response at 1000 rows SILENTLY.
  //
  // Both are called on the USER SESSION, not the service role. Neither function takes an owner
  // argument — each scopes itself to auth.uid() — so there is no id to pass wrongly and no
  // service-role key anywhere in this path.
  //
  // 123 (sold) is the allocation denominator. 122 (picked) is fetched ONLY to expose the
  // pick-recording coverage ratio; nothing divides by it. Both are required: a failure to read
  // either is reported rather than silently degrading the rate, since a missing picked count
  // would hide exactly the data-quality signal this pairing exists to surface.
  const [soldRes, pickedRes] = await Promise.all([
    supabase.rpc('lensed_sold_units_in_window', { p_start: startISO, p_end: endISO }),
    supabase.rpc('lensed_pick_units_in_window', { p_start: startISO, p_end: endISO }),
  ]);
  if (soldRes.error) {
    console.error('[team/fulfillment-cost-rate] sold volume error:', soldRes.error);
    return NextResponse.json({ error: 'Failed to load sold volume' }, { status: 500 });
  }
  if (pickedRes.error) {
    console.error('[team/fulfillment-cost-rate] pick volume error:', pickedRes.error);
    return NextResponse.json({ error: 'Failed to load pick volume' }, { status: 500 });
  }
  const soldRow = Array.isArray(soldRes.data) ? soldRes.data[0] : soldRes.data;
  const pickedRow = Array.isArray(pickedRes.data) ? pickedRes.data[0] : pickedRes.data;
  const volume: WindowVolume = {
    sold_units: Number(soldRow?.units ?? 0),
    sold_orders: Number(soldRow?.orders ?? 0),
    cancelled_orders: Number(soldRow?.cancelled_orders ?? 0),
    picked_units: Number(pickedRow?.units ?? 0),
    boxes: Number(pickedRow?.boxes ?? 0),
  };

  const { data: emps, error: empErr } = await supabase
    .from('employees')
    .select('id, role, hourly_rate, fulfillment_track');
  if (empErr) {
    console.error('[team/fulfillment-cost-rate] employees error:', empErr);
    return NextResponse.json({ error: 'Failed to load team' }, { status: 500 });
  }

  // Shifts spanning [firstDay−1, today+1] by shifts.date — a deliberate SUPERSET, same reasoning
  // as the performance route: a night punch clocking in 17:00 and out 01:30 carries the earlier
  // date, and a manual shift has no punch instants at all. employeeCostForDay() then narrows
  // each day through shiftFulfillmentDay()'s exact 04:00→04:00 boundary.
  const { data: shiftRows, error: shiftErr } = await supabase
    .from('shifts')
    .select('employee_id, date, start_time, end_time, source, source_rule_id, confirmed_at, break_minutes, clock_in_at, clock_out_at')
    .gte('date', addDaysISO(firstDay, -1))
    .lte('date', addDaysISO(today, 1));
  if (shiftErr) {
    console.error('[team/fulfillment-cost-rate] shifts error:', shiftErr);
    return NextResponse.json({ error: 'Failed to load fulfillment hours' }, { status: 500 });
  }

  // OPEN punches still matter even though today is excluded: a night-crew punch that clocked in
  // at 17:00 belongs to YESTERDAY's fulfillment day, which is inside the window.
  const { data: openEntries, error: openErr } = await supabase
    .from('employee_time_entries')
    .select('id, employee_id, clocked_in_at')
    .is('clocked_out_at', null);
  if (openErr) {
    console.error('[team/fulfillment-cost-rate] open time entries error:', openErr);
    return NextResponse.json({ error: 'Failed to load fulfillment hours' }, { status: 500 });
  }

  const openEntryIds = (openEntries ?? []).map((e) => e.id as string);
  let breakRows: Record<string, unknown>[] = [];
  if (openEntryIds.length > 0) {
    const { data: brk, error: brkErr } = await supabase
      .from('employee_time_breaks')
      .select('time_entry_id, started_at, ended_at')
      .in('time_entry_id', openEntryIds);
    if (brkErr) {
      console.error('[team/fulfillment-cost-rate] breaks error:', brkErr);
      return NextResponse.json({ error: 'Failed to load fulfillment hours' }, { status: 500 });
    }
    breakRows = brk ?? [];
  }

  const nowMs = Date.now();
  // Breaks closed during the open punch AND any still running, so somebody on lunch does not
  // accrue paid minutes (identical handling to the performance route).
  const breakMinutesByEntry = new Map<string, number>();
  for (const b of breakRows) {
    const startMs = Date.parse(String(b.started_at));
    if (!Number.isFinite(startMs)) continue;
    const endRaw = b.ended_at as string | null;
    const endMs = endRaw ? Date.parse(endRaw) : nowMs;
    if (!Number.isFinite(endMs) || endMs <= startMs) continue;
    const id = String(b.time_entry_id);
    breakMinutesByEntry.set(id, (breakMinutesByEntry.get(id) ?? 0) + (endMs - startMs) / 60_000);
  }

  const openPunches: OpenPunch[] = (openEntries ?? []).map((e) => ({
    employee_id: String(e.employee_id),
    clocked_in_at: String(e.clocked_in_at),
    break_minutes_so_far: breakMinutesByEntry.get(String(e.id)) ?? 0,
  }));

  const costEmployees: CostEmployee[] = (emps ?? []).map((e) => {
    const rawTrack = e.fulfillment_track as string | null;
    return {
      id: e.id as string,
      // role is free text in the schema, so normalise defensively (same as validatePicker).
      role: (e.role as string | null ?? '').trim().toLowerCase(),
      hourly_rate: Number(e.hourly_rate) || 0,
      fulfillment_track: isFulfillmentTrack(rawTrack) ? rawTrack : null,
    };
  });

  const rate = trailingFulfillmentRate(
    costEmployees,
    (shiftRows ?? []) as unknown as CostShift[],
    dayKeys,
    volume,
    SHOP_TIMEZONE,
    openPunches,
    nowMs,
  );

  return NextResponse.json({
    window: { days, first_day: firstDay, last_day: addDaysISO(today, -1), start: startISO, end: endISO },
    ...rate,
  });
}
