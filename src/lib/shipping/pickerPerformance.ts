/**
 * Fulfillment picker performance — pure, dependency-free KPI logic (Phase 1).
 *
 * Everything here is a pure function so it can be unit-tested by the repo's
 * transpile-at-runtime .test.mjs pattern (see pickerPerformance.test.mjs). Do NOT add
 * value imports from '@/…' or npm — keep this file self-contained (type-only imports are
 * erased by the test transpiler, but there are none here on purpose).
 *
 * The ONLY input is the set of successful completed-box events (shipment_verifications rows).
 * A completed pick counts ONLY once its verification row is persisted — failed/abandoned/
 * duplicate confirmations never produce a countable event (the DB's unique (user_id,
 * group_key) collapses a duplicate confirm to one row, and we de-dupe by group_key here too).
 *
 * PRIMARY timing = true per-box duration: verified_at − pick_started_at (from loading the box
 * to successful completion). The older between-completions "session/gap" logic is retained
 * only as an internal diagnostic (sessionize/median) and is NOT surfaced as a KPI.
 */

// The shop/business timezone Lensed groups days by (matches SHOP_TIMEZONE in the tiktok
// finance/sync/coverage routes and the live-session auto-end day math). Picker days use
// this business boundary — NOT browser-local, NOT UTC.
export const SHOP_TIMEZONE = 'America/Los_Angeles';

// The local hour at which one fulfillment "day" ends and the next begins.
//
// NOT midnight. The warehouse runs two shifts — a day crew roughly 06:00–14:00 and a night
// crew roughly 17:00–01:00 — so a midnight boundary cuts every night shift in half and
// reports it as two partial days: the tail of one shift and the head of the NEXT night's
// shift land in the same bucket, which both understates night-crew shift length and
// manufactures a ~16h "gap" between the two fragments.
//
// 04:00 sits inside the genuine dead zone (measured 01:00–05:00 PT carries <0.05% of box
// completions), so no real shift straddles it. It is also safely clear of the US Pacific
// DST transition at 02:00–03:00, so local 04:00 exists on every calendar day of the year.
export const SHIFT_DAY_START_HOUR = 4;

// Maximum plausible single-box pick duration. A box whose (verified_at − pick_started_at)
// exceeds this is treated as INVALID (walked away, a re-confirm long after load, a clock
// anomaly, etc.) and excluded from Average Pick Time / Active Picking Time / Orders-per-hour.
// Configurable — one named constant so product can tune it later.
export const MAX_PICK_DURATION_MS = 30 * 60 * 1000; // 30 minutes

// Internal diagnostic only (NOT a surfaced KPI): the between-completions gap that splits a
// "session" and caps the legacy active-time estimate. Kept for diagnostics/back-compat.
export const SESSION_GAP_MS = 15 * 60 * 1000; // 15 minutes

// ─────────────────────────────────────────────────────────────────────────────
// Timezone / calendar-day helpers
// ─────────────────────────────────────────────────────────────────────────────

// Offset (localMs - utcMs), in ms, that timezone `tz` had at instant `utcMs`.
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

// The UTC instant (ms) at which the given fulfillment day STARTS in `tz` — local
// SHIFT_DAY_START_HOUR (04:00), not midnight. Two-pass to stay correct across DST.
export function zonedDayStartUtcMs(dayISO: string, tz: string = SHOP_TIMEZONE): number {
  const [y, m, d] = dayISO.split('-').map(Number);
  const naive = Date.UTC(y, m - 1, d, SHIFT_DAY_START_HOUR, 0, 0);
  const off1 = tzOffsetMs(naive, tz);
  let start = naive - off1;
  const off2 = tzOffsetMs(start, tz);
  if (off2 !== off1) start = naive - off2; // correct at the spring-forward / fall-back edge
  return start;
}

