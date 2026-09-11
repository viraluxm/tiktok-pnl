import { laWallTimeToUtc } from '@/lib/schedule/timezone';

// FIXTURES FOR THE SHIFTS-CALENDAR REVIEW ROUTE. Plain objects in the shape buildCalendarDays
// takes — no query, no client, nothing that can reach a database.
//
// The day under review is a Tuesday on which Juan clocked TWO separate sessions. That is the case
// calendarModel used to collapse: pickPunch() returned one punch per person-day, so the afternoon
// session never reached the day modal or the confirm queue, and an unconfirmed time-clock row is
// not payable. Alongside him are a one-shift day and a scheduled-but-unworked person, so the
// review can confirm the ordinary cases still look exactly as they did.

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
  { id: 'e-haley', name: 'Haley Nguyen', role: 'host' },
  { id: 'e-marcus', name: 'Marcus Bell', role: 'fulfillment' },
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

/** Juan's morning session — 6:00 AM to 10:00 AM, awaiting confirmation. */
export const JUAN_MORNING = punch('pk-am', 'e-juan', '06:00', '10:00');

/** Juan's afternoon session — 2:00 PM to 6:00 PM, awaiting confirmation. */
export const JUAN_AFTERNOON = punch('pk-pm', 'e-juan', '14:00', '18:00');

/** The same afternoon session, still running: no clock-out yet. */
export const JUAN_AFTERNOON_OPEN = punch('pk-pm', 'e-juan', '14:00', null, { clock_out_at: null });

/** An ordinary single-shift day, for comparison — must look exactly as it always did. */
export const HALEY_SINGLE = punch('pk-haley', 'e-haley', '16:00', '22:00');

/** Scheduled and never clocked in. Stays one entry with no punch. */
export const PREVIEW_SCHEDULED = [
  {
    id: 'si-juan',
    employee_id: 'e-juan',
    date: PREVIEW_DATE,
    start_time: '06:00',
    end_time: '14:00',
    origin: 'instance' as const,
    source: 'admin_open',
  },
  {
    id: 'si-marcus',
    employee_id: 'e-marcus',
    date: PREVIEW_DATE,
    start_time: '09:00',
    end_time: '17:00',
    origin: 'instance' as const,
    source: 'admin_open',
  },
];
