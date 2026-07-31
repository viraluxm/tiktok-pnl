import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { resolveChannels } from '@/lib/live/resolveChannels';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// GET: scheduled ROOM → OWNER channel resolver (Vercel cron — see vercel.json).
// Backfills channel_handle + channel_sec_uid on sessions the extension's DOM scrape
// missed, so the set_store_id trigger can derive the store. Runs OFF the auction/capture
// path against an authoritative source (@/lib/tiktok/roomOwner).
//
// SAFETY RAMP (mirrors auto-end-sessions): writes gated behind RESOLVE_CHANNELS_WRITE_ENABLED.
//   • unset / not "true" → LOG-ONLY: resolves + logs what it WOULD write, writes NOTHING.
//   • "true"             → actually persists handle/sec_uid/store + bookkeeping.
// Ship in log-only, watch the logs for a few days, then flip the env.
export async function GET(req: Request) {
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

  const writeEnabled = process.env.RESOLVE_CHANNELS_WRITE_ENABLED === 'true';

  try {
    const result = await resolveChannels({ write: writeEnabled });
    const mode = writeEnabled ? 'WRITE' : 'LOG_ONLY';
    console.log(
      `[cron/resolve-channels] mode=${mode} candidates=${result.candidates} resolved=${result.resolved} conflicts=${result.conflicts} handle_conflicts=${result.handle_conflicts} failed=${result.failed}`,
    );
    for (const o of result.outcomes) {
      console.log(`[cron/resolve-channels] ${o.action} ${JSON.stringify(o)}`);
    }
    return NextResponse.json({ mode: writeEnabled ? 'write' : 'log_only', ...result });
  } catch (e) {
    console.error('[cron/resolve-channels] error:', (e as Error).message);
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
