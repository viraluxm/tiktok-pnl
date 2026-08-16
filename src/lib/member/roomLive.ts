import type { SupabaseClient } from '@supabase/supabase-js';

// Room-live lockout for the member binding flow.
//
// A retroactive bind that lands while a room is still selling corrupts that show's lot
// ordering: lensed_log_auction_as assigns `coalesce(max(sequence),0)+1` within the session, so a
// manual bind consumes the number the NEXT real lot would have taken and offsets every lot after
// it for the rest of the show. The advisory lock on the session id prevents a collision, so this
// fails silently — nothing errors, the numbering just drifts from the TikTok Seller SKU lot #.
//
// PREDICATE (see docs/investigations/binding-live-session-lockout.md, 2026-08-15 revision §R3):
//   A room is LOCKED when it has a session with ended_at IS NULL (or ended_at within the last
//   END_COOLDOWN_MS), AND that room has at least one capture_event within CAPTURE_BACKSTOP_MS.
//
// Keyed on room (tiktok_live_id) — the same key the extension's end signal is written by
// (extension/background.js handleLiveEnd: tiktok_live_id=eq.{room}&user_id=eq.{uid}&status=eq.live).
// Deliberately does NOT read `status` (goes stale while writes continue) or `last_seen_at`
// (19 sessions in 30 days heartbeat past their last capture by a median of 8.1h, max 9.35 days —
// using it as a liveness signal would freeze the queue for days).

// Cooldown after the end signal fires, covering capture ingest still in flight.
// PROVENANCE: across all 143 post-fix `live_ended` sessions (2026-07-22 → 08-15), only 3 capture
// rows landed after their session's ended_at, out of ~49,500 — p95 40.0s, p99 43.5s, MAX 44.4s.
// 5 min is 6.8x that observed maximum. Measured against the END SIGNAL, not against ordered_at:
// the ordered_at→created_at lag has a 1% straggler tail out to 23 min at p99, but those are
// re-captures of already-ended shows and belong to no open session.
export const END_COOLDOWN_MS = 5 * 60 * 1000;

// Backstop ceiling: releases a room whose end signal never fired (tab crash, machine sleep,
// unauthenticated or pre-v0.6.0 extension). Without it, a missing end signal locks orders forever.
// PROVENANCE: longest quiet stretch inside a HEALTHY show, measured over 49,486 intra-session
// capture gaps across the 143 post-fix `live_ended` sessions — p99 152s, p99.9 277s,
// MAX 2,024.3s (33.7 min). Gaps >15 min: 1. Gaps >30 min: 1. Gaps >60 min: ZERO.
// 60 min is 1.8x the observed maximum and has never been approached, so it cannot fire during a
// healthy show. Chosen over 90 min so it releases BEFORE the auto_ender cron's worst-case backfill
// (observed 36.1–74.3 min); at 90 min the cron would almost always pre-empt it and this would be
// dead code.
export const CAPTURE_BACKSTOP_MS = 60 * 60 * 1000;

const TZ = 'America/Los_Angeles'; // server-fixed business tz (see CLAUDE.md) — never a UTC offset

export type RoomSessionEnd = {
  id: string;
  ended_at: string | null;
  /** Operator-facing room identity. Present when resolved from live_sessions. */
  channel_handle?: string | null;
  store_name?: string | null;
};

export type RoomLockReason = 'open_session' | 'end_cooldown';

export interface RoomLock {
  room: string;
  locked: boolean;
  reason: RoomLockReason | null;
  session_id: string | null;
  ended_at: string | null;
  last_capture_at: string | null;
  /** When the lock is guaranteed to clear, ISO. For an open session this is the backstop ceiling
   *  (last capture + CAPTURE_BACKSTOP_MS) — a clean end clears it sooner, ~END_COOLDOWN_MS after. */
  clears_at: string | null;
  /** Operator-facing room name ("handle · store"), or null when nothing human is resolvable.
   *  NEVER the numeric room id — a bare tiktok_live_id means nothing to the person reading it.
   *  The machine-readable id stays on `room` and in the audit trail. */
  display: string | null;
}

/**
 * Operator-facing room name. "jumbosteals · Snore", degrading to "jumbosteals" when the store is
 * missing or unresolvable, and to null when there is nothing human to show. Never falls back to
 * the numeric room id, and never throws.
 */
