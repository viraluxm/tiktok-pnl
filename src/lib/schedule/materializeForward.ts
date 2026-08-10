import type { ShiftRule } from '@/types';
import { laTodayISO, addDaysISO, weekdayOf, laWallTimeToUtc } from './timezone';

// FORWARD SCHEDULE MATERIALIZER (Deploy B, Part 1) — the NEW, separate materializer.
//
// It writes ONLY into shift_instances, ONLY for future dates (today+1 … today+HORIZON_DAYS),
// and NEVER touches `shifts` or isPayableShift() — payroll's past-materializer
// (src/lib/shifts/materialize.ts) is untouched and out of scope (that is Deploy C).
//
// Source (migration 086 — single schedule model): EVERY active shift_rule. There are no
// templates and no slots — a rule is one person's recurring shift. For each rule it generates a
// scheduled instance on every future date whose weekday is in the rule's (multi-element)
// days_of_week and is on/after start_date, subject to two gates:
//   1. REGENERATION GUARD: skip (employee_id, shift_date) when an unresolved
//      'released'/'missed_unfilled' attendance_events row exists for that employee + date. This is
//      what stops a released slot from being silently regenerated for its releaser — a unique index
//      could not (a fresh insert has released_by NULL / employee_id set, NULLs distinct).
//   2. CONFLICT: an existing instance for (employee_id, shift_date) wins untouched (insert-or-skip).
// There is NO capacity check — without templates there are no caps; a released instance is one
// person's shift, so capacity is inherently 1 (enforced by UNIQUE(employee_id, shift_date)).
//
// Idempotent + never-mutating: upsert(ignoreDuplicates) on the (employee_id, shift_date) unique
// constraint. An existing row for that key is left exactly as it is regardless of status.

export const HORIZON_DAYS = 28;

export interface PlannedInstance {
  user_id: string;
  shift_rule_id: string;
  employee_id: string;
  store_id: string | null;
  shift_date: string;
  starts_at: string; // ISO timestamptz (UTC)
  ends_at: string; // ISO timestamptz (UTC)
  status: 'scheduled';
  source: 'pattern';
}

export interface ExistingInstanceKey {
  employee_id: string | null;
  shift_date: string;
}

export interface PlanResult {
  today: string;
  window: { from: string; to: string };
  rules_processed: number;
  candidates: number;
  to_insert: PlannedInstance[];
  skipped_by_guard: number;
  skipped_by_conflict: number;
}

// PURE planner — no DB, no clock. Deterministic given its inputs, so it is unit-testable and the
// dry-run shows exactly what a real run would insert. days_of_week is expanded via the SAME
// convention as generateRecurringShifts (a Set of getUTCDay() numbers, matched against the date's
// weekday) — a rule with [1,2,4,0] produces four candidates per week.
export function planForwardInstances(input: {
  rules: ShiftRule[];
  existing: ExistingInstanceKey[];
  guardKeys: ReadonlySet<string>; // `${employee_id}|${shift_date}`
  today: string;
  horizonDays?: number;
}): PlanResult {
  const horizon = input.horizonDays ?? HORIZON_DAYS;
  const from = addDaysISO(input.today, 1);
  const to = addDaysISO(input.today, horizon);

  const key = (employeeId: string, date: string) => `${employeeId}|${date}`;
  // Existing (employee, date) — conflict/idempotency set. Released rows (employee_id null) don't
  // block regeneration by key (that's the guard's job), matching the DB's NULL-distinct UNIQUE.
  const existingKeys = new Set(
    input.existing.filter((x) => x.employee_id).map((x) => key(x.employee_id as string, x.shift_date)),
  );

  // Stable order (created_at, id) so that if two active rules ever collide on (employee, date),
  // the earliest-created wins deterministically (the loser is an in-run conflict skip).
  const rules = [...input.rules].sort(
    (a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id < b.id ? -1 : 1),
  );

  const toInsert: PlannedInstance[] = [];
  let candidates = 0;
  let skippedByGuard = 0;
  let skippedByConflict = 0;

  for (const rule of rules) {
    if (!rule.active || !rule.days_of_week || rule.days_of_week.length === 0) continue;
    const days = new Set(rule.days_of_week);

    for (let i = 1; i <= horizon; i++) {
      const date = addDaysISO(input.today, i);
      if (!days.has(weekdayOf(date))) continue;
      if (date < rule.start_date) continue;
      candidates++;

      if (input.guardKeys.has(key(rule.employee_id, date))) {
        skippedByGuard++;
        continue;
      }
      if (existingKeys.has(key(rule.employee_id, date))) {
        skippedByConflict++;
        continue;
      }

      const startMins = timeMins(rule.start_time);
      const endMins = timeMins(rule.end_time);
      const endDate = endMins <= startMins ? addDaysISO(date, 1) : date; // overnight (incl. 00:00 end) rolls +1 day
      toInsert.push({
        user_id: rule.user_id,
        shift_rule_id: rule.id,
        employee_id: rule.employee_id,
        store_id: rule.store_id ?? null,
        shift_date: date,
        starts_at: laWallTimeToUtc(date, rule.start_time).toISOString(),
        ends_at: laWallTimeToUtc(endDate, rule.end_time).toISOString(),
        status: 'scheduled',
        source: 'pattern',
      });
      existingKeys.add(key(rule.employee_id, date)); // dedupe within this run
    }
  }

  return {
    today: input.today,
    window: { from, to },
    rules_processed: rules.length,
    candidates,
    to_insert: toInsert,
    skipped_by_guard: skippedByGuard,
    skipped_by_conflict: skippedByConflict,
  };
}