// [startMs, endMs) UTC bounds of the given fulfillment day in `tz` — local 04:00 of `dayISO`
// up to local 04:00 of the next day. Length is 23/24/25h on DST, same as a midnight day.
export function zonedDayRangeUtcMs(dayISO: string, tz: string = SHOP_TIMEZONE): { startMs: number; endMs: number } {
  return { startMs: zonedDayStartUtcMs(dayISO, tz), endMs: zonedDayStartUtcMs(addDaysISO(dayISO, 1), tz) };
}

// The fulfillment-day key ('YYYY-MM-DD') an instant belongs to in `tz`. An instant before
// local SHIFT_DAY_START_HOUR belongs to the PREVIOUS calendar day, so a night shift that
// crosses midnight stays on one key. Reads the shifted wall-clock via UTC accessors.
export function zonedDayKey(utcMs: number, tz: string = SHOP_TIMEZONE): string {
  const localMs = utcMs + tzOffsetMs(utcMs, tz);
  const shifted = new Date(localMs - SHIFT_DAY_START_HOUR * 3_600_000);
  const p2 = (n: number): string => String(n).padStart(2, '0');
  return `${shifted.getUTCFullYear()}-${p2(shifted.getUTCMonth() + 1)}-${p2(shifted.getUTCDate())}`;
}

// Add whole calendar days to an ISO day string ('YYYY-MM-DD'), DST-independent (date-only math).
export function addDaysISO(dayISO: string, delta: number): string {
  const [y, m, d] = dayISO.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return dt.toISOString().slice(0, 10);
}

// ─────────────────────────────────────────────────────────────────────────────
// Picker validation (server uses this before attributing a completed pick)
// ─────────────────────────────────────────────────────────────────────────────

export interface PickerCandidate {
  id: string;
  name: string;
  role: string;
  status: string;
}

export type PickerRejectReason = 'ok' | 'not_found' | 'role' | 'status';

export interface PickerValidation {
  valid: boolean;
  reason: PickerRejectReason;
  name: string | null;
}

/**
 * Is this employee an eligible fulfillment picker?
 *   • must exist (a foreign employee is fetched account-scoped → arrives here as null)
 *   • role must be exactly 'fulfillment' after trim + lowercase (role is free text on
 *     employees, so we normalise defensively)
 *   • status must be 'active' or 'probation' (never 'former')
 * Hosts, managers, support, other, former, and foreign employees are all rejected.
 */
export function validatePicker(emp: PickerCandidate | null | undefined): PickerValidation {
  if (!emp) return { valid: false, reason: 'not_found', name: null };
  if ((emp.role ?? '').trim().toLowerCase() !== 'fulfillment') return { valid: false, reason: 'role', name: null };
  if (emp.status !== 'active' && emp.status !== 'probation') return { valid: false, reason: 'status', name: null };
  return { valid: true, reason: 'ok', name: emp.name };
}

// ─────────────────────────────────────────────────────────────────────────────
// Numeric helpers
// ─────────────────────────────────────────────────────────────────────────────

