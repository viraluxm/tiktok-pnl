import type { AttendanceEvent } from '@/types';

// Drop counting — DERIVED at read time from the append-only attendance_events (no stored ledger).
// Per employee per pay period:
//   releases = # 'released' events NOT excused
//   claims   = # 'claimed' events
//   drops    = max(0, releases − claims)
//
// Exchange netting (release + you picked something up in the SAME period → net zero, no write-up)
// is the max(0, releases − claims). An excused release (manager-set, doctor's note) is removed
// from `releases` entirely — recorded as a separate 'excused' event keyed to the same
// (template_id, shift_date) as the release it forgives (append-only; we never mutate the release).
export const DROP_CAP = 2;

export interface DropSummary {
  releases: number;
  claims: number;
  excused: number;
  drops: number;
}

export function computeDrops(events: Pick<AttendanceEvent, 'event_type' | 'shift_date'>[]): DropSummary {
  // Events here are already scoped to one employee, so shift_date alone keys an excused event to
  // the release it forgives (one shift per person per day — migration 086).
  const key = (e: { shift_date: string }) => e.shift_date;
  const excusedKeys = new Set(events.filter((e) => e.event_type === 'excused').map(key));
  const releasedEvents = events.filter((e) => e.event_type === 'released');
  const effectiveReleases = releasedEvents.filter((e) => !excusedKeys.has(key(e)));
  const releases = effectiveReleases.length;
  const claims = events.filter((e) => e.event_type === 'claimed').length;
  return {
    releases,
    claims,
    excused: releasedEvents.length - releases,
    drops: Math.max(0, releases - claims),
  };
}
