import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { autoEndSessions } from '@/lib/sessions/autoEnd';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// GET: scheduled TIMEOUT AUTO-ENDER (Vercel cron, every 30 min — see vercel.json).
// Calls the SAME verified core as the manual admin route (@/lib/sessions/autoEnd);
// this route only adds cron auth + the write safety-ramp + logging.
//
// SAFETY RAMP: writes are gated behind AUTO_END_WRITE_ENABLED.
//   • unset / anything but "true"  → LOG-ONLY (default): computes + logs what it WOULD
//     close and which sessions are FLAGGED multi-live, but writes NOTHING.
//   • "true"                       → actually closes the would-close set.
// The guards (idle < 45m never closed; internal gap > 6h flagged & skipped) live in
// the shared core and apply identically in both modes.
export async function GET(req: Request) {
  // ── Auth: only Vercel cron (Bearer CRON_SECRET) or a logged-in admin. Never public.
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.get('authorization');
  let authorized = false;
  if (cronSecret && authHeader === `Bearer ${cronSecret}`) {
    authorized = true; // Vercel cron invocation
  } else {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (user?.app_metadata?.role === 'admin') authorized = true; // admin manual trigger
  }
  if (!authorized) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // Safety ramp: default OFF (log-only) until explicitly enabled.
  const writeEnabled = process.env.AUTO_END_WRITE_ENABLED === 'true';

  try {
    const result = await autoEndSessions({ write: writeEnabled });
    const mode = writeEnabled ? 'WRITE' : 'LOG_ONLY';

    // Distinct, greppable logs for the watch period.
    console.log(
      `[cron/auto-end] mode=${mode} open=${result.open_sessions} would_close=${result.would_close_count} flagged_multi_live=${result.multi_live_count} closed=${result.closed}`,
    );
    for (const w of result.would_close) {
      console.log(`[cron/auto-end] ${writeEnabled ? 'CLOSED' : 'WOULD_CLOSE'} ${JSON.stringify({ id: w.id, proposed_ended_at: w.proposed_ended_at, idle_minutes: w.idle_minutes, duration_hours: w.duration_hours })}`);
    }
    for (const m of result.multi_live) {
      console.warn(`[cron/auto-end] FLAGGED_MULTI_LIVE (needs manual split, NOT closed) ${JSON.stringify({ id: m.id, max_gap_hours: m.max_gap_hours, distinct_pt_days: m.distinct_pt_days, idle_minutes: m.idle_minutes })}`);
    }

    return NextResponse.json({ mode: writeEnabled ? 'write' : 'log_only', ...result });
  } catch (e) {
    console.error('[cron/auto-end] error:', (e as Error).message);
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
