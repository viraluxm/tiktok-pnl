import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { computeLaborByDateRole } from '@/lib/labor';

export const dynamic = 'force-dynamic';

// Dashboard LABOR line for a period [from, to] (inclusive 'YYYY-MM-DD', PACIFIC business date).
// PUNCH-DERIVED: host AND fulfillment labor both come from clock-in/out INSTANTS via
// computeLaborByDateRole, which reuses payroll's isPayableShift/paidShiftHours VERBATIM — labor
// can never drift from pay. Hosts with no payable punch fall back to bounded live-session
// duration (punch always wins). Time-clock punches still awaiting manager confirmation are NOT
// counted; they are surfaced as `pending` so a recent day never reads artificially cheap.
// No manual packer figure, no fixed -07:00 offset — the Pacific bucket is the NAMED zone (DST-safe).
const TZ = 'America/Los_Angeles';

const shiftDays = (isoDate: string, n: number) => {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const from = searchParams.get('from');
  const to = searchParams.get('to');
  if (!from || !to) return NextResponse.json({ error: 'from and to are required' }, { status: 400 });

  const admin = createAdminClient();

  const { data: employees } = await admin
    .from('employees')
    .select('id, role, hourly_rate')
    .eq('user_id', user.id);

  // Shifts by `date` with a ±1-day buffer — a shift's Pacific business date (its clock-in date)
  // can differ from its stored `date` by up to a day near midnight; computeLaborByDateRole
  // re-buckets on clock-in, and we filter the resulting cells back to [from, to].
  const { data: shifts } = await admin
    .from('shifts')
    .select('employee_id, date, start_time, end_time, source, source_rule_id, confirmed_at, break_minutes, clock_in_at, clock_out_at')
    .eq('user_id', user.id)
    .gte('date', shiftDays(from, -1))
    .lte('date', shiftDays(to, 1));

  // Host session fallback — wide UTC bound covering PST(-08) and PDT(-07); the cell filter trims edges.
  const { data: sessions } = await admin
    .from('live_sessions')
    .select('host_id, started_at, ended_at')
    .eq('user_id', user.id)
    .gte('started_at', `${from}T00:00:00-08:00`)
    .lte('started_at', `${to}T23:59:59-07:00`);

  const { cells } = computeLaborByDateRole(employees ?? [], shifts ?? [], sessions ?? []);
  const inWin = (d: string) => d >= from && d <= to;

  let hostCents = 0, hostHours = 0, fulCents = 0, fulHours = 0, pendingHours = 0, zeroRate = false;
  type DateRow = {
    date: string; host_cents: number; host_hours: number;
    fulfillment_cents: number; fulfillment_hours: number;
    unconfirmed_hours: number; basis: string; zero_rate_flag: boolean;
  };
  const byDate = new Map<string, DateRow>();
  const rowFor = (date: string): DateRow => {
    let r = byDate.get(date);
    if (!r) { r = { date, host_cents: 0, host_hours: 0, fulfillment_cents: 0, fulfillment_hours: 0, unconfirmed_hours: 0, basis: 'punch', zero_rate_flag: false }; byDate.set(date, r); }
    return r;
  };

  for (const c of cells) {
    if (!inWin(c.date)) continue;
    const row = rowFor(c.date);
    if (c.role === 'host') {
      hostCents += c.cents; hostHours += c.hours;
      row.host_cents += c.cents; row.host_hours += c.hours; row.basis = c.labor_basis;
      if (c.zero_rate_flag) { zeroRate = true; row.zero_rate_flag = true; }
    } else {
      fulCents += c.cents; fulHours += c.hours;
      row.fulfillment_cents += c.cents; row.fulfillment_hours += c.hours;
    }
    pendingHours += c.unconfirmed_hours_excluded;
    row.unconfirmed_hours += c.unconfirmed_hours_excluded;
  }

  const laborHours = hostHours + fulHours;
  const r2 = (n: number) => Math.round(n * 100) / 100;

  return NextResponse.json({
    period: { from, to, tz: TZ },
    host: { labor_cents: hostCents, hours: r2(hostHours), zero_rate_flag: zeroRate },
    fulfillment: { labor_cents: fulCents, hours: r2(fulHours) },
    pending: { hours: r2(pendingHours), pct: laborHours > 0 ? Math.round((pendingHours / laborHours) * 1000) / 10 : (pendingHours > 0 ? 100 : 0) },
    provisional: pendingHours > 0.10 * laborHours, // >10% of period labor hours awaiting confirmation
    by_date: [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)),
  });
}
