import type Anthropic from '@anthropic-ai/sdk';
import type { SupabaseClient } from '@supabase/supabase-js';
import { isPayableShift, paidShiftHours } from '@/lib/employees';

// Read-only, owner-scoped tools for the admin chat assistant.
//
// Three rules hold for every tool in this file, and breaking any one of them produces
// an answer that is confidently, fluently wrong — the worst failure mode this feature has:
//
//  1. SCOPE EXPLICITLY. Every query filters `.in('user_id', ownerIds)`. These run on the
//     service-role client (RLS bypassed), so the filter IS the tenant boundary — never
//     the caller's id, which for a non-owner admin returns an empty set (see resolveOwnerIds).
//  2. PAGE EVERY READ. PostgREST caps responses at 1000 rows on this project and truncates
//     SILENTLY. A truncated read is indistinguishable from a real answer, so it becomes a
//     wrong number stated as fact. Everything here goes through selectAllPages with a
//     stable .order() (required — LIMIT/OFFSET without ORDER BY can repeat rows across pages).
//  3. NEVER RETURN A CREDENTIAL. employees carries pin_hash / override_pin_hash; those columns
//     are never selected. Select columns explicitly — never `select('*')`.
//
// READ-ONLY: nothing here writes. No insert/update/delete/rpc-with-side-effects. That is what
// keeps this feature outside the write-activity gate in CLAUDE.md.


// Paged read. PostgREST caps responses at 1000 rows on this project and truncates SILENTLY —
// a truncated read is indistinguishable from a real answer, so it becomes a wrong number stated
// as fact. Page until a short page comes back.
//
// `run` MUST apply a stable .order() alongside the range: Postgres gives no row-order guarantee
// for LIMIT/OFFSET without ORDER BY, so unordered paging can repeat rows across pages — which
// over-counts, strictly worse than truncating.
//
// Deliberately local rather than added to lib/supabase/inChunks.ts: an unmerged branch
// (fix/dashboard-cogs) is already adding an equivalent helper there, and a second definition of
// the same export in a shared file is a merge conflict for no benefit. Collapse the two into
// inChunks.ts once that branch lands.
const PAGE = 1000;

async function pageAll<T>(
  run: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
): Promise<{ rows: T[]; error: unknown }> {
  const rows: T[] = [];
  let offset = 0;
  for (;;) {
    const { data, error } = await run(offset, offset + PAGE - 1);
    if (error) return { rows, error };
    const n = data?.length ?? 0;
    if (data) for (const r of data) rows.push(r);
    if (n < PAGE) break;
    offset += PAGE;
  }
  return { rows, error: null };
}

export interface ToolCtx {
  admin: SupabaseClient;
  ownerIds: string[];
}

const ISO_DATE = '^\\d{4}-\\d{2}-\\d{2}$';

