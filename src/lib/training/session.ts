// Shared, server-safe helpers for Practice Mode session isolation.
//
// A practice "session" is identified by a single UUID (from crypto.randomUUID()).
// That id flows launcher -> URL (?session=) -> Supabase Realtime channel ->
// LiveKit room -> per-session browser storage. Deriving every name from ONE
// validated id here (rather than hand-writing the prefixes at each call site) is
// what keeps two concurrent practice lives fully isolated.
//
// This module is intentionally pure (no React, no browser globals) so both the
// server (LiveKit token route) and the client can import it.

// Matches a canonical UUID (any version). crypto.randomUUID() emits v4, but we
// accept any valid UUID shape so a hand-copied link still works.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// True only for a well-formed session id. Everything else (missing, empty,
// arbitrary strings, the old shared "live-simulator-default") is rejected so we
// fail closed instead of silently joining a shared room.
export function isValidTrainingSessionId(sessionId: unknown): sessionId is string {
  return typeof sessionId === 'string' && UUID_RE.test(sessionId);
}

// Supabase Realtime channel for a session. Host + controller must derive the
// same name from the same id.
export function trainingRealtimeChannel(sessionId: string): string {
  return `trainer:${sessionId}`;
}

// LiveKit room for a session. Distinct prefix from the Realtime channel on
// purpose — the two systems are namespaced independently.
export function trainingLiveKitRoom(sessionId: string): string {
  return `training:${sessionId}`;
}

// Namespaces a browser-storage key to a single session so two tabs running
// different sessions can't clobber each other's persisted state.
export function trainingStorageKey(sessionId: string, key: string): string {
  return `training:${sessionId}:${key}`;
}

// Short, human-readable label shown on both screens so a trainer can confirm
// they're driving the right host (e.g. "abc12345").
export function shortTrainingSessionLabel(sessionId: string): string {
  return sessionId.slice(0, 8);
}

// ---- Practice Mode link builders -------------------------------------------
// SINGLE SOURCE OF TRUTH for the two screen URLs. The launcher's QR code and its
// "Copy Host Link" button both go through trainingHostUrl(), so the scanned URL
// and the copied URL can never drift apart. The session id is encoded via
// URLSearchParams so the query is always well-formed. Pure (no browser globals)
// so these stay unit-testable and server-safe.

export function trainingHostPath(sessionId: string): string {
  return `/admin/training/live-simulator?${new URLSearchParams({ session: sessionId }).toString()}`;
}

export function trainingControllerPath(sessionId: string): string {
  return `/admin/training/live-simulator/control?${new URLSearchParams({ session: sessionId }).toString()}`;
}

// Absolute URLs, resolved against a caller-supplied origin (pass
// window.location.origin in the browser) — never a hard-coded domain, and never
// an origin derived from untrusted input.
export function trainingHostUrl(origin: string, sessionId: string): string {
  return new URL(trainingHostPath(sessionId), origin).toString();
}

export function trainingControllerUrl(origin: string, sessionId: string): string {
  return new URL(trainingControllerPath(sessionId), origin).toString();
}

// ---- Launcher session index -------------------------------------------------
// The launcher's localStorage list is the ONLY place a practice session id is
// ever recorded (there is no DB and no server-side registry), so it must never
// silently drop an id: a dropped id means a still-running practice live with a
// published camera that can no longer be re-opened, QR'd or removed.
//
// These helpers are therefore NON-DESTRUCTIVE by design — they validate and
// de-duplicate but never truncate. An id leaves the list only when the admin
// explicitly removes it. There is no technical need for a cap: an id serialises
// to ~39 bytes, so even several hundred sessions stay far under the ~5 MiB
// origin quota (40 ids ≈ 1.5 KB ≈ 0.03%). Kept pure so they're unit-testable.

// Parse a raw localStorage value into a clean id list. Tolerates the previously
// capped arrays, junk entries and malformed JSON; order is preserved.
export function parseLauncherSessions(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.filter(isValidTrainingSessionId))];
  } catch {
    return [];
  }
}

// Newest-first insert. Re-adding an existing id moves it to the front rather
// than duplicating it. Never evicts.
export function addLauncherSession(existing: string[], sessionId: string): string[] {
  if (!isValidTrainingSessionId(sessionId)) return [...existing];
  return [sessionId, ...existing.filter((id) => id !== sessionId)];
}

// Explicit, single-item removal — the only way an id leaves the list.
export function removeLauncherSession(existing: string[], sessionId: string): string[] {
  return existing.filter((id) => id !== sessionId);
}
