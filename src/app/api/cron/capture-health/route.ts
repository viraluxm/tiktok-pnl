import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { latestCaptureByStore } from '@/lib/live/captureActivity';
import { sendAlertSms } from '@/lib/live/alertSms';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// GET: capture-health DEAD-MAN'S SWITCH (Vercel cron, every 5 min — see vercel.json).
//
// Fires when a store's session heartbeat is FRESH (last_seen_at recent → the extension is alive)
// but captures have gone SILENT — the exact signature of "capture broke while the show is still
// live". This precedes the 45-min auto-ender close, so a human has runway to intervene before the
// session flips to 'ended' and the bind RPC starts refusing every auto-bind with SESSION_ENDED.
//
// THRESHOLDS — derived from a 7-day in-session capture-gap analysis (cross-store p99 ≈ 2.7 min;
// effectively zero legitimate traffic in the 3–45 min band):
//   heartbeat fresh = heartbeat_minutes < HEARTBEAT_FRESH_MIN (3)
//   capture silence = minutes_since (last capture) >= SILENCE_ALERT_MIN (15)
// DEDUP: skip a store whose capture_health_alerts.last_notified_at is within RENOTIFY_MIN (30).
//
// SAFETY RAMP (repo convention): SENDING is gated behind CAPTURE_ALERT_ENABLED === 'true'. When
// unset, the full check still runs and logs what it WOULD send (log-only). Recipient is the
// ALERT_SMS_TO env; if unset, log-only regardless.
//
// DEDUP is recorded (capture_health_alerts upsert) ONLY when a message is ACTUALLY sent. Log-only
// mode — and a send that fails (Twilio env absent / API error) — never touch the table, so
// enabling the flag can never be pre-suppressed by a dedup row the ramp wrote: the first real alert
// always fires. Log-only still logs that it WOULD have alerted and that dedup recording was skipped,
// so the ramp stays observable.
//
// SINGLE FLAG: this uses a self-contained sender (src/lib/live/alertSms.ts), NOT the scheduling SMS
// stack, so it is gated by ONE flag only — CAPTURE_ALERT_ENABLED — decoupled from shift SMS's
// SMS_SEND_ENABLED. A real text needs CAPTURE_ALERT_ENABLED==='true', ALERT_SMS_TO set, and the
// TWILIO_* env present (sendAlertSms logs-and-skips if Twilio env is missing).
const HEARTBEAT_FRESH_MIN = 3;
const SILENCE_ALERT_MIN = 15;
const RENOTIFY_MIN = 30;
const BUSINESS_TZ = 'America/Los_Angeles'; // server-fixed business tz (see CLAUDE.md)

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

  const admin = createAdminClient();
  const recipient = process.env.ALERT_SMS_TO?.trim() || '';
  const sendMode = process.env.CAPTURE_ALERT_ENABLED === 'true' && recipient !== '';
  const mode = sendMode ? 'SEND' : 'LOG_ONLY';

  const stores = await latestCaptureByStore(admin);
  const alerts: Array<{ store_id: string; minutes_silent: number; sent: boolean }> = [];

  for (const s of stores) {
    const heartbeatFresh = s.heartbeat_minutes != null && s.heartbeat_minutes < HEARTBEAT_FRESH_MIN;
    const silent = s.minutes_since != null && s.minutes_since >= SILENCE_ALERT_MIN;
    if (!heartbeatFresh || !silent) continue;

    const { data: store } = await admin.from('stores').select('name').eq('id', s.store_id).maybeSingle();
    const storeName = (store?.name as string | null) ?? s.store_id;
    const minutesSilent = Math.round(s.minutes_since as number);
    const lastCapPT = s.last_capture_at
      ? new Intl.DateTimeFormat('en-US', { timeZone: BUSINESS_TZ, hour: 'numeric', minute: '2-digit' }).format(new Date(s.last_capture_at))
      : 'unknown';
    const body = `Capture stalled: ${storeName} — no captures for ${minutesSilent} min (last ${lastCapPT} PT). Show may still be live.`;

    // LOG-ONLY: never touch capture_health_alerts, so enabling the flag can't be pre-suppressed by a
    // dedup row the ramp wrote. State clearly that it WOULD alert and that dedup recording was skipped.
    if (!sendMode) {
      console.log(`[cron/capture-health] WOULD_ALERT (log-only, dedup NOT recorded) store=${s.store_id} silent_min=${minutesSilent} to=${recipient || '(ALERT_SMS_TO unset)'} body=${JSON.stringify(body)}`);
      alerts.push({ store_id: s.store_id, minutes_silent: minutesSilent, sent: false });
      continue;
    }

    // SEND MODE: dedup against the last ACTUALLY-SENT alert.
    const { data: prior } = await admin
      .from('capture_health_alerts')
      .select('last_notified_at')
      .eq('store_id', s.store_id)
      .maybeSingle();
    if (prior?.last_notified_at) {
      const agoMin = (Date.now() - new Date(prior.last_notified_at as string).getTime()) / 60_000;
      if (agoMin < RENOTIFY_MIN) {
        console.log(`[cron/capture-health] SKIP_DEDUP store=${s.store_id} last_notified_min_ago=${Math.round(agoMin)}`);
        continue;
      }
    }

    const sent = await sendAlertSms(recipient, body, 'capture_health');
    if (sent) {
      // Record ONLY on a real send, so dedup reflects actual notifications — never log-only ticks.
      const nowIso = new Date().toISOString();
      await admin.from('capture_health_alerts').upsert({
        store_id: s.store_id,
        last_notified_at: nowIso,
        last_gap_min: minutesSilent,
        updated_at: nowIso,
      });
      console.log(`[cron/capture-health] ALERTED store=${s.store_id} silent_min=${minutesSilent}`);
    } else {
      // Send failed (Twilio env absent / API error): do NOT record → retries on the next tick.
      console.error(`[cron/capture-health] ALERT_SEND_FAILED store=${s.store_id} silent_min=${minutesSilent} — not recorded, will retry`);
    }
    alerts.push({ store_id: s.store_id, minutes_silent: minutesSilent, sent });
  }

  console.log(`[cron/capture-health] mode=${mode} stores_checked=${stores.length} alerted=${alerts.length}`);
  return NextResponse.json({ mode, stores_checked: stores.length, alerts });
}