export const TOOL_DEFS: Anthropic.Beta.BetaTool[] = [
  {
    name: 'get_roster',
    description:
      'The employee roster: names, roles, status, hourly rates, hire and probation dates. ' +
      'Use for "who works here", headcount, pay rates, who is active vs inactive, and to map ' +
      'an employee name to the id used by other tools.',
    input_schema: {
      type: 'object',
      properties: {
        status: {
          // Single scalar type + a sentinel value rather than a nullable union: `strict: true`
          // demands every property appear in `required`, and the supported schema subset is
          // narrower than full JSON Schema — a `type: [...]` union is not worth the risk here.
          type: 'string',
          enum: ['active', 'inactive', 'all'],
          description: 'Filter by employment status. Use "active" unless asked otherwise.',
        },
      },
      required: ['status'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: 'get_schedule',
    description:
      'Scheduling and worked-time data for a date range (max 92 days). Returns three DISTINCT ' +
      'things, which must not be conflated: (a) `worked` — real shift rows, the only pay input; ' +
      '(b) `scheduled` — shift_instances, the plan / release-claim board; (c) `recurring_rules` — ' +
      'standing weekly rules. Use for questions about who worked, who is scheduled, coverage gaps, ' +
      'open or released shifts, unconfirmed punches, and hours.',
    input_schema: {
      type: 'object',
      properties: {
        from: { type: 'string', pattern: ISO_DATE, description: 'Start date, inclusive (YYYY-MM-DD, America/Los_Angeles).' },
        to: { type: 'string', pattern: ISO_DATE, description: 'End date, inclusive (YYYY-MM-DD, America/Los_Angeles).' },
        employee_id: {
          // Sentinel rather than a nullable union — see the note on get_roster.status.
          type: 'string',
          description: 'An employee id from get_roster to restrict to one person, or the literal "all" for everyone.',
        },
      },
      required: ['from', 'to', 'employee_id'],
      additionalProperties: false,
    },
    strict: true,
  },
];

const MAX_RANGE_DAYS = 92;

function daysBetween(from: string, to: string): number {
  return (Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86_400_000;
}

async function getRoster(ctx: ToolCtx, input: { status?: string | null }) {
  const status = input.status ?? 'active';
  const { rows, error } = await pageAll<Record<string, unknown>>((pgFrom: number, pgTo: number) => {
    let q = ctx.admin
      .from('employees')
      // Explicit columns: pin_hash / override_pin_hash / photo_path / phone are
      // deliberately excluded — credentials and PII the assistant has no need for.
      .select('id, name, role, status, hourly_rate, hire_date, probation_end_date, fulfillment_track')
      .in('user_id', ctx.ownerIds)
      .order('id', { ascending: true })
      .range(pgFrom, pgTo);
    if (status !== 'all') q = q.eq('status', status);
    return q;
  });
  if (error) throw new Error(`roster read failed: ${String((error as { message?: string }).message ?? error)}`);
  return { count: rows.length, status_filter: status, employees: rows };
}

async function getSchedule(
  ctx: ToolCtx,
  input: { from: string; to: string; employee_id?: string | null },
) {
  const { from, to } = input;
  const span = daysBetween(from, to);
  if (!Number.isFinite(span)) throw new Error('from/to must be YYYY-MM-DD dates');
  if (span < 0) throw new Error('`from` must be on or before `to`');
  if (span > MAX_RANGE_DAYS) {
    throw new Error(`range too wide: ${span + 1} days requested, max ${MAX_RANGE_DAYS}. Narrow the range and ask again.`);
  }
  const emp = input.employee_id && input.employee_id !== 'all' ? input.employee_id : null;

  // (a) Real shift rows — the pay input.
  const worked = await pageAll<Record<string, unknown>>((f: number, t: number) => {
    let q = ctx.admin
      .from('shifts')
      .select('id, employee_id, date, start_time, end_time, source, source_rule_id, confirmed_at, break_minutes, clock_in_at, clock_out_at, auto_closed, punch_method')
      .in('user_id', ctx.ownerIds)
      .gte('date', from).lte('date', to)
      .order('id', { ascending: true })
      .range(f, t);
    if (emp) q = q.eq('employee_id', emp);
    return q;
  });
  if (worked.error) throw new Error(`shifts read failed: ${String((worked.error as { message?: string }).message ?? worked.error)}`);

  // (b) The plan / release-claim board.
  const scheduled = await pageAll<Record<string, unknown>>((f: number, t: number) => {
    let q = ctx.admin
      .from('shift_instances')
      .select('id, employee_id, shift_date, starts_at, ends_at, status, source, released_at, excused, role, note, shift_rule_id')
      .in('user_id', ctx.ownerIds)
      .gte('shift_date', from).lte('shift_date', to)
      .order('id', { ascending: true })
      .range(f, t);
    if (emp) q = q.eq('employee_id', emp);
    return q;
  });
  if (scheduled.error) throw new Error(`shift_instances read failed: ${String((scheduled.error as { message?: string }).message ?? scheduled.error)}`);

  // (c) Standing weekly rules. Not date-filtered — a rule has no end date; it is a
  // standing pattern that the range is evaluated against.
  const rules = await pageAll<Record<string, unknown>>((f: number, t: number) => {
    let q = ctx.admin
      .from('shift_rules')
      .select('id, employee_id, days_of_week, start_time, end_time, start_date, active')
      .in('user_id', ctx.ownerIds)
      .order('id', { ascending: true })
      .range(f, t);
    if (emp) q = q.eq('employee_id', emp);
    return q;
  });
  if (rules.error) throw new Error(`shift_rules read failed: ${String((rules.error as { message?: string }).message ?? rules.error)}`);

  // Annotate each worked row with the SAME payability verdict the payroll UI uses —
  // imported from lib/employees, never reimplemented here. Two definitions of "payable"
  // that drift is exactly how the assistant would end up contradicting PayView.
  const workedRows = worked.rows.map((r: Record<string, unknown>) => {
    const s = r as Parameters<typeof isPayableShift>[0];
    const payable = isPayableShift(s);
    return {
      ...r,
      payable,
      paid_hours: payable ? Math.round(paidShiftHours(s) * 100) / 100 : 0,
      excluded_reason: payable
        ? null
        : r.end_time == null ? 'open shift (no end time)'
        : r.source_rule_id != null ? 'materialized from a schedule rule — plan, not pay'
        : 'time-clock punch awaiting manager confirmation',
    };
  });

  return {
    range: { from, to, tz: 'America/Los_Angeles', days: span + 1 },
    employee_id: emp,
    worked: {
      note: 'Real shift rows. `payable` uses the same isPayableShift() gate as the Pay view; `excluded_reason` says why a row is not payable.',
      count: workedRows.length,
      total_paid_hours: Math.round(workedRows.reduce((a: number, r) => a + (r.paid_hours as number), 0) * 100) / 100,
      rows: workedRows,
    },
    scheduled: {
      note: 'shift_instances — the PLAN (release/claim board). Never a pay input on its own.',
      count: scheduled.rows.length,
      rows: scheduled.rows,
    },
    recurring_rules: {
      note: 'Standing weekly rules, not date-filtered. An ACTIVE rule is projected into pay at read time by the Pay view, so an active rule means hours are owed even with no punch.',
      count: rules.rows.length,
      rows: rules.rows,
    },
  };
}

export async function runTool(ctx: ToolCtx, name: string, input: unknown): Promise<unknown> {
  const args = (input ?? {}) as Record<string, never>;
  switch (name) {
    case 'get_roster': return getRoster(ctx, args);
    case 'get_schedule': return getSchedule(ctx, args as never);
    default: throw new Error(`unknown tool: ${name}`);
  }
}