export function roomDisplayName(
  handle: string | null | undefined,
  store: string | null | undefined,
): string | null {
  const h = typeof handle === 'string' ? handle.trim() : '';
  const s = typeof store === 'string' ? store.trim() : '';
  if (h && s) return `${h} · ${s}`;
  if (h) return h;
  return null;
}

const unlocked = (room: string, lastCaptureAt: string | null): RoomLock => ({
  room, locked: false, reason: null, session_id: null, ended_at: null,
  last_capture_at: lastCaptureAt, clears_at: null, display: null,
});

/**
 * Pure predicate. `sessions` are the room's sessions (any subset containing the open and
 * recently-ended ones); `lastCaptureAt` is the room's most recent capture_events.created_at.
 * Both are supplied by the caller so this stays testable without a database.
 */
export function evaluateRoomLock(
  room: string,
  sessions: RoomSessionEnd[],
  lastCaptureAt: string | null,
  nowMs: number,
): RoomLock {
  // BACKSTOP first: no capture in the last hour ⇒ released, whatever the session rows say.
  // This is what stops a never-fired end signal from locking an order indefinitely.
  const lastCapMs = lastCaptureAt ? Date.parse(lastCaptureAt) : NaN;
  if (!Number.isFinite(lastCapMs) || lastCapMs <= nowMs - CAPTURE_BACKSTOP_MS) {
    return unlocked(room, lastCaptureAt);
  }

  // An open session is the stronger statement, so it wins over a cooldown on another row.
  const open = sessions.find((s) => s.ended_at === null || s.ended_at === undefined);
  if (open) {
    return {
      room, locked: true, reason: 'open_session', session_id: open.id, ended_at: null,
      last_capture_at: lastCaptureAt,
      clears_at: new Date(lastCapMs + CAPTURE_BACKSTOP_MS).toISOString(),
      display: roomDisplayName(open.channel_handle, open.store_name),
    };
  }

  // Ended, but within the cooldown — ingest may still be settling. An unparseable ended_at is
  // treated as ended-long-ago (it cannot be "within the last 5 minutes"), never as open.
  let newest: { s: RoomSessionEnd; ms: number } | null = null;
  for (const s of sessions) {
    const ms = Date.parse(s.ended_at ?? '');
    if (!Number.isFinite(ms)) continue;
    if (ms > nowMs - END_COOLDOWN_MS && (!newest || ms > newest.ms)) newest = { s, ms };
  }
  if (newest) {
    return {
      room, locked: true, reason: 'end_cooldown', session_id: newest.s.id,
      ended_at: newest.s.ended_at, last_capture_at: lastCaptureAt,
      clears_at: new Date(newest.ms + END_COOLDOWN_MS).toISOString(),
      display: roomDisplayName(newest.s.channel_handle, newest.s.store_name),
    };
  }

  return unlocked(room, lastCaptureAt);
}

/**
 * Two-room decision. The room-only fallback lets a member pick a QUIET session while the order's
 * own room is still live, so both must be checked. The target session's room is reported first
 * when both are locked — it is the one the member explicitly chose.
 * A null room (the order has no resolvable room_id) is skipped, never treated as locked.
 */
export function pickRoomLock(
  targetRoom: string | null,
  orderRoom: string | null,
  locks: Map<string, RoomLock>,
): { lock: RoomLock; which: 'target_session' | 'order_room' } | null {
  const t = targetRoom ? locks.get(targetRoom) : undefined;
  if (t?.locked) return { lock: t, which: 'target_session' };
  const o = orderRoom ? locks.get(orderRoom) : undefined;
  if (o?.locked) return { lock: o, which: 'order_room' };
  return null;
}

const fmtPT = (iso: string | null): string => {
  if (!iso) return 'unknown';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return 'unknown';
  // Named timezone, never a fixed offset — DST-correct, and independent of the browser's locale
  // (the binding page renders in browser-local time until O1 ships; this string must not inherit
  // that bug, so it is formatted server-side and pinned to Pacific with an explicit tz label).
  return new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  }).format(new Date(ms));
};

/**
 * Operator-facing refusal text. Names the room the way the operator knows it ("handle · store"),
 * never by numeric room id — that lives on the response's `room` field and in the audit trail.
 * The "no later than" clause is load-bearing: when the extension is stale or unauthenticated and
 * `live_ended` never fires, the 60-minute capture backstop is the operator's ONLY signal that the
 * queue will free itself rather than being stuck forever.
 */
