import 'server-only';
import { createAdminClient } from '@/lib/supabase/admin';

type Admin = ReturnType<typeof createAdminClient>;

// Window (minutes) under which a recent auction write is treated as "live likely active".
// Lifted verbatim from src/app/api/shipping/sync-tracking/route.ts so that route's informational
// write-gate reading is unchanged while the query becomes reusable.
const ACTIVITY_WINDOW_MIN = 15;

// Most-recent auction write across capture_events + live_auction_items → the deploy/write gate.
// GLOBAL (not per-store): this is sync-tracking's original inline implementation moved here
// UNCHANGED. Its shape and reading must stay identical — sync-tracking depends on it.
export async function writeGateStatus(admin: Admin) {
  const latest = async (table: string): Promise<number | null> => {
    const { data } = await admin.from(table).select('created_at').order('created_at', { ascending: false }).limit(1);
    const ts = data?.[0]?.created_at as string | undefined;
    return ts ? new Date(ts).getTime() : null;
  };
  const [capTs, itemTs] = await Promise.all([latest('capture_events'), latest('live_auction_items')]);
  const lastMs = Math.max(capTs ?? 0, itemTs ?? 0) || null;
  const minutesSince = lastMs ? (Date.now() - lastMs) / 60_000 : null;
  const blocked = minutesSince != null && minutesSince < ACTIVITY_WINDOW_MIN;
  return {
    checked: true, window_minutes: ACTIVITY_WINDOW_MIN,
    last_activity_at: lastMs ? new Date(lastMs).toISOString() : null,
    minutes_since: minutesSince != null ? Math.round(minutesSince * 10) / 10 : null,
    blocked, reason: blocked ? 'recent auction write — live likely active; writes refused' : 'quiet — safe to write',
  };
}

export interface StoreCaptureActivity {
  store_id: string;
  last_capture_at: string | null;   // most recent capture_events.created_at for the store
  minutes_since: number | null;     // minutes since last_capture_at (null if the store never captured)
  last_seen_at: string | null;      // freshest live_sessions.last_seen_at for the store
  heartbeat_minutes: number | null; // minutes since last_seen_at
}

// Per-store capture freshness + session-heartbeat freshness — the inputs to the capture-health
// dead-man's-switch. For each store with a live_sessions heartbeat in the last 24h (a bound on the
// scan; there are only a handful of stores), returns the freshest last_seen_at and the most recent
// capture_events.created_at, each with a minutes-since. The CALLER applies thresholds; this only
// reports. Contrast writeGateStatus above, which is global and answers a different question.
export async function latestCaptureByStore(admin: Admin): Promise<StoreCaptureActivity[]> {
  const now = Date.now();
  const sinceIso = new Date(now - 24 * 60 * 60_000).toISOString();

  // Recently-active stores, freshest heartbeat first.
  const { data: sessions } = await admin
    .from('live_sessions')
    .select('store_id, last_seen_at')
    .not('store_id', 'is', null)
    .gte('last_seen_at', sinceIso)
    .order('last_seen_at', { ascending: false });

  // First row per store wins (rows are last_seen_at DESC) → the store's freshest heartbeat.
  const freshest = new Map<string, string>();
  for (const r of sessions ?? []) {
    const sid = r.store_id as string | null;
    const seen = r.last_seen_at as string | null;
    if (sid && seen && !freshest.has(sid)) freshest.set(sid, seen);
  }

  const out: StoreCaptureActivity[] = [];
  for (const [store_id, last_seen_at] of freshest) {
    const { data: cap } = await admin
      .from('capture_events')
      .select('created_at')
      .eq('store_id', store_id)
      .order('created_at', { ascending: false })
      .limit(1);
    const lastCap = (cap?.[0]?.created_at as string | undefined) ?? null;
    out.push({
      store_id,
      last_capture_at: lastCap,
      minutes_since: lastCap ? (now - new Date(lastCap).getTime()) / 60_000 : null,
      last_seen_at,
      heartbeat_minutes: (now - new Date(last_seen_at).getTime()) / 60_000,
    });
  }
  return out;
}
