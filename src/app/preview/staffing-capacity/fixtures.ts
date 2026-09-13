// Manager-side staffing fixtures for /preview/staffing-capacity. PURE DATA + PURE LOGIC — the
// numbers are produced by the REAL kernel (src/lib/schedule/capacity.ts), so what the reviewer
// approves here is the same arithmetic production runs.
//
// The scenarios are the ones the feature has to get right, at the scale the business actually runs
// (ten Live Host setups) rather than the small preview-portal cast:
//
//   Wed morning   4 / 10 scheduled   6 shifts available
//   Wed night     8 / 10 scheduled   2 shifts available
//   Thu night    10 / 10 scheduled   Fully staffed
//   Fri night     6 /  7 scheduled   1 shift available   (custom capacity — override 7)
//   Sat night    11 / 10 scheduled   Over capacity by 1  (capacity was reduced under staffing)
//   Sun night     3 / 10 scheduled   Availability closed
import { addDaysISO, laTodayISO, laWallTimeToUtc, weekdayOf } from '@/lib/schedule/timezone';
import {
  DEFAULT_TEAM_CAPACITY, blockInstants, staffingOutlook,
  type CapacityBlock, type CapacitySetting, type StaffingOutlookPayload, type StaffedInstance,
} from '@/lib/schedule/capacity';

const OWNER = 'preview-owner';
const DAYS = 14;

/** The next date on/after today whose weekday is `dow` (0=Sun…6=Sat), so the demo never sits in the past. */
function nextDow(fromISO: string, dow: number): string {
  for (let i = 0; i < 14; i++) {
    const d = addDaysISO(fromISO, i);
    if (weekdayOf(d) === dow) return d;
  }
  return fromISO;
}

export const NIGHT: CapacityBlock = {
  id: 'blk-night', user_id: OWNER, team: 'host', label: 'Night',
  days_of_week: [0, 1, 2, 3, 4, 5, 6], start_time: '18:00', end_time: '02:00', capacity: null, active: true,
};
export const MORNING: CapacityBlock = {
  id: 'blk-morning', user_id: OWNER, team: 'host', label: 'Morning',
  days_of_week: [1, 2, 3, 4, 5], start_time: '06:00', end_time: '14:00', capacity: null, active: true,
};

export interface PreviewWorld {
  blocks: CapacityBlock[];
  settings: CapacitySetting[];
  instances: StaffedInstance[];
  roles: Record<string, 'host' | 'fulfillment' | 'other'>;
}

export function initialWorld(todayISO = laTodayISO()): PreviewWorld {
  const wed = nextDow(todayISO, 3);
  const thu = nextDow(todayISO, 4);
  const fri = nextDow(todayISO, 5);
  const sat = nextDow(todayISO, 6);
  const sun = nextDow(todayISO, 0);

  const instances: StaffedInstance[] = [];
  const roles: Record<string, 'host' | 'fulfillment' | 'other'> = {};
  let n = 0;
  /** `count` hosts on `date`, LA wall clock; end<=start rolls to the next day. */
  const staff = (date: string, start: string, end: string, count: number, extra: Partial<StaffedInstance> = {}) => {
    for (let i = 0; i < count; i++) {
      const id = `h${++n}`;
      roles[id] = 'host';
      const endDate = Number(end.slice(0, 2)) * 60 + Number(end.slice(3)) <= Number(start.slice(0, 2)) * 60 + Number(start.slice(3))
        ? addDaysISO(date, 1) : date;
      instances.push({
        id: `si-${n}`, employee_id: id, status: 'scheduled',
        starts_at: laWallTimeToUtc(date, start).toISOString(),
        ends_at: laWallTimeToUtc(endDate, end).toISOString(),
        ...extra,
      });
    }
  };

  staff(wed, '06:00', '14:00', 4);                       // morning: 4 / 10 → 6 available
  staff(wed, '18:00', '02:00', 6);                       // night: 6 exact-match…
  staff(wed, '17:00', '01:00', 1);                       // …plus one that only OVERLAPS…
  staff(wed, '19:00', '00:00', 1, { status: 'claimed' }); // …and one picked-up shift → 8 total
  staff(thu, '18:00', '02:00', 9);
  // The tenth Thursday host has DROPPED his shift. He is still responsible for it, so the block
  // stays 10/10 — the case where a naive implementation would advertise an eleventh spot.
  staff(thu, '18:00', '02:00', 1, { status: 'scheduled' });
  staff(fri, '18:00', '02:00', 6);                       // against the custom capacity of 7
  staff(sat, '18:00', '02:00', 11);                      // over the reduced capacity of 10
  staff(sun, '18:00', '02:00', 3);                       // plenty of room, but closed

  return {
    blocks: [MORNING, NIGHT],
    settings: [
      { id: 'team-host', team: 'host', block_id: null, date: null, capacity: 10, closed: false, note: null },
      { id: 'ovr-fri', team: 'host', block_id: NIGHT.id, date: fri, capacity: 7, closed: false, note: null },
      { id: 'ovr-sun', team: 'host', block_id: NIGHT.id, date: sun, capacity: null, closed: true, note: null },
    ],
    instances,
    roles,
  };
}

