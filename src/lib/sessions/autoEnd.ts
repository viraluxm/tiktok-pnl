import { createAdminClient } from '@/lib/supabase/admin';
import { readAllPaged } from '@/lib/db/readAll';

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
  // ── HOST SEGMENTS (migration 106/108/110/112) ──────────────────────────────────────
  // A session that ends with an OPEN host segment leaves that segment open forever. The read
  // path bounds it (lensed_session_activity_end ceilings it at the last sale, so it cannot
  // credit a host past their last sale), but "open" still reads as "currently selling".
  // Closing it here is the only server-side path that ever does.
  segment_close_write_enabled: boolean;
  segments_would_close_count: number;
  segments_would_close: Record<string, unknown>[];
  segments_closed: number;
  segment_close_errors: Record<string, unknown>[];
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
    //
    // PAGED. This read was unbounded, and PostgREST silently caps a response at 1000 rows —
    // which here was the worst possible truncation. Ordered ASCENDING, a short read drops the
    // most RECENT captures: precisely the ones that prove a session is still running. The gap
    // logic below would then see the stream stop early and auto-end a LIVE show, shortening
    // its duration and the host hours derived from it.
    //
    // A busy show already reaches this: the largest in the last 30 days holds 1,049 auction
    // items, and at 5x volume most shows would.
    //
    // The builder is rebuilt per page rather than reused with a fresh .range(): reusing one
    // instance would rely on .range() mutating it in place, and a builder that quietly kept
    // its first range would return page 1 forever.
    const caps = await readAllPaged(
      (from, to) => {
        let q = admin
          .from('capture_events')
          .select('created_at')
          .eq('user_id', s.user_id)
          .gte('created_at', s.started_at)
          .order('created_at', { ascending: true });
        if (s.store_id) q = q.eq('store_id', s.store_id);
        if (upper) q = q.lt('created_at', upper);
        return q.range(from, to);
      },
      `autoEnd captures for session ${s.id}`,
    ).catch((e: unknown) => {
      throw new Error(`capture read failed: ${e instanceof Error ? e.message : String(e)}`);
    });

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
          // user_id is REQUIRED here as well as in `base`: this branch builds its own object
          // rather than spreading base, and the service-role segment close needs the owner.
          // Without it p_owner_user_id arrives undefined and the RPC raises OWNER_REQUIRED —
          // swallowed as non-fatal, so the segment would silently stay open.
          id: s.id, user_id: s.user_id, store_id: s.store_id, started_at: s.started_at, captures: 0,
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
      id: s.id, user_id: s.user_id, store_id: s.store_id, started_at: s.started_at,
      captures: times.length, span_hours: spanHours, max_gap_hours: maxGapHours,
      distinct_pt_days: distinctPtDays, last_capture_at: lastCaptureIso, idle_minutes: idleMin,
    };

    // Genuine multi-live = 2+ PT days AND a real internal gap (not just midnight crossing).
    // This safety guard stays FIRST and applies regardless of signal — a session spanning
    // separate lives needs a manual split, never an auto-close.
    if (distinctPtDays >= 2 && maxGapHours > MULTI_LIVE_GAP_HOURS) {
      multiLive.push({ ...base, last_seen_at: s.last_seen_at, reason: `internal gap ${maxGapHours}h across ${distinctPtDays} days — needs manual split` });
    } else if (hasHeartbeat) {
      // Primary signal: the heartbeat. BUT a stalled heartbeat with ONGOING captures is a spurious
      // gap (service-worker restart — observed 302 in one session), NOT a dead show. Closing it
      // would end a live SELLING session and, because the extension's live auto-bind never sets
      // p_manual, refuse every subsequent bind with SESSION_ENDED (the 177-orphan failure by another
      // route). CAPTURE-FRESHNESS GUARD (mirrors migration 078's tab_closed rule): only auto-close
      // when captures are ALSO stale (> IDLE_THRESHOLD_MIN). ended_at = the later of last heartbeat
      // and last capture (true last-known-alive).
      const heartbeatStale = (hbIdleMin as number) > AUTO_END_MINUTES;
      const capturesStale = idleMin > IDLE_THRESHOLD_MIN;
      if (heartbeatStale && capturesStale) {
        const endMs = Math.max(hbLastMs, lastMs);
        wouldClose.push({ ...base, signal: 'heartbeat+capture', idle_minutes: hbIdleMin, capture_idle_minutes: idleMin, last_seen_at: s.last_seen_at, proposed_ended_at: new Date(endMs).toISOString(), duration_hours: +((endMs - new Date(s.started_at).getTime()) / 3_600_000).toFixed(2) });
      } else if (heartbeatStale) {
        // Heartbeat stale but captures fresh ⇒ spurious gap; the show is selling — keep it live.
        stillActive.push({ ...base, signal: 'capture_fresh_override', idle_minutes: hbIdleMin, capture_idle_minutes: idleMin, note: `heartbeat ${hbIdleMin}m stale but last capture ${idleMin}m ago (< ${IDLE_THRESHOLD_MIN}m) — still selling, kept live` });
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

  // ── HOST SEGMENTS: what WOULD be closed ───────────────────────────────────────────────
  // Computed for the dry run too, so the report is inspectable before the flag ever flips.
  // Scoped to the wouldClose set ONLY — multiLive sessions are flagged for manual split and
  // never auto-closed, so their segments are deliberately left open.
  const segmentCloseWriteEnabled = process.env.SEGMENT_CLOSE_WRITE_ENABLED === 'true';
  const segmentsWouldClose: Record<string, unknown>[] = [];
  if (wouldClose.length) {
    const ids = wouldClose.map((w) => w.id as string);
    const { data: openSegs, error: segErr } = await admin
      .from('live_session_host_segments')
      .select('id, session_id, host_id, started_at')
      .in('session_id', ids)
      .is('ended_at', null)
      .is('superseded_by', null);
    if (segErr) {
      // Read failure here must not sink the sweep — sessions still end.
      console.error('[auto-end] open-segment read failed (non-fatal):', segErr.message);
    } else {
      const byId = new Map(wouldClose.map((w) => [w.id as string, w]));
      for (const seg of (openSegs ?? []) as Array<{ id: string; session_id: string; host_id: string | null; started_at: string }>) {
        const w = byId.get(seg.session_id);
        if (!w) continue;
        const proposed = w.proposed_ended_at as string;
        const segStartMs = new Date(seg.started_at).getTime();
        const proposedMs = new Date(proposed).getTime();
        segmentsWouldClose.push({
          session_id: seg.session_id,
          owner_user_id: w.user_id as string,
          segment_id: seg.id,
          host_id: seg.host_id,
          segment_started_at: seg.started_at,
          // proposed_ended_at, NOT now(). autoEnd trims the idle tail off a session; now()
          // would hand the host every minute of the gap being trimmed.
          proposed_ended_at: proposed,
          resulting_duration_minutes: Math.round(((proposedMs - segStartMs) / 60000) * 100) / 100,
          inverted: proposedMs < segStartMs,
        });
      }
    }
  }

  let closed = 0;
  let segmentsClosed = 0;
  const segmentCloseErrors: Record<string, unknown>[] = [];
  if (write && wouldClose.length) {
    for (const w of wouldClose) {
      const { error } = await admin
        .from('live_sessions')
        .update({ status: 'ended', ended_at: w.proposed_ended_at as string, end_source: 'auto_ender' })
        .eq('id', w.id as string)
        .is('ended_at', null); // never overwrite an already-ended session
      if (error) { console.error('[auto-end] update error', w.id, error.message); continue; }
      closed++;

      // ── SEGMENT CLOSE — best-effort, non-fatal, AFTER the session actually ended ────────
      // Deliberately not awaited into the session's success/failure accounting: `closed` is
      // already incremented above, so nothing below can stop a session from being ended. A
      // segment-close failure is recorded and the sweep continues to the next session.
      //
      // close_session_host_segment_AS, not the auth.uid() variant: this runs from a
      // CRON_SECRET-gated route via createAdminClient(), where auth.uid() is NULL and the
      // user-facing RPC could only ever raise SESSION_NOT_FOUND_OR_NOT_OWNED.
      if (!segmentCloseWriteEnabled) continue;
      const seg = segmentsWouldClose.find((x) => x.session_id === (w.id as string));
      if (!seg) continue;
      try {
        // rpc-grants: close_session_host_segment_as
        const { error: rpcErr } = await admin.rpc('close_session_host_segment_as', {
          p_owner_user_id: w.user_id as string,
          p_session_id: w.id as string,
          p_at: w.proposed_ended_at as string,
          p_source: 'session_end',
        });
        if (rpcErr) {
          segmentCloseErrors.push({ session_id: w.id, segment_id: seg.segment_id, error: rpcErr.message });
          console.error('[auto-end] segment close failed (non-fatal)', w.id, rpcErr.message);
        } else {
          segmentsClosed++;
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        segmentCloseErrors.push({ session_id: w.id, segment_id: seg.segment_id, error: msg });
        console.error('[auto-end] segment close threw (non-fatal)', w.id, msg);
      }
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
    segment_close_write_enabled: segmentCloseWriteEnabled,
    segments_would_close_count: segmentsWouldClose.length,
    segments_would_close: segmentsWouldClose,
    segments_closed: write ? segmentsClosed : 0,
    segment_close_errors: segmentCloseErrors,
  };
}
