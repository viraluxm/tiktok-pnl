'use client';

import { useCallback, useEffect, useRef } from 'react';
import {
  createPracticeLogBuffer,
  PRACTICE_LOG_FLUSH_MS,
  PRACTICE_LOG_MAX_BATCH,
  type PracticeEventKind,
} from '@/lib/training/practiceLog';

// Buffers the host's timeline and ships it to /api/admin/training/events.
//
// NON-FATAL THROUGHOUT. Practice must keep working when the log endpoint is
// unreachable, so every failure is swallowed — but a failed batch is REQUEUED
// rather than dropped, so a blip costs latency, not events.
//
// The clock is performance.now(), never Date.now(): offsets must be monotonic so a
// phone whose wall clock steps mid-session cannot desync the replay.
export function usePracticeLog(sessionId: string) {
  const bufferRef = useRef(createPracticeLogBuffer());
  const flushingRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startedRef = useRef(false);

  // Ships one batch. Serialised by flushingRef so a slow request cannot overlap
  // with the next tick and post the same events twice.
  const flush = useCallback(async () => {
    if (flushingRef.current) return;
    const batch = bufferRef.current.take(PRACTICE_LOG_MAX_BATCH);
    if (batch.length === 0) return;
    flushingRef.current = true;
    try {
      const res = await fetch('/api/admin/training/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: sessionId, events: batch }),
      });
      // A 4xx means this batch will NEVER be accepted (bad shape, or a session that
      // is not registered), so requeueing would retry it forever and block every
      // later event behind it. Drop it and move on. A 5xx or a network error is
      // transient, so put it back.
      if (!res.ok && res.status >= 500) bufferRef.current.requeue(batch);
    } catch {
      bufferRef.current.requeue(batch); // offline — retry on the next tick
    } finally {
      flushingRef.current = false;
    }
  }, [sessionId]);

  // Begins the timeline: sets the monotonic epoch, clears any previous buffer and
  // anchors the log with session_start at offset 0.
  const start = useCallback(() => {
    bufferRef.current.start(performance.now());
    startedRef.current = true;
    bufferRef.current.add('session_start', {}, performance.now());
  }, []);

  const event = useCallback((kind: PracticeEventKind, payload: Record<string, unknown> = {}) => {
    bufferRef.current.add(kind, payload, performance.now());
  }, []);

  // Closes the timeline and ships whatever is left immediately, rather than waiting
  // up to one flush interval while the session is already over.
  const finish = useCallback(() => {
    if (!startedRef.current) return;
    bufferRef.current.add('session_complete', {}, performance.now());
    startedRef.current = false;
    void flush();
  }, [flush]);

  // Periodic flush. One interval for the whole session; the buffer is what absorbs
  // event bursts between ticks.
  useEffect(() => {
    timerRef.current = setInterval(() => void flush(), PRACTICE_LOG_FLUSH_MS);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = null;
    };
  }, [flush]);

  // Last-chance delivery when the tab goes away. A normal fetch is cancelled during
  // unload, so this uses sendBeacon with an explicit application/json Blob (a bare
  // beacon would send text/plain). pagehide, not beforeunload/unload, is the event
  // that actually fires on iOS Safari — the platform the host screen runs on.
  useEffect(() => {
    const onPageHide = () => {
      const batch = bufferRef.current.take(PRACTICE_LOG_MAX_BATCH);
      if (batch.length === 0) return;
      try {
        const blob = new Blob([JSON.stringify({ session_id: sessionId, events: batch })], {
          type: 'application/json',
        });
        // If the beacon is refused (over the ~64KB budget) put the batch back, so a
        // later flush can still try — the tab may yet survive (pagehide also fires
        // when a page is merely frozen into the back/forward cache).
        if (!navigator.sendBeacon?.('/api/admin/training/events', blob)) {
          bufferRef.current.requeue(batch);
        }
      } catch {
        bufferRef.current.requeue(batch);
      }
    };
    window.addEventListener('pagehide', onPageHide);
    return () => window.removeEventListener('pagehide', onPageHide);
  }, [sessionId]);

  return { start, event, finish, flush };
}
