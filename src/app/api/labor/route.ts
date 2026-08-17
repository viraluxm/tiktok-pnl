import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { laWallTimeToUtc } from '@/lib/schedule/timezone';

export const dynamic = 'force-dynamic';

// Dashboard LABOR line for a period [from, to] (inclusive 'YYYY-MM-DD'):
//   • host labor  = SUM(bounded live_sessions duration in the window) × host hourly_rate — MEASURED
//                   observed worked time. Deliberately NOT the shifts/computePay path.
//   • packer labor = a MANUAL manager-entered figure (period_labor) — no reliable measured
//                    pack-time exists, so it is entered, not computed.
// GET returns both (+ what was excluded from the host measure). PUT upserts the packer figure.
//
// Duration bound: 10 min ≤ dur ≤ 11 h. The 11h ceiling matches the time-clock plausible-shift
// cap (genuine shifts top out ~10.5h) — one consistent threshold everywhere. The >11h exclusions
// are un-split multi-lives / forgotten-to-end sessions that would wildly overstate a single host's
// hours; they're reported (excluded_over_cap_*) so the host figure is honestly an UNDERCOUNT,
// never a silent one.
const MIN_H = 10 / 60;
const MAX_H = 11;
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

  // Sessions in the window, resolved from Pacific business dates to UTC instants. The offset is
  // looked up PER DATE (laWallTimeToUtc, DST-correct two-pass) rather than hardcoded: -07:00 is
  // PDT only, so from 2026-11-01 it moves both bounds an hour off and silently pulls the wrong
  // sessions into the period. Boundary semantics are otherwise unchanged.
  const { data: sessions } = await admin
    .from('live_sessions')
    .select('started_at, ended_at, last_seen_at')
    .eq('user_id', user.id)
    .gte('started_at', laWallTimeToUtc(from, '00:00:00').toISOString())
    .lte('started_at', laWallTimeToUtc(to, '23:59:59').toISOString());

  let hostHours = 0, excludedOverCapHours = 0, excludedOverCapCount = 0, excludedUnder10m = 0, counted = 0;
  for (const s of sessions ?? []) {
    const start = new Date(s.started_at as string).getTime();
    const endRaw = (s.ended_at as string | null) ?? (s.last_seen_at as string | null);
    if (!endRaw) continue;
    const dur = (new Date(endRaw).getTime() - start) / 3_600_000;
    if (dur > MAX_H) { excludedOverCapHours += dur; excludedOverCapCount += 1; continue; }
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
      excluded_over_cap_count: excludedOverCapCount,   // >11h un-split multi-lives → host figure is an undercount
      excluded_over_cap_hours: Math.round(excludedOverCapHours * 10) / 10,
      cap_hours: MAX_H,
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
