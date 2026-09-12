import { laWallTimeToUtc } from '@/lib/schedule/timezone';

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
];

function punch(
  id: string,
  employee_id: string,
  start: string,
  end: string | null,
  over: Partial<PreviewPunch> = {},
): PreviewPunch {
  return {
    id,
    employee_id,
    source: 'time_clock',
    date: PREVIEW_DATE,
    start_time: start,
    end_time: end,
    clock_in_at: laWallTimeToUtc(PREVIEW_DATE, start).toISOString(),
    clock_out_at: end ? laWallTimeToUtc(PREVIEW_DATE, end).toISOString() : null,
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
 * A LEGACY fulfillment row: confirmed BEFORE this change, so it still carries an approved figure —
 * here the fat-finger shape production actually holds (23h 41m approved against a 7h 40m punch).
 * This build offers no way to create another one, and no way to edit this one from the tile; it is
 * on the page so the reviewer can see that the stored figure is still SHOWN rather than hidden,
 * because it is still what payroll pays.
 */
export const MARISOL_LEGACY = punch('pk-legacy', 'e-marisol', '16:55', '23:59', {
  break_minutes: 25,
  confirmed_at: CONFIRMED_AT,
  approved_minutes: 1421,
});

/** Nobody is scheduled in this review — the tiles are about worked time, not the plan. */
export const PREVIEW_SCHEDULED: never[] = [];
