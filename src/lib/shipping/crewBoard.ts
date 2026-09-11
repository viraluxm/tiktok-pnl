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
// The work model: what a box actually costs
// ─────────────────────────────────────────────────────────────────────────────
//
// Boxes alone and items alone are BOTH unfair, because a box is not a fixed unit of work.
// Measured over 8,677 completed boxes (2026-09-02 -> 09-09), using the gap between consecutive
// completions by the same picker — the one timing signal that is trustworthy here, since
// verified_at -> verified_at telescopes correctly and never touches the broken pick_started_at:
//
//     items in box:  1    2    3    4    5    6    7    8    9
//     seconds:      64   84   99  116  133  152  158  184  217
//
// A weighted least-squares fit (weighted by boxes observed) gives:
//
//     seconds ≈ 47.5 per BOX + 17.3 per ITEM
//
// Both halves are real: there is genuine fixed overhead per package (fetch, scan, seal, set
// aside) AND genuine per-item work. A 1-item box costs ~65s; a 9-item box ~203s.
//
// Why not items only: on 2026-09-09 Alex did 1,064 items in 174 boxes and Chris 670 in 206.
// Measured work was 444 vs 356 minutes — a ratio of 1.25. The weighted score reproduces that
// (257 vs 206 = 1.25); items-only says 1.59, overstating heavy bundling by ~27%; boxes-only says
// 0.84, ranking the hardest worker on the floor third.
export const SECONDS_PER_BOX = 47.5;
export const SECONDS_PER_ITEM = 17.3;

// Items in a typical box, used to express the weighted score back in BOX units so an existing
// per-shift box target still means what it meant. A picker with an average mix scores about
// their raw box count (Chris: 206 boxes -> 206 weighted), so a 200 target transfers unchanged.
export const TYPICAL_ITEMS_PER_BOX = 3.25;
export const SECONDS_PER_TYPICAL_BOX = SECONDS_PER_BOX + SECONDS_PER_ITEM * TYPICAL_ITEMS_PER_BOX;

// Expected seconds of work for `boxes` packages containing `items` lines in total.
export function workSeconds(boxes: number, items: number): number {
  return SECONDS_PER_BOX * boxes + SECONDS_PER_ITEM * items;
}

// The same work expressed in typical-box equivalents — the number the target is compared against.
export function weightedBoxes(boxes: number, items: number): number {
  return workSeconds(boxes, items) / SECONDS_PER_TYPICAL_BOX;
}

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
  items: number;                       // order LINES in this box (>=1); drives the weighted score
  /**
   * Credited by scanning a finished singles batch rather than a pack confirm
   * (shipment_verifications.source = 'singles_batch').
   *
   * Kept OUT of boxes / items / weighted entirely. The work model (~47.5s per box + ~17.3s per
   * item) was fitted on rack picking; the singles station is batch assembly from one carton and
   * is far faster per package. 500 singles x 65s would be 9 hours — longer than the shift — so
   * folding them in would over-credit roughly 2-3x. They get their own count until there is
   * enough scan data to measure seconds-per-single honestly.
   */
  isSingles?: boolean;
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
  items: number;                       // order lines across this picker's boxes (excludes singles)
  weighted: number;                    // typical-box equivalents — what the target is measured on
  singles: number;                     // singles credited by batch scan; NOT in boxes/items/weighted
  clocked_ms: number | null;           // null when the person has no punch (picked off the clock)
  on_clock: boolean;                   // still punched in right now
  hours: HourBucket[];                 // one entry per elapsed hour of the crew window
}

export interface CrewBoard {
  day: string;
  crew: Crew;
  hourStartsMs: number[];              // the shared hour axis every row is bucketed onto
  hourLabels: number[];                // local hour for each axis entry
  picking: CrewPickerRow[];            // >= 1 picked box — measured against the target
  /**
   * Credited ONLY singles today. Their own group, with NO target.
   *
   * They cannot be measured against a box target: the target is in weighted boxes and singles are
   * deliberately never weighted, so a singles packer scored against it reads 0 / 200 (-200) — the
   * worst row on the board, for a full shift of real work. And there is no honest singles target
   * to substitute yet, because nothing measured seconds-per-single until the station was
   * instrumented. So they are listed, counted, and left ungraded until there is data.
   */
  singlesPackers: CrewPickerRow[];
  noPicks: CrewPickerRow[];            // clocked in, nothing credited — listed, never judged
  totalBoxes: number;
  totalItems: number;
  totalWeighted: number;
  totalSingles: number;
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