function timeMins(t: string): number {
  const [h, m] = t.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

export interface MaterializeForwardResult extends Omit<PlanResult, 'to_insert'> {
  dry_run: boolean;
  to_insert_count: number;
  inserted: number;
  sample: PlannedInstance[]; // first few planned rows, for logging
}

// DB-connected runner. Loads active rules + existing instances + guard events for the window,
// plans, and (when write) inserts with ON CONFLICT DO NOTHING. Reads all users (service-role,
// global), exactly like the existing past-materializer.
export async function runForwardMaterializer(opts: { write: boolean }): Promise<MaterializeForwardResult> {
  // Lazy import so the pure planner can be exercised without the server-only env in admin.
  const { createAdminClient } = await import('@/lib/supabase/admin');
  const admin = createAdminClient();
  const today = laTodayISO();
  const from = addDaysISO(today, 1);
  const to = addDaysISO(today, HORIZON_DAYS);

  const { data: ruleRows, error: rErr } = await admin
    .from('shift_rules')
    .select('*')
    .eq('active', true);
  if (rErr) throw new Error(`shift_rules read failed: ${rErr.message}`);
  const rules = (ruleRows ?? []) as ShiftRule[];

  const { data: instRows, error: iErr } = await admin
    .from('shift_instances')
    .select('employee_id, shift_date')
    .gte('shift_date', from)
    .lte('shift_date', to);
  if (iErr) throw new Error(`shift_instances read failed: ${iErr.message}`);
  const existing = (instRows ?? []) as ExistingInstanceKey[];

  const { data: evRows, error: eErr } = await admin
    .from('attendance_events')
    .select('employee_id, shift_date')
    .in('event_type', ['released', 'missed_unfilled'])
    .gte('shift_date', from)
    .lte('shift_date', to);
  if (eErr) throw new Error(`attendance_events read failed: ${eErr.message}`);
  const guardKeys = new Set((evRows ?? []).map((e) => `${e.employee_id}|${e.shift_date}`));

  const plan = planForwardInstances({ rules, existing, guardKeys, today });

  let inserted = 0;
  if (opts.write && plan.to_insert.length > 0) {
    for (let i = 0; i < plan.to_insert.length; i += 500) {
      const chunk = plan.to_insert.slice(i, i + 500);
      const { error, count } = await admin
        .from('shift_instances')
        .upsert(chunk, { onConflict: 'employee_id,shift_date', ignoreDuplicates: true, count: 'exact' });
      if (error) throw new Error(`shift_instances insert failed: ${error.message}`);
      inserted += count ?? 0;
    }
  }

  const { to_insert, ...rest } = plan;
  return {
    ...rest,
    dry_run: !opts.write,
    to_insert_count: to_insert.length,
    inserted,
    sample: to_insert.slice(0, 10),
  };
}
