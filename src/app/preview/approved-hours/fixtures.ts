import { addDaysISO, laWallTimeToUtc } from '@/lib/schedule/timezone';

// FIXTURES FOR THE APPROVED-HOURS ROLE REVIEW ROUTE. Plain objects in the shape buildCalendarDays
// takes — no query, no Supabase client, nothing that can reach a database or a real employee.
//
// The names and spans are the ones in the change request, so the page can be read against it
// directly: Juan Reyes (Fulfillment) 6:00 AM – 2:00 PM, Adriana Cruz (Live Host) 4:00 PM – 10:00 PM,
// and a second fulfillment person who worked TWO sessions in the same day.

export const PREVIEW_DATE = '2026-09-15'; // a Tuesday
export const PREVIEW_DAYS = ['2026-09-14', PREVIEW_DATE, '2026-09-16'];
export const PREVIEW_TODAY = '2026-09-16'; // the day under review is in the past

export interface PreviewPunch {
  id: string;
  employee_id: string;
  source: string | null;
  date: string;
  start_time: string;
  end_time: string | null;
  clock_in_at: string | null;
  clock_out_at: string | null;
  break_minutes: number;
  confirmed_at: string | null;
  approved_minutes?: number | null;
  auto_closed?: boolean;
}

export const PREVIEW_EMPLOYEES = [
  { id: 'e-juan', name: 'Juan Reyes', role: 'fulfillment' },
  { id: 'e-adriana', name: 'Adriana Cruz', role: 'host' },
  { id: 'e-marisol', name: 'Marisol Vega', role: 'fulfillment' },
  { id: 'e-roberto', name: 'Roberto Salas', role: 'fulfillment' },
];

/** 'HH:MM' as minutes since midnight, for the overnight test below. */
const mins = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

function punch(
  id: string,
  employee_id: string,
  start: string,
  end: string | null,
  over: Partial<PreviewPunch> = {},
): PreviewPunch {
  // A clock-out at or before the clock-in on the wall clock means the shift ran past midnight, so
  // the OUT instant belongs to the next calendar day. Getting this wrong is not cosmetic here: the
  // instants are what clockedShiftHours reads, and a backwards span floors to zero hours — which
  // would make the Roberto row read "0h 00m paid" and quietly prove the wrong thing.
  const endDate = end != null && mins(end) <= mins(start) ? addDaysISO(PREVIEW_DATE, 1) : PREVIEW_DATE;
  return {
    id,
    employee_id,
    source: 'time_clock',
    date: PREVIEW_DATE,
    start_time: start,
    end_time: end,
    clock_in_at: laWallTimeToUtc(PREVIEW_DATE, start).toISOString(),
    clock_out_at: end ? laWallTimeToUtc(endDate, end).toISOString() : null,
    break_minutes: 0,
    confirmed_at: null,
    approved_minutes: null,
    auto_closed: false,
    ...over,
  };
}

export const CONFIRMED_AT = '2026-09-16T01:00:00.000Z';

/** FULFILLMENT, one session — 6:00 AM to 2:00 PM with a 40-minute unpaid break. Awaiting confirm. */
export const JUAN_DAY = punch('pk-juan', 'e-juan', '06:00', '14:00', { break_minutes: 40 });

/** LIVE HOST — 4:00 PM to 10:00 PM. Awaiting confirmation, and the approved figure is required. */
export const ADRIANA_SHOW = punch('pk-adriana', 'e-adriana', '16:00', '22:00');

/** The same host shift, already confirmed at 5h 20m of verified live time — the adjust case. */
export const ADRIANA_CONFIRMED = punch('pk-adriana', 'e-adriana', '16:00', '22:00', {
  confirmed_at: CONFIRMED_AT,
  approved_minutes: 320,
});

/** FULFILLMENT, split day — morning session 6:00 AM to 10:00 AM. */
export const MARISOL_MORNING = punch('pk-am', 'e-marisol', '06:00', '10:00');

/** FULFILLMENT, split day — afternoon session 2:00 PM to 6:00 PM. Separate row, separate confirm. */
export const MARISOL_AFTERNOON = punch('pk-pm', 'e-marisol', '14:00', '18:00');

/**
 * THE ROBERTO CASE, reproduced from the real production row (read-only, 2026-09-12):
 *   shift bc7a1b1b-6440-40bf-8e95-7cb52c300435 · 2026-09-10 · Roberto, fulfillment, $22.00/h
 *   punched 4:55 PM → 1:00 AM with a 25-minute unpaid break, and carries approved_minutes = 1421
 *   (23h 41m) — a fat-finger typed before approved hours became live-host-only.
 *
 * Under the OLD rule that figure paid $521.03. Under THIS rule it pays nothing at all: the tile
 * shows the punch, payroll uses the punch, and the stored 1421 survives only as audit history.
 * The row is here so a reviewer can see exactly that — no Approved read-out, no editor, and a
 * Paid figure that is the clocked one.
 *
 * (The person is renamed for the preview. No production employee, id or name appears on this page.)
 */
export const ROBERTO_LEGACY = punch('pk-legacy', 'e-roberto', '16:55', '01:00', {
  break_minutes: 25,
  confirmed_at: CONFIRMED_AT,
  approved_minutes: 1421,
  // The clock-in instant is written out to the SECOND, exactly as production holds it (:17), so
  // the figures on this page are the real ones — 7.661856 h and $168.56 — rather than a
  // whole-minute approximation that would be 30 seconds and 18 cents off.
  clock_in_at: laWallTimeToUtc(PREVIEW_DATE, '16:55').toISOString().replace(':00.000Z', ':17.317Z'),
});

/** What that shift is worth, so the preview can print the money without inventing a rate. */
export const ROBERTO_RATE = 22;

/** Nobody is scheduled in this review — the tiles are about worked time, not the plan. */
export const PREVIEW_SCHEDULED: never[] = [];
