import 'server-only';
import { createAdminClient } from '@/lib/supabase/admin';
import {
  SHOP_TIMEZONE, crewRangeUtcMs, tzOffsetMs, fulfillmentDayKey, addDaysISO, aggregateCrewBoard,
  type Crew, type CrewBoard, type CrewBoxEvent, type CrewPunch,
} from '@/lib/shipping/crewBoard';

// SERVER-SIDE data layer for the public /s/[token]/pickers board.
//
// SECURITY MODEL (see the auth-sessions section of CLAUDE.md): this route establishes NO Supabase
// auth session — no signIn, no session cookie, no client-side auth client. Everything below runs
// through the SERVICE-ROLE client, which bypasses RLS entirely. RLS is therefore NEVER the
// boundary here: the boundary is the crew token, and every query below carries an explicit
// `.eq('user_id', ownerId)` where ownerId came from the token row. Do not drop those filters on
// the assumption that RLS covers them — it does not.

export interface ResolvedCrewToken {
  tokenId: string;
  ownerId: string;
  crew: Crew;
  label: string;
  targetBoxes: number | null;
}

// Resolve an ACTIVE crew token. Returns null for any miss (unknown/revoked token) — the caller
// renders a bare 404 and leaks no detail about which.
export async function resolveCrewToken(token: string): Promise<ResolvedCrewToken | null> {
  if (!token || token.length < 20) return null;  // cheap reject of obviously-bad tokens
  const admin = createAdminClient();
  const { data, error } = await admin
    .from('crew_board_tokens')
    .select('id, user_id, crew, label, target_boxes, active')
    .eq('token', token)
    .eq('active', true)
    .maybeSingle();
  if (error || !data) return null;
  return {
    tokenId: data.id as string,
    ownerId: data.user_id as string,
    crew: data.crew as Crew,
    label: (data.label as string) || 'Crew',
    targetBoxes: (data.target_boxes as number | null) ?? null,
  };
}

// PostgREST caps a read at 1000 rows and TRUNCATES SILENTLY — a truncated box count is a wrong
// number that looks right, which on this board means understating a picker's output. Today's
// morning crew alone was 1,367 boxes, so this WILL page in normal operation. Ordered by a stable
// key (id) alongside the range: Postgres gives no row-order guarantee for LIMIT/OFFSET without
// ORDER BY, so unordered paging can repeat or drop rows across pages.
const PAGE = 1000;

async function readBoxesPaged(
  ownerId: string, startISO: string, endISO: string,
): Promise<CrewBoxEvent[]> {
  const admin = createAdminClient();
  const rows: CrewBoxEvent[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await admin
      .from('shipment_verifications')
      .select('id, group_key, picker_employee_id, picker_name_snapshot, verified_at')
      .eq('user_id', ownerId)                    // explicit owner scope — RLS is bypassed here
      .gte('verified_at', startISO)
      .lt('verified_at', endISO)
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`crew board: verifications query failed: ${error.message}`);
    const page = data ?? [];
    for (const r of page) {
      rows.push({
        group_key: String(r.group_key),
        picker_employee_id: (r.picker_employee_id as string | null) ?? null,
        picker_name_snapshot: (r.picker_name_snapshot as string | null) ?? null,
        verified_at: String(r.verified_at),
      });
    }
    if (page.length < PAGE) break;
  }
  return rows;
}

/**
 * Load one crew's board for one fulfillment day.
 *
 * `day` is a fulfillment day key (04:00→04:00), NOT a calendar date — between midnight and 04:00
 * the night crew is still on the previous day's key, which is what keeps their 17:00–01:00 shift
 * in one place.
 */
export async function loadCrewBoard(
  tok: ResolvedCrewToken, day: string, nowMs: number = Date.now(),
): Promise<CrewBoard> {
  const admin = createAdminClient();
  const { startMs, endMs } = crewRangeUtcMs(day, tok.crew, SHOP_TIMEZONE);
  const startISO = new Date(startMs).toISOString();
  const endISO = new Date(endMs).toISOString();

  // shifts.date is the calendar date a punch is filed under. A pm window spans midnight, so a
  // night shift beginning 17:00 on `day` and ending 01:00 the next morning may be filed under
  // either date depending on when the punch was written — accept both.
  const dates = tok.crew === 'pm' ? [day, addDaysISO(day, 1)] : [day];

  const [boxes, punchRes, empRes] = await Promise.all([
    readBoxesPaged(tok.ownerId, startISO, endISO),
    admin
      .from('shifts')
      .select('employee_id, clock_in_at, clock_out_at')
      .eq('user_id', tok.ownerId)                       // explicit owner scope
      .in('date', dates)
      .not('clock_in_at', 'is', null),
    // Name-only employee read. hourly_rate / pay is NEVER selected on this route — a shift
    // manager's link must not quietly become a payroll surface.
    admin
      .from('employees')
      .select('id, name, role')
      .eq('user_id', tok.ownerId),                      // explicit owner scope
  ]);

  if (punchRes.error) throw new Error(`crew board: punches query failed: ${punchRes.error.message}`);
  if (empRes.error) throw new Error(`crew board: employees query failed: ${empRes.error.message}`);

  const nameById: Record<string, string> = {};
  const isFulfillment = new Set<string>();
  for (const e of empRes.data ?? []) {
    nameById[e.id as string] = e.name as string;
    if ((e.role ?? '').trim().toLowerCase() === 'fulfillment') isFulfillment.add(e.id as string);
  }

  // Keep only fulfillment punches that actually overlap this crew's window. Hosts clock in on the
  // same dates (29 of them) and must never appear on a picker board.
  const punches: CrewPunch[] = (punchRes.data ?? [])
    .filter((p) => isFulfillment.has(p.employee_id as string))
    .map((p) => ({
      employee_id: p.employee_id as string,
      name: nameById[p.employee_id as string] ?? 'Unknown',
      clock_in_at: String(p.clock_in_at),
      clock_out_at: (p.clock_out_at as string | null) ?? null,
    }))
    .filter((p) => {
      const inMs = Date.parse(p.clock_in_at);
      const outMs = p.clock_out_at ? Date.parse(p.clock_out_at) : nowMs;
      return Number.isFinite(inMs) && inMs < endMs && outMs > startMs;
    });

  return aggregateCrewBoard(
    boxes, punches, day, tok.crew, startMs, endMs, nowMs,
    (ms) => tzOffsetMs(ms, SHOP_TIMEZONE), nameById, tok.targetBoxes,
  );
}

// The fulfillment day currently in progress, in shop time.
export function currentDay(nowMs: number = Date.now()): string {
  return fulfillmentDayKey(nowMs, SHOP_TIMEZONE);
}
