import { createAdminClient } from '@/lib/supabase/admin';

// TIMEOUT AUTO-ENDER — shared core (verified logic, moved here verbatim from the
// admin route so the manual POST and the scheduled cron call the SAME code path).
// Do NOT change the closing logic here: thresholds, next-session window bounding,
// multi-live detection, and the ended_at = last-capture write are all as verified.
//
// A session is "stale" when its most recent capture is older than IDLE_THRESHOLD.
// On close we stamp ended_at = that LAST CAPTURE (never now()). A session whose
// captures show a large internal gap is FLAGGED (multi-live) and never auto-closed.

export const IDLE_THRESHOLD_MIN = 45;   // no CAPTURES for this long ⇒ live is over (fallback signal)
export const MULTI_LIVE_GAP_HOURS = 6;  // an internal capture gap this large ⇒ separate lives
// HYBRID SIGNAL (added with the extension heartbeat): last_seen_at is a tab-alive ping
// written every ~45s while the live tab is open, so it keeps advancing through a no-sale
// lull (unlike captures). When a session HAS a last_seen_at we trust it and use this
// tighter threshold; when it's NULL (pre-heartbeat sessions) we fall back to the verified
// capture-idle logic below. Existing orphans that never heartbeated are handled by the
// one-time cleanup, not here.
export const AUTO_END_MINUTES = 10;     // no HEARTBEAT for this long ⇒ tab gone ⇒ live over

interface Session { id: string; user_id: string; store_id: string | null; started_at: string; ended_at: string | null; last_seen_at: string | null }

export interface AutoEndResult {
  dry_run: boolean;
  idle_threshold_minutes: number;
  multi_live_gap_hours: number;
  open_sessions: number;
  would_close_count: number;
  would_close: Record<string, unknown>[];
  multi_live_count: number;
  multi_live: Record<string, unknown>[];
  still_active_count: number;
  still_active: Record<string, unknown>[];
  no_captures_count: number;
  no_captures: Record<string, unknown>[];
  closed: number;
}

