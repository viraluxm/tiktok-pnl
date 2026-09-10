/**
 * Manager crew board — pure, dependency-free logic for /s/[token]/pickers.
 *
 * SELF-CONTAINED ON PURPOSE. This file imports NOTHING — not from '@/…', not from npm, and
 * deliberately not from ./pickerPerformance either, even though that module owns the same
 * timezone technique. Two reasons:
 *   1. The repo's transpile-at-runtime .test.mjs pattern wants a standalone module.
 *   2. The 04:00 fulfillment-day boundary (SHIFT_DAY_START_HOUR) exists ONLY on the unmerged
 *      fix/dashboard-cogs branch — `main`'s pickerPerformance.ts still keys days on midnight via
 *      toLocaleDateString, which splits every night shift in half. Importing it would couple this
 *      board to that branch and conflict with in-flight work there.
 * ➜ WHEN fix/dashboard-cogs MERGES: SHIFT_DAY_START_HOUR / tzOffsetMs / the zoned-hour helper are
 *   duplicated between the two files and should be unified into pickerPerformance.ts with this
 *   module importing them. Until then the duplication is deliberate, not an oversight.
 *
 * WHAT THIS DELIBERATELY DOES NOT USE: pick_started_at, and therefore avg_pick_ms /
 * active_pick_ms / orders_per_active_hour. That column is stamped near CONFIRM time, not at pick
 * start, so durations derived from it measure the confirm scan and have reported a picker at 297
 * boxes/hour. Everything here is built on verified_at (a real completion instant) and
 * clock_in_at/clock_out_at (real punches).
 *
 * COUNTING UNIT IS THE BOX, not the TikTok order. One box = one label = one thing a picker
 * completes; a box averages ~2.66 TikTok order lines. The target is in boxes.
 */

// The shop/business timezone. Matches SHOP_TIMEZONE in pickerPerformance.ts and the tiktok
// finance/sync routes — a server-fixed constant, never a DB column (see CLAUDE.md).
export const SHOP_TIMEZONE = 'America/Los_Angeles';

// The local hour at which one fulfillment day ends and the next begins. NOT midnight: the night
// crew works ~17:00-01:00, so a midnight boundary cuts every night shift in half and reports the
// tail of one shift alongside the head of the next. 04:00 sits in the measured 01:00-05:00 dead
// zone (<0.05% of box completions) and clears the Pacific DST transition at 02:00-03:00, so
// local 04:00 exists on every calendar day of the year.
export const SHIFT_DAY_START_HOUR = 4;

// The local hour that splits one fulfillment day into its two crews.
//
// Measured over 30 days of box completions the crews are sharply bimodal: 06:00-13:59 carries
// ~19,200 boxes (day crew), 17:00-01:00 carries ~10,600 (night crew), and 14:00-16:59 carries
// 218 (0.7%) — a genuine dead zone, the same kind of gap SHIFT_DAY_START_HOUR sits in. 15:00
// splits there, so neither crew is ever cut in half.
//
// AM = [04:00, 15:00)   PM = [15:00, 04:00 next day) — both INSIDE one fulfillment day, so the
// night crew's 17:00-01:00 stays whole and on one day key.
export const CREW_SPLIT_HOUR = 15;

export type Crew = 'am' | 'pm';

// ─────────────────────────────────────────────────────────────────────────────
// Timezone / calendar helpers
// ─────────────────────────────────────────────────────────────────────────────

// Offset (localMs - utcMs), in ms, that `tz` had at instant `utcMs`.
export function tzOffsetMs(utcMs: number, tz: string = SHOP_TIMEZONE): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = dtf.formatToParts(new Date(utcMs));
  const g = (t: string): number => Number(parts.find((p) => p.type === t)?.value);
  const asUTC = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second'));
  return asUTC - utcMs;
}

// The UTC instant (ms) at local `hour` on `dayISO` in `tz`. Two-pass to stay correct across the
// DST edges: the first pass picks an offset, the second re-reads it at the resulting instant.
export function zonedHourUtcMs(dayISO: string, hour: number, tz: string = SHOP_TIMEZONE): number {
  const [y, m, d] = dayISO.split('-').map(Number);
  const naive = Date.UTC(y, m - 1, d, hour, 0, 0);
  const off1 = tzOffsetMs(naive, tz);
  let start = naive - off1;
  const off2 = tzOffsetMs(start, tz);
  if (off2 !== off1) start = naive - off2;
  return start;
}

