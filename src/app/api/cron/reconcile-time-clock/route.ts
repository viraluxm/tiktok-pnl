import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// GET: time-clock RECONCILER (Vercel cron — see vercel.json). Backstop for the two ways a
// punch can otherwise lose pay, since lensed_clock_out is the ONLY (atomic, no self-heal) shift
// creator:
//   (a) a forgotten clock-out (open punch) → auto-closed at the cap into a FLAGGED shift, so
//       the time is captured for review instead of silently dropped;
//   (b) a closed punch with no shift (orphaned by any non-RPC close) → the missing shift is
//       backfilled and linked.
// Calls public.lensed_reconcile_time_clock (SECURITY DEFINER; acts across all users).
//
// SAFETY RAMP (mirrors auto-end-sessions): writes gated behind TIME_CLOCK_RECONCILE_WRITE_ENABLED.
//   • unset / not "true" → LOG-ONLY: reports what it WOULD reconcile, writes nothing.
//   • "true"             → runs the reconcile RPC.
export async function GET(req: Request) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.get('authorization');
  let authorized = false;
  if (cronSecret && authHeader === `Bearer ${cronSecret}`) {
    authorized = true; // Vercel cron
  } else {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (user?.app_metadata?.role === 'admin') authorized = true; // admin manual trigger
  }
  if (!authorized) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const maxOpenHours = Math.max(1, Math.trunc(Number(process.env.TIME_CLOCK_MAX_OPEN_HOURS) || 16));
  const writeEnabled = process.env.TIME_CLOCK_RECONCILE_WRITE_ENABLED === 'true';
  const admin = createAdminClient();

  try {
    // Log-only preview: count the two candidate sets without writing.
    const [{ count: staleOpen }, { count: orphanClosed }] = await Promise.all([
      admin.from('employee_time_entries').select('id', { count: 'exact', head: true })
        .is('clocked_out_at', null).lt('clocked_in_at', new Date(Date.now() - maxOpenHours * 3_600_000).toISOString()),
      admin.from('employee_time_entries').select('id', { count: 'exact', head: true })
        .not('clocked_out_at', 'is', null).is('shift_id', null),
    ]);

    if (!writeEnabled) {
      console.log(`[cron/reconcile-time-clock] LOG_ONLY would_auto_close=${staleOpen ?? 0} would_backfill=${orphanClosed ?? 0} (max_open_hours=${maxOpenHours})`);
      return NextResponse.json({ mode: 'log_only', would_auto_close: staleOpen ?? 0, would_backfill: orphanClosed ?? 0, max_open_hours: maxOpenHours });
    }

    const { data, error } = await admin.rpc('lensed_reconcile_time_clock', { p_max_open_hours: maxOpenHours });
    if (error) throw new Error(error.message);
    console.log(`[cron/reconcile-time-clock] WRITE ${JSON.stringify(data)} (max_open_hours=${maxOpenHours})`);
    return NextResponse.json({ mode: 'write', ...(data as object), max_open_hours: maxOpenHours });
  } catch (e) {
    console.error('[cron/reconcile-time-clock] error:', (e as Error).message);
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