// Runs the sweep. write=false ⇒ compute-only (nothing written). write=true ⇒ close
// the would-close set. Throws on a DB read error (callers map to 500).
export async function autoEndSessions(opts: { write: boolean }): Promise<AutoEndResult> {
  const write = opts.write;
  const admin = createAdminClient();
  const nowMs = Date.now();

  // All sessions (need siblings to bound each capture window by the NEXT session start
  // for the same user+store — otherwise a session's window bleeds into later lives).
  const { data: allSessions, error: sErr } = await admin
    .from('live_sessions')
    .select('id, user_id, store_id, started_at, ended_at, last_seen_at')
    .order('started_at', { ascending: true });
  if (sErr) throw new Error(`sessions read failed: ${sErr.message}`);
  const sessions = (allSessions ?? []) as Session[];

  // next-session start per (user_id, store_id) scope.
  const nextStart = new Map<string, string | null>();
  const byScope = new Map<string, Session[]>();
  for (const s of sessions) {
    const k = `${s.user_id}|${s.store_id ?? ''}`;
    (byScope.get(k) ?? byScope.set(k, []).get(k)!).push(s);
  }
  for (const [, list] of byScope) {
    list.sort((a, b) => a.started_at.localeCompare(b.started_at));
    for (let i = 0; i < list.length; i++) nextStart.set(list[i].id, list[i + 1]?.started_at ?? null);
  }

  const open = sessions.filter((s) => !s.ended_at && s.started_at);

  const wouldClose: Record<string, unknown>[] = [];
  const multiLive: Record<string, unknown>[] = [];
  const stillActive: Record<string, unknown>[] = [];
  const noCaptures: Record<string, unknown>[] = [];

  for (const s of open) {
    const upper = nextStart.get(s.id) ?? null;
    // Ordered capture timestamps in [started_at, next_session_start | ∞), scoped by
    // user (+ store when known). Only created_at is needed.
    let q = admin
      .from('capture_events')
      .select('created_at')
      .eq('user_id', s.user_id)
      .gte('created_at', s.started_at)
      .order('created_at', { ascending: true });
    if (s.store_id) q = q.eq('store_id', s.store_id);
    if (upper) q = q.lt('created_at', upper);
    const { data: caps, error: cErr } = await q;
    if (cErr) throw new Error(`capture read failed: ${cErr.message}`);

    // HYBRID: last_seen_at (heartbeat) is the primary tab-alive signal when present.
    const hasHeartbeat = !!s.last_seen_at;
    const hbLastMs = hasHeartbeat ? new Date(s.last_seen_at as string).getTime() : NaN;
    const hbIdleMin = hasHeartbeat ? Math.round((nowMs - hbLastMs) / 60000) : null;

    const times = (caps ?? []).map((c) => new Date(c.created_at as string).getTime()).filter(Number.isFinite);
    if (times.length === 0) {
      // No captures → can only judge by heartbeat. A session that heartbeated then went
      // silent (tab closed) is closeable via last_seen_at; one that NEVER heartbeated is
      // left for the one-time cleanup (we can't tell if it's genuinely over).
      if (hasHeartbeat && (hbIdleMin as number) > AUTO_END_MINUTES) {
        wouldClose.push({
          id: s.id, store_id: s.store_id, started_at: s.started_at, captures: 0,
          signal: 'heartbeat', idle_minutes: hbIdleMin, last_seen_at: s.last_seen_at,
          proposed_ended_at: s.last_seen_at,
          duration_hours: +((hbLastMs - new Date(s.started_at).getTime()) / 3_600_000).toFixed(2),
        });
      } else if (hasHeartbeat) {
        stillActive.push({ id: s.id, store_id: s.store_id, started_at: s.started_at, captures: 0, signal: 'heartbeat', idle_minutes: hbIdleMin, note: `heartbeat ${hbIdleMin}m ago (< ${AUTO_END_MINUTES}m) — still live` });
      } else {
        noCaptures.push({ id: s.id, store_id: s.store_id, started_at: s.started_at });
      }
      continue;
    }

    const firstMs = times[0];
    const lastMs = times[times.length - 1];
    let maxGapMs = 0;
    for (let i = 1; i < times.length; i++) maxGapMs = Math.max(maxGapMs, times[i] - times[i - 1]);
    const distinctPtDays = new Set(
      times.map((t) => new Date(t).toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' })),
    ).size;

    const lastCaptureIso = new Date(lastMs).toISOString();
    const idleMin = Math.round((nowMs - lastMs) / 60000);
    const spanHours = +((lastMs - firstMs) / 3_600_000).toFixed(2);
    const maxGapHours = +(maxGapMs / 3_600_000).toFixed(2);
    const durationHours = +((lastMs - new Date(s.started_at).getTime()) / 3_600_000).toFixed(2);

    const base = {
      id: s.id, store_id: s.store_id, started_at: s.started_at,
      captures: times.length, span_hours: spanHours, max_gap_hours: maxGapHours,
      distinct_pt_days: distinctPtDays, last_capture_at: lastCaptureIso, idle_minutes: idleMin,
    };

    // Genuine multi-live = 2+ PT days AND a real internal gap (not just midnight crossing).
    // This safety guard stays FIRST and applies regardless of signal — a session spanning
    // separate lives needs a manual split, never an auto-close.
    if (distinctPtDays >= 2 && maxGapHours > MULTI_LIVE_GAP_HOURS) {
      multiLive.push({ ...base, last_seen_at: s.last_seen_at, reason: `internal gap ${maxGapHours}h across ${distinctPtDays} days — needs manual split` });
    } else if (hasHeartbeat) {
      // Primary signal: trust the heartbeat. ended_at = last_seen_at (last known alive).
      if ((hbIdleMin as number) > AUTO_END_MINUTES) {
        wouldClose.push({ ...base, signal: 'heartbeat', idle_minutes: hbIdleMin, last_seen_at: s.last_seen_at, proposed_ended_at: s.last_seen_at, duration_hours: +((hbLastMs - new Date(s.started_at).getTime()) / 3_600_000).toFixed(2) });
      } else {
        stillActive.push({ ...base, signal: 'heartbeat', idle_minutes: hbIdleMin, note: `heartbeat ${hbIdleMin}m ago (< ${AUTO_END_MINUTES}m) — still live` });
      }
    } else if (idleMin > IDLE_THRESHOLD_MIN) {
      // Fallback signal (no heartbeat yet): verified capture-idle logic, unchanged.
      wouldClose.push({ ...base, signal: 'capture', proposed_ended_at: lastCaptureIso, duration_hours: durationHours });
    } else {
      stillActive.push({ ...base, signal: 'capture', note: `last capture ${idleMin}m ago (< ${IDLE_THRESHOLD_MIN}m) — still live` });
    }
  }

  let closed = 0;
  if (write && wouldClose.length) {
    for (const w of wouldClose) {
      const { error } = await admin
        .from('live_sessions')
        .update({ status: 'ended', ended_at: w.proposed_ended_at as string, end_source: 'auto_ender' })
        .eq('id', w.id as string)
        .is('ended_at', null); // never overwrite an already-ended session
      if (error) console.error('[auto-end] update error', w.id, error.message);
      else closed++;
    }
  }

  return {
    dry_run: !write,
    idle_threshold_minutes: IDLE_THRESHOLD_MIN,
    multi_live_gap_hours: MULTI_LIVE_GAP_HOURS,
    open_sessions: open.length,
    would_close_count: wouldClose.length,
    would_close: wouldClose,
    multi_live_count: multiLive.length,
    multi_live: multiLive,
    still_active_count: stillActive.length,
    still_active: stillActive,
    no_captures_count: noCaptures.length,
    no_captures: noCaptures,
    closed: write ? closed : 0,
  };
}
