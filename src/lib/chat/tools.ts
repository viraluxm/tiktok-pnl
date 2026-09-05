import type Anthropic from '@anthropic-ai/sdk';
import type { SupabaseClient } from '@supabase/supabase-js';
import { isPayableShift, paidShiftHours, computePay, payPeriodFor, nextPayday } from '@/lib/employees';

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
  /** Every store the owner set covers. A store-restricted caller gets a narrowed list here. */
  storeIds: string[];
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
  {
    name: 'get_pnl',
    description:
      'Revenue, platform fee, COGS and GROSS MARGIN for a date range (max 92 days), from the ' +
      'canonical order-grain view the dashboard reads. Optionally per-store or per-day. ' +
      'IMPORTANT: this returns GROSS MARGIN (revenue - platform fee - COGS). It is NOT the ' +
      'dashboard\'s "Net Profit", which additionally subtracts shipping, affiliate fees and ' +
      'labor. Never call the result net profit. Always report cogs_coverage alongside any margin ' +
      'figure — partial cost data inflates margin.',
    input_schema: {
      type: 'object',
      properties: {
        from: { type: 'string', pattern: ISO_DATE, description: 'Start date, inclusive (YYYY-MM-DD, America/Los_Angeles).' },
        to: { type: 'string', pattern: ISO_DATE, description: 'End date, inclusive (YYYY-MM-DD, America/Los_Angeles).' },
        store_id: { type: 'string', description: 'A store id to restrict to, or the literal "all".' },
        group_by: { type: 'string', enum: ['total', 'day', 'store'], description: 'Aggregation level.' },
      },
      required: ['from', 'to', 'store_id', 'group_by'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: 'get_pay',
    description:
      'Payroll for a biweekly pay period: hours and dollars owed per employee, derived from real ' +
      'shift rows via the same computePay() the Pay view uses. Pay is DERIVED (hours x rate), never ' +
      'stored. Use for "what do I owe", "how many hours did X work this period", payday questions.',
    input_schema: {
      type: 'object',
      properties: {
        date_in_period: {
          type: 'string',
          description: 'Any date (YYYY-MM-DD) inside the pay period of interest, or "current" for the period containing today.',
        },
      },
      required: ['date_in_period'],
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


// ── get_pnl ─────────────────────────────────────────────────────────────────
// Reads `pnl_order_grain` — the same canonical order-grain view the dashboard reads. Deliberately
// NOT pnl_by_period_as, which computes a DIFFERENT figure (revenue x 0.94 - cogs, auction-sold
// only). Two live definitions of "profit" that disagree is how the assistant ends up contradicting
// the screen the admin is looking at.
//
// This reports GROSS MARGIN (revenue - platform fee - COGS). The dashboard's "Net Profit" also
// subtracts shipping, affiliate and labor, so the two are NOT interchangeable and the tool result
// says so. Cost coverage is returned with every figure: COGS is PARTIAL BY DESIGN (only auction
// orders carry a cost snapshot), and a partial COGS INFLATES margin rather than erroring.
//
// NOTE: lensed_product_stats_totals_as (migration 114) would let this aggregate server-side, but it
// is NOT APPLIED IN PROD (verified 2026-09-05) — the repo file is not evidence the function exists.
// Paging the view and aggregating here needs no migration.
async function getPnl(
  ctx: ToolCtx,
  input: { from: string; to: string; store_id?: string; group_by?: string },
) {
  const { from, to } = input;
  const span = daysBetween(from, to);
  if (!Number.isFinite(span)) throw new Error('from/to must be YYYY-MM-DD dates');
  if (span < 0) throw new Error('`from` must be on or before `to`');
  if (span > MAX_RANGE_DAYS) throw new Error(`range too wide: ${span + 1} days requested, max ${MAX_RANGE_DAYS}.`);

  const wantStore = input.store_id && input.store_id !== 'all' ? input.store_id : null;
  if (wantStore && !ctx.storeIds.includes(wantStore)) {
    throw new Error(`store ${wantStore} is not in scope`);
  }
  const groupBy = input.group_by ?? 'total';

  // Aggregate IN SQL, never by paging the view. `pnl_order_grain` is an expensive multi-CTE view
  // and PostgREST's 1000-row cap means one page per 1000 orders, re-evaluating the whole view each
  // time: measured 19.4s for ONE day, 104.1s for a week (past /api/chat's 60s cap), 383.1s for a
  // month. The same aggregate in SQL: 3.4s for that day. PostgREST server-side aggregates are
  // disabled here (PGRST123), so the grouping has to live in the database — migration 128.
  const { data, error } = await ctx.admin.rpc('chat_pnl_totals_as', {
    p_owner_user_ids: ctx.ownerIds,
    p_store_ids: wantStore ? [wantStore] : ctx.storeIds,
    p_from: from,
    p_to: to,
    p_group_by: groupBy,
  });
  if (error) {
    const e = error as { code?: string; message?: string };
    // 42883 = undefined_function. This DB has no migration ledger, so the repo file is not
    // evidence the function exists (lensed_product_stats_totals_as is committed as migration 114
    // and is NOT in prod). Say precisely what is missing rather than surfacing a raw PG error.
    if (e.code === '42883' || /does not exist/i.test(e.message ?? '')) {
      throw new Error(
        'P&L is unavailable: database function chat_pnl_totals_as is not installed. ' +
        'Migration supabase/migrations/128_chat_pnl_totals_as.sql needs to be applied. ' +
        'Tell the admin this plainly — do not estimate revenue or margin from anything else.',
      );
    }
    throw new Error(`pnl aggregate failed: ${e.message ?? String(error)}`);
  }

  const n = (v: unknown) => Number(v) || 0;
  const d = (cents: number) => Math.round(cents) / 100;
  const buckets = ((data ?? []) as Record<string, unknown>[]).map((r) => {
    const orders = n(r.orders);
    const missing = n(r.orders_missing_cost);
    const revenue = n(r.revenue_cents);
    const fee = n(r.platform_fee_cents);
    const cogs = n(r.cogs_cents);
    const covered = orders - missing;
    // Revenue with NO cost data at all cannot resolve to a real margin — the figure would be
    // revenue minus fees and would read as an enormous profit. Withhold it rather than mislead.
    const costDataUnavailable = revenue > 0 && cogs === 0;
    return {
      key: String(r.bucket),
      orders,
      units: n(r.units),
      revenue_dollars: d(revenue),
      platform_fee_dollars: d(fee),
      cogs_dollars: d(cogs),
      gross_margin_dollars: costDataUnavailable ? null : d(revenue - fee - cogs),
      gross_margin_withheld_reason: costDataUnavailable
        ? 'revenue present but zero COGS recorded — a margin here would be revenue minus fees and badly overstated'
        : null,
      non_auction_merch_dollars: d(n(r.uncaptured_gmv_cents)),
      cogs_coverage: {
        orders_with_full_cost: covered,
        orders_missing_cost: missing,
        coverage_pct: orders > 0 ? Math.round((covered / orders) * 100) : 0,
        missing_cost_lines: n(r.missing_cost_lines),
      },
    };
  });

  return {
    range: { from, to, tz: 'America/Los_Angeles', days: span + 1 },
    store_id: wantStore ?? 'all',
    stores_in_scope: ctx.storeIds.length,
    group_by: groupBy,
    definition:
      'gross_margin = revenue - platform_fee - cogs. This is NOT the dashboard\'s Net Profit, which ' +
      'also subtracts shipping, affiliate fees and labor. Report it as gross margin.',
    cogs_note:
      'COGS is partial by design — only auction orders carry a cost snapshot. Always state coverage_pct ' +
      'next to any margin figure; low coverage means the margin is OVERSTATED.',
    buckets,
  };
}

// ── get_pay ─────────────────────────────────────────────────────────────────
// Pay is DERIVED (hours x rate), never stored. Uses computePay() from lib/employees so the numbers
// match the Pay view exactly — a second payroll formula here would be a payroll dispute waiting to
// happen. Reads REAL shift rows only; isPayableShift() decides what counts (see get_schedule).
async function getPay(ctx: ToolCtx, input: { date_in_period?: string }) {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  const anchor = !input.date_in_period || input.date_in_period === 'current' ? today : input.date_in_period;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(anchor)) throw new Error('date_in_period must be YYYY-MM-DD or "current"');

  // Derive period AND payday from the library's own functions rather than re-deriving the cycle.
  // payPeriodContaining() would give the period but drops the payday it came from, and PayPeriod
  // carries only {start, end} — so mirror its internals (probe = D+5, built from LOCAL components
  // exactly as it does) and keep both halves.
  const [py, pm, pd] = anchor.split('-').map(Number);
  const payday = nextPayday(new Date(py, pm - 1, pd + 5));
  const period = payPeriodFor(payday);

  const emp = await pageAll<Record<string, unknown>>((f: number, t: number) =>
    ctx.admin.from('employees')
      .select('id, name, role, status, hourly_rate')
      .in('user_id', ctx.ownerIds)
      .order('id', { ascending: true }).range(f, t));
  if (emp.error) throw new Error(`employees read failed: ${String((emp.error as { message?: string }).message ?? emp.error)}`);

  const sh = await pageAll<Record<string, unknown>>((f: number, t: number) =>
    ctx.admin.from('shifts')
      .select('employee_id, date, start_time, end_time, source, source_rule_id, confirmed_at, break_minutes, clock_in_at, clock_out_at')
      .in('user_id', ctx.ownerIds)
      .gte('date', period.start).lte('date', period.end)
      .order('employee_id', { ascending: true }).range(f, t));
  if (sh.error) throw new Error(`shifts read failed: ${String((sh.error as { message?: string }).message ?? sh.error)}`);

  const employees = emp.rows as unknown as Parameters<typeof computePay>[0];
  const shifts = sh.rows as unknown as Parameters<typeof computePay>[1];
  const pay = computePay(employees, shifts);

  const excluded = sh.rows.filter((r) => !isPayableShift(r as Parameters<typeof isPayableShift>[0]));
  const unconfirmed = excluded.filter((r) => r.source === 'time_clock' && r.confirmed_at == null).length;

  return {
    pay_period: { start: period.start, end: period.end, payday },
    note: 'Pay is derived (hours x rate) from UNROUNDED hours, never stored — quote pay_dollars as given rather than recomputing it from the rounded hours shown here. Only payable shift rows count; see excluded_shifts.',
    employees: pay
      .filter((p) => p.hours > 0 || p.employee.status === 'active')
      .map((p) => ({
        employee_id: p.employee.id,
        name: p.employee.name,
        role: p.employee.role,
        status: p.employee.status,
        hourly_rate: p.employee.hourly_rate,
        // 4dp, not 2dp. pay_dollars is computePay()'s figure, derived from UNROUNDED hours — so
        // hours rounded to 2dp does not reconcile against it (21.48 x $25 reads $537.00 vs the
        // true $536.93). Cents, but a model that sanity-checks the arithmetic would "correct" a
        // correct payroll number, and an admin doing the same mental math would lose trust in it.
        // 4dp reconciles to under a cent; the system prompt still says to round to 1dp when speaking.
        hours: Math.round(p.hours * 10000) / 10000,
        pay_dollars: Math.round(p.pay * 100) / 100,
      })),
    totals: {
      hours: Math.round(pay.reduce((a, p) => a + p.hours, 0) * 10000) / 10000,
      pay_dollars: Math.round(pay.reduce((a, p) => a + p.pay, 0) * 100) / 100,
    },
    excluded_shifts: {
      count: excluded.length,
      awaiting_manager_confirmation: unconfirmed,
      note: unconfirmed > 0
        ? `${unconfirmed} time-clock punch(es) are NOT yet payable — they need manager confirmation. Say this rather than describing them as unpaid work.`
        : null,
    },
  };
}

export async function runTool(ctx: ToolCtx, name: string, input: unknown): Promise<unknown> {
  const args = (input ?? {}) as Record<string, never>;
  switch (name) {
    case 'get_roster': return getRoster(ctx, args);
    case 'get_schedule': return getSchedule(ctx, args as never);
    case 'get_pnl': return getPnl(ctx, args as never);
    case 'get_pay': return getPay(ctx, args as never);
    default: throw new Error(`unknown tool: ${name}`);
  }
}
