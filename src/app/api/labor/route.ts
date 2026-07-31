import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

// Dashboard LABOR line for a period [from, to] (inclusive 'YYYY-MM-DD'):
//   • host labor  = SUM(bounded live_sessions duration in the window) × host hourly_rate — MEASURED
//                   observed worked time. Deliberately NOT the shifts/computePay path.
//   • packer labor = a MANUAL manager-entered figure (period_labor) — no reliable measured
//                    pack-time exists, so it is entered, not computed.
// GET returns both (+ what was excluded from the host measure). PUT upserts the packer figure.
//
// Duration bound: 10 min ≤ dur ≤ 8 h. The >8h exclusions are un-split multi-lives that would
// wildly overstate a single host's hours; they're reported (excluded_over_8h_*) so the host
// figure is honestly an UNDERCOUNT, never a silent one.
const MIN_H = 10 / 60;
const MAX_H = 8;
const TZ = 'America/Los_Angeles';

export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const from = searchParams.get('from');
  const to = searchParams.get('to');
  if (!from || !to) return NextResponse.json({ error: 'from and to are required' }, { status: 400 });

  const admin = createAdminClient();

  // Host rate — uniform in practice; take the (min) host rate as the applied rate and flag if hosts differ.
  const { data: hostRows } = await admin.from('employees').select('hourly_rate').eq('user_id', user.id).eq('role', 'host');
  const rates = [...new Set((hostRows ?? []).map((r) => Number(r.hourly_rate) || 0).filter((r) => r > 0))];
  const hostRate = rates.length ? Math.min(...rates) : 0;
  const hostRatesDiffer = rates.length > 1;

  // Sessions in the window (Pacific date), with duration; sum only the bounded ones.
  const { data: sessions } = await admin
    .from('live_sessions')
    .select('started_at, ended_at, last_seen_at')
    .eq('user_id', user.id)
    .gte('started_at', `${from}T00:00:00-07:00`)
    .lte('started_at', `${to}T23:59:59-07:00`);

  let hostHours = 0, excludedOver8hHours = 0, excludedOver8hCount = 0, excludedUnder10m = 0, counted = 0;
  for (const s of sessions ?? []) {
    const start = new Date(s.started_at as string).getTime();
    const endRaw = (s.ended_at as string | null) ?? (s.last_seen_at as string | null);
    if (!endRaw) continue;
    const dur = (new Date(endRaw).getTime() - start) / 3_600_000;
    if (dur > MAX_H) { excludedOver8hHours += dur; excludedOver8hCount += 1; continue; }
    if (dur < MIN_H) { excludedUnder10m += 1; continue; }
    hostHours += dur; counted += 1;
  }
  const hostLaborCents = Math.round(hostHours * hostRate * 100);

  // Manual packer figure for this exact period (owner-scoped read is fine; use admin for consistency).
  const { data: pl } = await admin
    .from('period_labor')
    .select('packer_labor_cents, note, updated_at')
    .eq('user_id', user.id).eq('period_start', from).eq('period_end', to)
    .maybeSingle();

  return NextResponse.json({
    period: { from, to, tz: TZ },
    host: {
      labor_cents: hostLaborCents,
      hours: Math.round(hostHours * 10) / 10,
      rate_dollars: hostRate,
      rates_differ: hostRatesDiffer,     // if true, hostRate is the MIN and the figure undercounts
      sessions_counted: counted,
      excluded_over_8h_count: excludedOver8hCount,   // un-split multi-lives → host figure is an undercount
      excluded_over_8h_hours: Math.round(excludedOver8hHours * 10) / 10,
      excluded_under_10m: excludedUnder10m,
    },
    packer: {
      labor_cents: Number(pl?.packer_labor_cents) || 0,
      note: (pl?.note as string | null) ?? null,
      updated_at: (pl?.updated_at as string | null) ?? null,
      entered: pl != null,               // false → no figure entered yet for this period
    },
  });
}

export async function PUT(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: { from?: string; to?: string; packer_labor_cents?: number; note?: string };
  try { body = await request.json(); } catch { return NextResponse.json({ error: 'Expected JSON body' }, { status: 400 }); }
  const { from, to } = body;
  if (!from || !to) return NextResponse.json({ error: 'from and to are required' }, { status: 400 });
  const cents = Math.max(0, Math.trunc(Number(body.packer_labor_cents) || 0));

  const admin = createAdminClient();
  const { error } = await admin.from('period_labor').upsert(
    { user_id: user.id, period_start: from, period_end: to, packer_labor_cents: cents, note: body.note ?? null, updated_at: new Date().toISOString() },
    { onConflict: 'user_id,period_start,period_end' },
  );
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, packer_labor_cents: cents });
}
