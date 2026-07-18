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
