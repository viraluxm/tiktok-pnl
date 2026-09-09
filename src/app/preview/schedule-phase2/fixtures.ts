// Fixture data for /preview/schedule-phase2. PURE DATA — no imports that can reach a database.
//
// Cast as Carlos (Fulfillment) viewing his own schedule; Juan (Fulfillment) is the coworker who
// picks shifts up, Adriana (Host) is there so the Team Schedule shows role grouping and a shift
// nobody in Carlos's role could take.

import type { AvailableShift } from '@/lib/schedule/offerPlan';
import type { TeamScheduleWeek } from '@/lib/schedule/teamSchedule';

export interface DemoShift {
  id: string;
  starts_at: string;
  ends_at: string;
  offer_state: 'offered' | 'transferred' | null;
  offer_id: string | null;
  /** set when an approval moved it, so My Schedule can say who has it now */
  assigned_to?: string | null;
}
export interface DemoRequest {
  claim_id: string; shift_instance_id: string; offer_id: string;
  shift_date: string; starts_at: string; ends_at: string;
  offered_by_name: string; requester_name: string;
}
export interface DemoState {
  todayISO: string;
  mine: DemoShift[];
  available: AvailableShift[];
  myPickupIds: string[];
  requests: DemoRequest[];
  transferred: DemoRequest[];
  declined: string[];
  week: TeamScheduleWeek;
  log: string[];
}

// Dates are generated relative to today so the preview never goes stale, and pinned to LA (-07:00)
// so the rendered times match what the real page would show.
function d(offset: number): string {
  const x = new Date();
  x.setDate(x.getDate() + offset);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
}
const at = (offset: number, hour: number) => new Date(`${d(offset)}T${String(hour).padStart(2, '0')}:00:00-07:00`).toISOString();

const MON = d(2), TUE = d(3), WED = d(4);

export const INITIAL: DemoState = {
  todayISO: d(0),
  // Carlos's own shifts — one plain, one overnight, so Drop Shift is reviewable on both.
  mine: [
    { id: 'i1', starts_at: at(2, 6),  ends_at: at(2, 14), offer_state: null, offer_id: null },
    { id: 'i2', starts_at: at(3, 16), ends_at: at(4, 2),  offer_state: null, offer_id: null },
  ],
  // Two shifts already on the board from other people: one Juan-eligible, one refused so the
  // disabled label and its wrapping can be reviewed.
  available: [
    {
      id: 'a1', offer_id: 'offer-a1', shift_date: MON,
      starts_at: at(2, 6), ends_at: at(2, 14),
      role: 'fulfillment', offered_by_name: 'Adriana', refusal: null,
    },
    {
      id: 'a2', offer_id: 'offer-a2', shift_date: WED,
      starts_at: at(4, 16), ends_at: at(5, 2),
      role: 'host', offered_by_name: 'Adriana', refusal: 'ALREADY_SCHEDULED_THAT_DAY',
    },
  ],
  myPickupIds: [],
  requests: [],
  transferred: [],
  declined: [],
  week: {
    start: MON,
    end: d(8),
    days: [
      { date: MON, shifts: [
        { instance_id: 'i1', employee_id: 'carlos', name: 'Carlos', role: 'fulfillment', starts_at: at(2, 6),  ends_at: at(2, 14), offered: false, is_me: true },
        { instance_id: 'a1', employee_id: 'adriana', name: 'Adriana', role: 'host',       starts_at: at(2, 10), ends_at: at(2, 18), offered: true,  is_me: false },
      ] },
      { date: TUE, shifts: [
        { instance_id: 'i2', employee_id: 'carlos', name: 'Carlos', role: 'fulfillment', starts_at: at(3, 16), ends_at: at(4, 2),  offered: false, is_me: true },
        { instance_id: 'j1', employee_id: 'juan',   name: 'Juan',   role: 'fulfillment', starts_at: at(3, 6),  ends_at: at(3, 14), offered: false, is_me: false },
      ] },
      { date: WED, shifts: [
        { instance_id: 'a2', employee_id: 'adriana', name: 'Adriana', role: 'host', starts_at: at(4, 16), ends_at: at(5, 2), offered: true, is_me: false },
      ] },
      { date: d(5), shifts: [] },
      { date: d(6), shifts: [] },
      { date: d(7), shifts: [] },
      { date: d(8), shifts: [] },
    ],
  },
  log: [],
};