// Add whole calendar days to an ISO day string, DST-independent (date-only math).
export function addDaysISO(dayISO: string, delta: number): string {
  const [y, m, d] = dayISO.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return dt.toISOString().slice(0, 10);
}

// The fulfillment-day key ('YYYY-MM-DD') an instant belongs to. An instant before local
// SHIFT_DAY_START_HOUR belongs to the PREVIOUS calendar day, so a night shift crossing midnight
// stays on one key. Reads the shifted wall-clock via UTC accessors (NOT toLocaleDateString).
export function fulfillmentDayKey(utcMs: number, tz: string = SHOP_TIMEZONE): string {
  const localMs = utcMs + tzOffsetMs(utcMs, tz);
  const shifted = new Date(localMs - SHIFT_DAY_START_HOUR * 3_600_000);
  const p2 = (n: number): string => String(n).padStart(2, '0');
  return `${shifted.getUTCFullYear()}-${p2(shifted.getUTCMonth() + 1)}-${p2(shifted.getUTCDate())}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Crew windows
// ─────────────────────────────────────────────────────────────────────────────

// Which crew an instant belongs to. Uses the same shifted wall-clock as fulfillmentDayKey, so an
// instant at 01:00 (night crew, still on the previous fulfillment day) resolves to 'pm'.
export function crewOf(utcMs: number, tz: string = SHOP_TIMEZONE): Crew {
  const localMs = utcMs + tzOffsetMs(utcMs, tz);
  const hour = new Date(localMs).getUTCHours();
  return hour >= CREW_SPLIT_HOUR || hour < SHIFT_DAY_START_HOUR ? 'pm' : 'am';
}

// [startMs, endMs) UTC bounds of ONE crew's window on the given fulfillment day.
//   am -> local 04:00 up to 15:00 the same calendar day
//   pm -> local 15:00 up to 04:00 the NEXT calendar day (so 17:00-01:00 is one contiguous range)
// The two windows are adjacent and together tile the whole fulfillment day with no gap/overlap.
export function crewRangeUtcMs(
  dayISO: string, crew: Crew, tz: string = SHOP_TIMEZONE,
): { startMs: number; endMs: number } {
  if (crew === 'am') {
    return {
      startMs: zonedHourUtcMs(dayISO, SHIFT_DAY_START_HOUR, tz),
      endMs: zonedHourUtcMs(dayISO, CREW_SPLIT_HOUR, tz),
    };
  }
  return {
    startMs: zonedHourUtcMs(dayISO, CREW_SPLIT_HOUR, tz),
    endMs: zonedHourUtcMs(addDaysISO(dayISO, 1), SHIFT_DAY_START_HOUR, tz),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Board aggregation
// ─────────────────────────────────────────────────────────────────────────────

// One completed box, already scoped to the account, the day and the crew window by the caller.
export interface CrewBoxEvent {
  group_key: string;                   // box identity — de-duped here as well as in the DB
  picker_employee_id: string | null;
  picker_name_snapshot: string | null;
  verified_at: string;                 // ISO instant of successful completion
}

// One time-clock punch for a fulfillment employee on the board's day.
export interface CrewPunch {
  employee_id: string;
  name: string;
  clock_in_at: string;                 // ISO
  clock_out_at: string | null;         // null = still on the clock
}

export interface HourBucket {
  hourStartMs: number;   // UTC instant the hour begins
  labelHour: number;     // local hour 0-23, for display ('6a', '1p')
  boxes: number;
  inProgress: boolean;   // the hour containing `nowMs` — ALWAYS partial, must not read as a slump
}

export interface CrewPickerRow {
  employee_id: string | null;
  name: string;
  boxes: number;
  clocked_ms: number | null;           // null when the person has no punch (picked off the clock)
  on_clock: boolean;                   // still punched in right now
  hours: HourBucket[];                 // one entry per elapsed hour of the crew window
}

export interface CrewBoard {
  day: string;
  crew: Crew;
  hourStartsMs: number[];              // the shared hour axis every row is bucketed onto
  hourLabels: number[];                // local hour for each axis entry
  picking: CrewPickerRow[];            // >= 1 box — measured against the target
  noPicks: CrewPickerRow[];            // clocked in, ZERO boxes — listed, never judged
  totalBoxes: number;
  pickingCount: number;                // denominator for available-per-picker
  availablePerPicker: number | null;   // totalBoxes / pickingCount; null when nobody picked
  targetBoxes: number | null;
  targetReachable: boolean | null;     // false when there was not enough work for everyone
  hitTarget: number;                   // pickers at/over target (0 when no target set)
}

// Supplied by the caller so this module needs no timezone import at the call site.
export type OffsetFn = (utcMs: number) => number;

/**
 * Build the shared hour axis: one bucket per hour from the crew window's start up to the hour
 * containing `nowMs` (or the window end, whichever is earlier).
 *
 * Only ELAPSED hours appear. A morning board at 08:30 shows 04a-08a, not eleven columns of which
 * seven are structurally empty — an empty future hour is not a performance signal.
 */
export function buildHourAxis(
  startMs: number, endMs: number, nowMs: number, offsetAt: OffsetFn,
): { hourStartsMs: number[]; hourLabels: number[] } {
  const hourStartsMs: number[] = [];
  const hourLabels: number[] = [];
  const cap = Math.min(nowMs, endMs - 1);
  const HOUR = 3_600_000;
  for (let t = startMs; t <= cap && t < endMs; t += HOUR) {
    hourStartsMs.push(t);
    hourLabels.push(new Date(t + offsetAt(t)).getUTCHours());
  }
  return { hourStartsMs, hourLabels };
}

/**
 * Aggregate one crew's day into the board.
 *
 * `punches` carries EVERY clocked-in fulfillment employee for the crew, including those with no
 * boxes — that roster is the only reason a non-picking person appears at all. A picker with boxes
 * but NO punch still appears (8.5% of boxes are picked off the clock, and one picker works almost
 * entirely that way); their clocked_ms is null and no rate is claimed for them.
 */
export function aggregateCrewBoard(
  events: CrewBoxEvent[],
  punches: CrewPunch[],
  day: string,
  crew: Crew,
  windowStartMs: number,
  windowEndMs: number,
  nowMs: number,
  offsetAt: OffsetFn,
  nameById: Record<string, string> = {},
  targetBoxes: number | null = null,
): CrewBoard {
  const { hourStartsMs, hourLabels } = buildHourAxis(windowStartMs, windowEndMs, nowMs, offsetAt);
  const HOUR = 3_600_000;
  const nowHourIdx = hourStartsMs.findIndex((h) => nowMs >= h && nowMs < h + HOUR);

  // De-dupe by group_key, exactly as aggregateFulfillmentDay does.
  const byBox = new Map<string, CrewBoxEvent>();
  for (const e of events) if (!byBox.has(e.group_key)) byBox.set(e.group_key, e);

  interface Acc { id: string | null; snapshot: string | null; boxes: number; hours: number[] }
  const accs = new Map<string, Acc>();
  const blankHours = (): number[] => new Array(hourStartsMs.length).fill(0);

  const accFor = (id: string | null, snap: string | null): Acc => {
    const key = id ? `id:${id}` : `name:${snap ?? ''}`;
    let a = accs.get(key);
    if (!a) { a = { id, snapshot: snap, boxes: 0, hours: blankHours() }; accs.set(key, a); }
    return a;
  };

  let totalBoxes = 0;
  for (const b of byBox.values()) {
    const id = b.picker_employee_id ?? null;
    const snap = (b.picker_name_snapshot ?? '').trim() || null;
    if (!id && !snap) continue;          // untracked history — not a person, not on a manager board
    const a = accFor(id, snap);
    a.boxes += 1;
    totalBoxes += 1;
    const ms = Date.parse(b.verified_at);
    if (Number.isFinite(ms)) {
      const idx = Math.floor((ms - windowStartMs) / HOUR);
      if (idx >= 0 && idx < a.hours.length) a.hours[idx] += 1;
    }
  }

  // Punch lookup. Several punches for one person in a window are summed, and the board reports
  // whether ANY of them is still open.
  //
  // EVERY PUNCH IS CLAMPED TO THE CREW WINDOW. Two real cases require this:
  //   • DOUBLES — people work a morning shift AND come back for the night (16 occurrences in the
  //     21 days to 2026-09-09; Alejandro seven times, up to 16.4h). Their two punches are filed
  //     under one calendar date, so both reach both boards; each board must count only its own.
  //   • STRADDLING PUNCHES — a morning punch that runs past 15:00 (Alejandro and Mario both
  //     clocked 06:00 -> 16:05 on 2026-08-29). Unclamped, that single 10h punch would be counted
  //     in full on the morning board AND again on the night board.
  // Clamping makes a person's clocked hours sum correctly across the two boards instead of
  // double-counting the overlap.
  const punchByEmp = new Map<string, { ms: number; open: boolean; name: string }>();
  for (const p of punches) {
    const inMs = Date.parse(p.clock_in_at);
    if (!Number.isFinite(inMs)) continue;
    const open = !p.clock_out_at;
    const outMs = open ? nowMs : Date.parse(p.clock_out_at as string);
    if (!Number.isFinite(outMs)) continue;

    const from = Math.max(inMs, windowStartMs);
    const to = Math.min(outMs, windowEndMs);
    const ms = Math.max(0, to - from);
    if (ms === 0) continue;                     // punch lies entirely outside this crew's window

    // "On the clock" only means something on a board whose window is still running — an open
    // punch on yesterday's board is not someone currently working.
    const openHere = open && nowMs < windowEndMs;

    const prev = punchByEmp.get(p.employee_id);
    if (prev) { prev.ms += ms; prev.open = prev.open || openHere; }
    else punchByEmp.set(p.employee_id, { ms, open: openHere, name: p.name });
  }

  const toRow = (a: Acc): CrewPickerRow => {
    const punch = a.id ? punchByEmp.get(a.id) : undefined;
    return {
      employee_id: a.id,
      name: (a.id && nameById[a.id]) || a.snapshot || punch?.name || 'Unknown picker',
      boxes: a.boxes,
      clocked_ms: punch ? punch.ms : null,
      on_clock: punch?.open ?? false,
      hours: a.hours.map((boxes, i) => ({
        hourStartMs: hourStartsMs[i], labelHour: hourLabels[i], boxes, inProgress: i === nowHourIdx,
      })),
    };
  };

  const picking = [...accs.values()].map(toRow)
    .sort((x, y) => y.boxes - x.boxes || x.name.localeCompare(y.name));

  // Clocked in, zero boxes. Listed with hours only — NO target, NO shortfall. Nothing in the data
  // distinguishes assigned non-picking work (boxing, restocking, set-aside) from idleness:
  // scan_log carries no employee column, and pick_slots/pick_racks carry no employee stamp. The
  // board must not imply a judgement it has no evidence for; the manager knows the assignment.
  const pickedIds = new Set(picking.map((r) => r.employee_id).filter(Boolean) as string[]);
  const noPicks: CrewPickerRow[] = [...punchByEmp.entries()]
    .filter(([id]) => !pickedIds.has(id))
    .map(([id, p]) => ({
      employee_id: id,
      name: nameById[id] || p.name,
      boxes: 0,
      clocked_ms: p.ms,
      on_clock: p.open,
      hours: hourStartsMs.map((h, i) => ({
        hourStartMs: h, labelHour: hourLabels[i], boxes: 0, inProgress: i === nowHourIdx,
      })),
    }))
    .sort((x, y) => x.name.localeCompare(y.name));

  // Available-per-picker. Denominator is people who ACTUALLY PICKED, not everyone clocked in — a
  // shift's boxes are shared among the pickers, and counting the boxer and the restocker in that
  // denominator would understate what each picker actually had available to them.
  //
  // This exists because a flat per-person minimum otherwise measures staffing against order volume
  // rather than effort: on 16 of the 17 morning shifts before 2026-09-08 there were not enough
  // boxes in the building for everyone on shift to reach 200.
  const pickingCount = picking.length;
  const availablePerPicker = pickingCount > 0 ? totalBoxes / pickingCount : null;
  const targetReachable = targetBoxes == null || availablePerPicker == null
    ? null
    : availablePerPicker >= targetBoxes;

  return {
    day, crew, hourStartsMs, hourLabels, picking, noPicks, totalBoxes, pickingCount,
    availablePerPicker, targetBoxes, targetReachable,
    hitTarget: targetBoxes == null ? 0 : picking.filter((r) => r.boxes >= targetBoxes).length,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Display formatting (pure)
// ─────────────────────────────────────────────────────────────────────────────

// '6a', '12p', '1p' — compact enough to sit under a bar a few pixels wide.
export function formatHourLabel(hour24: number): string {
  const suffix = hour24 < 12 ? 'a' : 'p';
  const h = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return `${h}${suffix}`;
}

// '7.9h', or '—' when the picker has no punch at all.
export function formatClocked(ms: number | null): string {
  if (ms == null) return '—';
  return `${(ms / 3_600_000).toFixed(1)}h`;
}