export function roomLockMessage(lock: RoomLock, which: 'target_session' | 'order_room'): string {
  const whose = which === 'target_session'
    ? 'The session you selected is in a room that is still live'
    : "This order's own room is still live";
  const subject = lock.display ?? 'That room';
  if (lock.reason === 'end_cooldown') {
    return `${whose}. ${subject} ended at ${fmtPT(lock.ended_at)}; binding unlocks at `
      + `${fmtPT(lock.clears_at)} once capture ingest settles.`;
  }
  return `${whose}. ${subject} has an open session (last capture ${fmtPT(lock.last_capture_at)}). `
    + `Binding unlocks about 5 minutes after the show ends, and no later than ${fmtPT(lock.clears_at)}.`;
}

/**
 * Resolve locks for the given rooms, owner-scoped. Two-stage so the hot table is only touched when
 * it can matter: fetch candidate sessions first (one query), then the last capture ONLY for rooms
 * that have an open or recently-ended session (at most one query per such room — the caller passes
 * at most two rooms). A room with no candidate session is unlocked without reading capture_events.
 *
 * SELECT-only. Throws on query error so the caller can fail closed rather than bind through a fault.
 */
export async function resolveRoomLocks(
  db: SupabaseClient,
  ownerUserId: string,
  rooms: Array<string | null | undefined>,
  nowMs: number = Date.now(),
): Promise<Map<string, RoomLock>> {
  const out = new Map<string, RoomLock>();
  const uniq = [...new Set(rooms.filter((r): r is string => !!r))];
  if (!uniq.length) return out;

  // Candidate sessions: open, or ended within the cooldown. Timestamps are double-quoted inside
  // .or() so ':' '.' and '+' stay literal in the PostgREST filter string.
  const cooldownCutoff = new Date(nowMs - END_COOLDOWN_MS).toISOString();
  const { data: sessRows, error: sessErr } = await db
    .from('live_sessions')
    .select('id, tiktok_live_id, ended_at, channel_handle, store_id')
    .eq('user_id', ownerUserId)
    .in('tiktok_live_id', uniq)
    .or(`ended_at.is.null,ended_at.gte."${cooldownCutoff}"`);
  if (sessErr) throw new Error(sessErr.message);
  if (!sessRows?.length) {
    for (const room of uniq) out.set(room, unlocked(room, null));
    return out;
  }

  // store_id → stores.name, so the refusal can name the room the way the operator knows it.
  // Same join /api/member/sessions does for the picker (sessions/route.ts) — one query, and only
  // for the handful of candidate sessions. A failure here degrades the LABEL, never the verdict:
  // the lock must not depend on cosmetics, so a store lookup error leaves the name as the handle.
  const storeIdsSeen = [...new Set(sessRows.map((r) => r.store_id).filter((x): x is string => !!x))];
  const storeName = new Map<string, string>();
  if (storeIdsSeen.length) {
    const { data: sts } = await db.from('stores').select('id, name').in('id', storeIdsSeen);
    for (const st of sts ?? []) storeName.set(String(st.id), String(st.name));
  }

  const byRoom = new Map<string, RoomSessionEnd[]>();
  for (const r of sessRows) {
    const room = String(r.tiktok_live_id);
    const list = byRoom.get(room) ?? [];
    list.push({
      id: String(r.id),
      ended_at: (r.ended_at as string | null) ?? null,
      channel_handle: (r.channel_handle as string | null) ?? null,
      store_name: r.store_id ? (storeName.get(String(r.store_id)) ?? null) : null,
    });
    byRoom.set(room, list);
  }

  const captureCutoff = new Date(nowMs - CAPTURE_BACKSTOP_MS).toISOString();
  for (const room of uniq) {
    const sessions = byRoom.get(room);
    if (!sessions?.length) { out.set(room, unlocked(room, null)); continue; }
    const { data: capRows, error: capErr } = await db
      .from('capture_events')
      .select('created_at')
      .eq('user_id', ownerUserId)
      .eq('room_id', room)
      .gte('created_at', captureCutoff)
      .order('created_at', { ascending: false })
      .limit(1);
    if (capErr) throw new Error(capErr.message);
    const lastCap = (capRows?.[0]?.created_at as string | undefined) ?? null;
    out.set(room, evaluateRoomLock(room, sessions, lastCap, nowMs));
  }
  return out;
}