  interface Acc { id: string | null; snapshot: string | null; boxes: number; items: number; singles: number; hours: number[] }
  const accs = new Map<string, Acc>();
  const blankHours = (): number[] => new Array(hourStartsMs.length).fill(0);

  const accFor = (id: string | null, snap: string | null): Acc => {
    const key = id ? `id:${id}` : `name:${snap ?? ''}`;
    let a = accs.get(key);
    if (!a) { a = { id, snapshot: snap, boxes: 0, items: 0, singles: 0, hours: blankHours() }; accs.set(key, a); }
    return a;
  };

  let totalBoxes = 0;
  let totalItems = 0;
  let totalSingles = 0;
  for (const b of byBox.values()) {
    const id = b.picker_employee_id ?? null;
    const snap = (b.picker_name_snapshot ?? '').trim() || null;
    if (!id && !snap) continue;          // untracked history — not a person, not on a manager board
    const a = accFor(id, snap);

    // Singles are counted, shown, and deliberately kept out of the weighted score.
    if (b.isSingles) {
      a.singles += 1;
      totalSingles += 1;
      // Still bucketed into the hour so the pace bars show when the pile was finished. A batch
      // scan lands all of its boxes on ONE instant, so a finished pile appears as a single tall
      // bar rather than a spread — which is the truth: that is when it was credited.
      const t = Date.parse(b.verified_at);
      if (Number.isFinite(t)) {
        const i = Math.floor((t - windowStartMs) / HOUR);
        if (i >= 0 && i < a.hours.length) a.hours[i] += 1;
      }
      continue;
    }

    const items = Number.isFinite(b.items) && b.items > 0 ? b.items : 1; // never let a bad count zero a box
    a.boxes += 1;
    a.items += items;
    totalBoxes += 1;
    totalItems += items;
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
      items: a.items,
      weighted: weightedBoxes(a.boxes, a.items),
      singles: a.singles,
      clocked_ms: punch ? punch.ms : null,
      on_clock: punch?.open ?? false,
      hours: a.hours.map((boxes, i) => ({
        hourStartMs: hourStartsMs[i], labelHour: hourLabels[i], boxes, inProgress: i === nowHourIdx,
      })),
    };
  };

  // Ranked by WEIGHTED work, not raw boxes — on 2026-09-09 that is the difference between Alex
  // (174 boxes, 1,064 items) ranking third and ranking first, which is what the clock says.
  const worked = [...accs.values()].map(toRow);

  // Split on WHAT THE PERSON DID, not on how much. Someone who picked boxes is measured against
  // the target; someone who only ran singles is not, because the target is in units their work
  // does not produce. Anyone who did both stays with the pickers and carries their singles along.
  const picking = worked
    .filter((r) => r.boxes > 0)
    .sort((x, y) => y.weighted - x.weighted || y.singles - x.singles || x.name.localeCompare(y.name));
  const singlesPackers = worked
    .filter((r) => r.boxes === 0 && r.singles > 0)
    .sort((x, y) => y.singles - x.singles || x.name.localeCompare(y.name));

  // Clocked in, zero boxes. Listed with hours only — NO target, NO shortfall. Nothing in the data
  // distinguishes assigned non-picking work (boxing, restocking, set-aside) from idleness:
  // scan_log carries no employee column, and pick_slots/pick_racks carry no employee stamp. The
  // board must not imply a judgement it has no evidence for; the manager knows the assignment.
  const pickedIds = new Set(worked.map((r) => r.employee_id).filter(Boolean) as string[]);
  const noPicks: CrewPickerRow[] = [...punchByEmp.entries()]
    .filter(([id]) => !pickedIds.has(id))
    .map(([id, p]) => ({
      employee_id: id,
      name: nameById[id] || p.name,
      boxes: 0,
      items: 0,
      weighted: 0,
      singles: 0,
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
  const totalWeighted = weightedBoxes(totalBoxes, totalItems);
  // Availability is compared in the SAME units as the target, so a bundle-heavy shift is not
  // reported as "not enough work" when the work was there, just packed into fewer boxes.
  const availablePerPicker = pickingCount > 0 ? totalWeighted / pickingCount : null;
  const targetReachable = targetBoxes == null || availablePerPicker == null
    ? null
    : availablePerPicker >= targetBoxes;

  return {
    day, crew, hourStartsMs, hourLabels, picking, singlesPackers, noPicks,
    totalBoxes, totalItems, totalWeighted,
    totalSingles, pickingCount, availablePerPicker, targetBoxes, targetReachable,
    hitTarget: targetBoxes == null ? 0 : picking.filter((r) => r.weighted >= targetBoxes).length,
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