/** The exact payload /api/admin/schedule/capacity returns, computed by the real kernel. */
export function payloadFor(w: PreviewWorld, todayISO = laTodayISO()): StaffingOutlookPayload {
  const to = addDaysISO(todayISO, DAYS);
  const outlook = staffingOutlook({
    blocks: w.blocks, fromISO: todayISO, toISO: to,
    instances: w.instances, teamOf: (id) => w.roles[id] ?? 'other', settings: w.settings,
  });
  const byDate = new Map<string, typeof outlook>();
  for (const s of outlook) {
    const list = byDate.get(s.date);
    if (list) list.push(s); else byDate.set(s.date, [s]);
  }
  const days: StaffingOutlookPayload['days'] = [];
  for (let d = todayISO; d <= to; d = addDaysISO(d, 1)) days.push({ date: d, blocks: byDate.get(d) ?? [] });
  return {
    from: todayISO, to, blocks: w.blocks, settings: w.settings, days,
    teamDefaults: (['host', 'fulfillment'] as const).map((team) => {
      const row = w.settings.find((s) => s.block_id == null && s.team === team) ?? null;
      return { team, capacity: row?.capacity ?? DEFAULT_TEAM_CAPACITY[team], closed: Boolean(row?.closed), isDefault: row?.capacity == null };
    }),
  };
}

export type Mutate =
  | { op: 'saveBlock'; block: Record<string, unknown> }
  | { op: 'blockActive'; blockId: string; active: boolean }
  | { op: 'teamCapacity'; team: string; capacity: number | null }
  | { op: 'dateCapacity'; blockId: string; date: string; capacity?: number | null; closed?: boolean };

/** Apply a manager edit to the in-memory world. Pure; no network, no database. */
export function applyMutation(w: PreviewWorld, m: Mutate): PreviewWorld {
  if (m.op === 'teamCapacity') {
    const rest = w.settings.filter((s) => !(s.block_id == null && s.team === m.team));
    return {
      ...w,
      settings: m.capacity == null ? rest
        : [...rest, { id: `team-${m.team}`, team: m.team as 'host' | 'fulfillment', block_id: null, date: null, capacity: m.capacity, closed: false, note: null }],
    };
  }
  if (m.op === 'dateCapacity') {
    const rest = w.settings.filter((s) => !(s.block_id === m.blockId && s.date === m.date));
    const team = w.blocks.find((b) => b.id === m.blockId)?.team ?? 'host';
    const clearing = (m.capacity == null) && !m.closed;
    return {
      ...w,
      settings: clearing ? rest
        : [...rest, { id: `ovr-${m.blockId}-${m.date}`, team, block_id: m.blockId, date: m.date, capacity: m.capacity ?? null, closed: Boolean(m.closed), note: null }],
    };
  }
  if (m.op === 'blockActive') {
    return { ...w, blocks: w.blocks.map((b) => (b.id === m.blockId ? { ...b, active: m.active } : b)) };
  }
  const id = (m.block.id as string) || `blk-${w.blocks.length + 1}`;
  const row: CapacityBlock = {
    id, user_id: OWNER, team: m.block.team as 'host' | 'fulfillment', label: (m.block.label as string) || null,
    days_of_week: (m.block.days_of_week as number[]) ?? [], start_time: m.block.start_time as string,
    end_time: m.block.end_time as string, capacity: m.block.capacity == null ? null : Number(m.block.capacity),
    active: m.block.active !== false,
  };
  return { ...w, blocks: w.blocks.some((b) => b.id === id) ? w.blocks.map((b) => (b.id === id ? row : b)) : [...w.blocks, row] };
}

export { blockInstants };