// Arithmetic mean; null when empty.
export function mean(nums: number[]): number | null {
  if (nums.length === 0) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

// Median (mean of the two middle values for even counts); null when empty. Internal diagnostic.
export function median(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Valid per-box pick duration (ms), or null when it must not count.
 * Excludes: missing pick_started_at, unparseable timestamps, duration ≤ 0 (negative/zero),
 * and duration > maxMs (default MAX_PICK_DURATION_MS).
 */
export function boxDurationMs(
  pickStartedAt: string | null | undefined,
  verifiedAt: string | null | undefined,
  maxMs: number = MAX_PICK_DURATION_MS,
): number | null {
  if (!pickStartedAt || !verifiedAt) return null;
  const start = Date.parse(pickStartedAt);
  const end = Date.parse(verifiedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const dur = end - start;
  if (dur <= 0) return null;
  if (dur > maxMs) return null;
  return dur;
}

// ─────────────────────────────────────────────────────────────────────────────
// KPI aggregation
// ─────────────────────────────────────────────────────────────────────────────

export interface PickEvent {
  group_key: string;                    // box identity — DB-unique per account; de-duped here too
  picker_employee_id: string | null;    // null on historical rows or after employee deletion
  picker_name_snapshot: string | null;  // name at pick time; survives rename/delete
  pick_started_at: string | null;       // when the box was loaded (null on historical rows)
  verified_at: string;                  // ISO timestamp of the successful completion
  order_ids: string[];                  // orders in the box; cardinality = orders picked
}

export interface PickerDayStats {
  picker_employee_id: string | null;
  name: string;               // resolved display name (current name if still exists, else snapshot)
  is_unassigned: boolean;     // true only when NO id and NO snapshot (untracked history)
  orders_picked: number;      // Σ unique order_ids across the picker's boxes
  boxes_completed: number;    // count of distinct completed boxes
  avg_pick_ms: number | null;         // mean of VALID box durations; null when none countable
  active_pick_ms: number | null;      // sum of VALID box durations; null when none countable
  orders_per_active_hour: number | null; // orders ÷ active hours; null when active is 0/none
  valid_duration_count: number;       // boxes with a valid duration (transparency)
  // Internal diagnostics — NOT surfaced in the primary UI (legacy gap/session logic):
  sessions: number;
  median_gap_ms: number | null;
}

export interface FulfillmentDaySummary {
  orders_picked: number;       // ALL boxes that day (attributed + unassigned)
  boxes_completed: number;     // ALL completed boxes that day
  avg_pick_ms: number | null;  // team-wide mean of VALID box durations; null when none
  active_pickers: number;      // distinct NAMED pickers with ≥ 1 completed box
}

export interface FulfillmentDay {
  pickers: PickerDayStats[];              // named pickers (incl. former/deleted via snapshot), busiest first
  unassigned: { orders_picked: number; boxes_completed: number } | null;
  summary: FulfillmentDaySummary;
}

/**
 * Sessionise a picker's sorted completion timestamps (ms). INTERNAL DIAGNOSTIC ONLY.
 *   • sessions  = 1 + (number of gaps > gapMs), or 0 when there are no picks.
 *   • intraGaps = gaps ≤ gapMs (within-session gaps).
 */
export function sessionize(sortedMs: number[], gapMs: number = SESSION_GAP_MS): {
  sessions: number; intraGaps: number[]; activeMs: number;
} {
  if (sortedMs.length === 0) return { sessions: 0, intraGaps: [], activeMs: 0 };
  let sessions = 1;
  const intraGaps: number[] = [];
  for (let i = 1; i < sortedMs.length; i++) {
    const gap = sortedMs[i] - sortedMs[i - 1];
    if (gap > gapMs) sessions += 1;
    else intraGaps.push(gap);
  }
  const activeMs = intraGaps.reduce((a, b) => a + b, 0);
  return { sessions, intraGaps, activeMs };
}

/**
 * Aggregate one business-day's completed-box events into per-picker KPIs + a team summary.
 * `events` must already be scoped to the account and the selected day (the API does the
 * timezone-bounded query). `nameById` maps still-existing employee ids → current name, so a
 * renamed employee shows the current name while a deleted one falls back to the snapshot.
 */
export function aggregateFulfillmentDay(
  events: PickEvent[],
  nameById: Record<string, string> = {},
  opts: { maxPickMs?: number; gapMs?: number } = {},
): FulfillmentDay {
  const maxPickMs = opts.maxPickMs ?? MAX_PICK_DURATION_MS;
  const gapMs = opts.gapMs ?? SESSION_GAP_MS;

  // De-dupe defensively by group_key (DB already guarantees one row per box per account).
  const byBox = new Map<string, PickEvent>();
  for (const e of events) if (!byBox.has(e.group_key)) byBox.set(e.group_key, e);
  const boxes = [...byBox.values()];

  // Group by picker. Attribution key prefers the employee id; a deleted employee (id nulled
  // by ON DELETE SET NULL) is still attributed to their name via the snapshot. Only a row
  // with NEITHER id NOR snapshot is truly "Unassigned".
  interface Group { id: string | null; snapshot: string | null; boxes: PickEvent[]; }
  const groups = new Map<string, Group>();
  const allValidDurations: number[] = []; // team-wide (named + unassigned) valid box durations
  let unassignedOrders = 0;
  let unassignedBoxes = 0;

  for (const b of boxes) {
    const d = boxDurationMs(b.pick_started_at, b.verified_at, maxPickMs);
    if (d != null) allValidDurations.push(d);

    const id = b.picker_employee_id ?? null;
    const snap = (b.picker_name_snapshot ?? '').trim() || null;
    if (!id && !snap) {
      unassignedBoxes += 1;
      unassignedOrders += new Set(b.order_ids ?? []).size;
      continue;
    }
    const key = id ? `id:${id}` : `name:${snap}`;
    let g = groups.get(key);
    if (!g) { g = { id, snapshot: snap, boxes: [] }; groups.set(key, g); }
    g.boxes.push(b);
  }

  const pickers: PickerDayStats[] = [];

  for (const g of groups.values()) {
    const orders = g.boxes.reduce((sum, b) => sum + new Set(b.order_ids ?? []).size, 0);
    const durations = g.boxes
      .map((b) => boxDurationMs(b.pick_started_at, b.verified_at, maxPickMs))
      .filter((d): d is number => d != null);
    const activePickMs = durations.length ? durations.reduce((a, b) => a + b, 0) : null;
    const ordersPerActiveHour = activePickMs && activePickMs > 0 ? orders / (activePickMs / 3_600_000) : null;
    const name = (g.id && nameById[g.id]) || g.snapshot || 'Unknown picker';

    // Internal diagnostics (not surfaced): legacy gap/session view of the same completions.
    const sortedMs = g.boxes.map((b) => Date.parse(b.verified_at)).sort((a, b) => a - b);
    const { sessions, intraGaps } = sessionize(sortedMs, gapMs);

    pickers.push({
      picker_employee_id: g.id,
      name,
      is_unassigned: false,
      orders_picked: orders,
      boxes_completed: g.boxes.length,
      avg_pick_ms: mean(durations),
      active_pick_ms: activePickMs,
      orders_per_active_hour: ordersPerActiveHour,
      valid_duration_count: durations.length,
      sessions,
      median_gap_ms: median(intraGaps),
    });
  }

  // Busiest first (boxes, then orders), stable by name.
  pickers.sort((a, b) =>
    b.boxes_completed - a.boxes_completed
    || b.orders_picked - a.orders_picked
    || a.name.localeCompare(b.name));

  const attributedOrders = pickers.reduce((s, p) => s + p.orders_picked, 0);
  const attributedBoxes = pickers.reduce((s, p) => s + p.boxes_completed, 0);

  return {
    pickers,
    unassigned: unassignedBoxes > 0 ? { orders_picked: unassignedOrders, boxes_completed: unassignedBoxes } : null,
    summary: {
      orders_picked: attributedOrders + unassignedOrders,
      boxes_completed: attributedBoxes + unassignedBoxes,
      avg_pick_ms: mean(allValidDurations),
      active_pickers: pickers.length,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Display formatting (used by the UI; pure)
// ─────────────────────────────────────────────────────────────────────────────

// Manager-friendly duration: "42 sec", "2m 18s", "1h 12m". null → "—".
export function formatPickDuration(ms: number | null): string {
  if (ms == null) return '—';
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec} sec`;
  const totalMin = Math.floor(totalSec / 60);
  if (totalMin < 60) {
    const s = totalSec % 60;
    return s ? `${totalMin}m ${s}s` : `${totalMin}m`;
  }
  const hr = Math.floor(totalMin / 60);
  const min = totalMin % 60;
  return min ? `${hr}h ${min}m` : `${hr}h`;
}

// Orders/active-hour rate for display: one decimal, or "—" when not computable.
export function formatRate(rate: number | null): string {
  return rate == null ? '—' : rate.toFixed(1);
}
