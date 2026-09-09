'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { PRACTICE_HEARTBEAT_MS } from '@/lib/training/registry';
import type { PracticeEndpoints } from '@/lib/training/transport';

// Reports a running host's liveness to the session registry (migration 136).
//
// SELF-THROTTLING BY DESIGN. `beat()` is safe to call as often as the caller
// likes; it sends at most one request per PRACTICE_HEARTBEAT_MS. That is what lets
// the host ride its EXISTING per-second session tick instead of adding a timer —
// one fewer interval to leak, and the heartbeat automatically stops when the
// session clock stops.
//
// NON-FATAL, ALWAYS. Practice must keep working when the registry is unreachable:
// every failure is swallowed. Liveness is derived from last_seen_at freshness, so a
// missed beat costs a label in the launcher, never the session itself.
export function usePracticeHeartbeat(sessionId: string, endpoints: PracticeEndpoints) {
  // TRUE once the registry has said 404 — this session id is not registered (a
  // hand-typed or stale link). Surfaced to the host, because otherwise the session
  // would run fine while being invisible in every manager's launcher.
  const [unregistered, setUnregistered] = useState(false);

  const lastBeatRef = useRef(0);
  const inFlightRef = useRef(false);
  const endedRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Reset the per-session REFS if this hook is ever reused across ids, so a new
  // session cannot inherit the previous one's throttle timestamp or its "ended"
  // latch. Refs only: `unregistered` is deliberately NOT reset here, because the
  // next successful beat clears it anyway (see beat below) and setting state
  // synchronously in an effect is a cascading render the linter rightly rejects.
  useEffect(() => {
    lastBeatRef.current = 0;
    endedRef.current = false;
  }, [sessionId]);

  const beat = useCallback(() => {
    if (endedRef.current) return; // a cleanly ended session must not re-open itself
    const now = Date.now();
    if (now - lastBeatRef.current < PRACTICE_HEARTBEAT_MS) return;
    // Guard against overlap: a slow request must not queue a second one behind it.
    if (inFlightRef.current) return;
    lastBeatRef.current = now;
    inFlightRef.current = true;

    void fetch(endpoints.heartbeat, { method: 'POST' })
      .then((res) => {
        if (!mountedRef.current) return;
        // An expired session is 307'd to /login by middleware, and fetch follows
        // that, so this arrives as a 200 with an HTML body. Treat a redirect as
        // "no answer from the API" — never as a successful beat.
        if (res.redirected) return;
        // Only 404 is meaningful: the id is not in the registry. A 401/403/500 is a
        // transient or environmental problem and must not accuse the session.
        if (res.status === 404) setUnregistered(true);
        else if (res.ok) setUnregistered(false);
      })
      .catch(() => {
        /* offline / blocked — non-fatal, the next tick retries */
      })
      .finally(() => {
        inFlightRef.current = false;
      });
  }, [endpoints.heartbeat]);

  // Marks the session cleanly finished. Idempotent server-side (the first
  // ended_at wins), and latching endedRef stops any further beats from re-opening
  // it before the component unmounts.
  const end = useCallback(() => {
    if (endedRef.current) return;
    endedRef.current = true;
    void fetch(endpoints.end, { method: 'POST' }).catch(() => {
      /* non-fatal: an un-ended session decays to 'stale' on its own */
    });
  }, [endpoints.end]);

  // Best-effort finish when the tab goes away. A normal fetch is cancelled during
  // unload, so this uses sendBeacon, which the browser delivers after teardown.
  // The end route takes no body, which is exactly what a bodyless beacon POSTs.
  //
  // pagehide (not beforeunload/unload) is the event that actually fires on iOS
  // Safari — the platform the host screen runs on.
  useEffect(() => {
    const onPageHide = () => {
      if (endedRef.current) return;
      endedRef.current = true;
      try {
        navigator.sendBeacon?.(endpoints.end);
      } catch {
        /* ignore */
      }
    };
    window.addEventListener('pagehide', onPageHide);
    return () => window.removeEventListener('pagehide', onPageHide);
  }, [endpoints.end]);

  return { beat, end, unregistered };
}
