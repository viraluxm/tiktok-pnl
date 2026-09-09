'use client';

import { useCallback, useRef, useState } from 'react';
import type { PublishResult } from '@/lib/training/useVideoPublish';
import type { PracticeEndpoints } from '@/lib/training/transport';

// Starts and stops the server-side recording for one practice session.
//
// NON-FATAL, LIKE EVERY OTHER PRACTICE PATH: a session must run even if recording
// cannot start. But UNLIKE the live preview, a recording failure is SURFACED —
// `state` drives a visible indicator, because a silently-unrecorded audition is
// the exact outcome this feature exists to prevent.
export type RecordingState =
  | { kind: 'idle' }
  | { kind: 'dry-run' } // flag off: the server reported the plan and wrote nothing
  | { kind: 'recording' }
  | { kind: 'failed'; reason: string };

export function usePracticeRecording(sessionId: string, endpoints: PracticeEndpoints) {
  const [state, setState] = useState<RecordingState>({ kind: 'idle' });
  // Latched so a retry or a double-mount cannot start two egresses for one run.
  const startedRef = useRef(false);

  const start = useCallback(
    async (published: PublishResult) => {
      if (startedRef.current) return;
      // Carry the publisher's OWN reason through. "Video did not connect" was true
      // but useless — it named the symptom, not the cause, and the cause is the
      // only thing that lets anyone fix it mid-session.
      if (!published.ok) {
        setState({ kind: 'failed', reason: published.reason });
        return;
      }
      const tracks = published.tracks;
      startedRef.current = true;
      try {
        // session_id is included only in admin mode; the tokenised route takes the
        // session from its path and must not accept one from the body.
        const res = await fetch(endpoints.recordingStart, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...(endpoints.mode === 'admin' ? { session_id: sessionId } : {}),
            video_track_id: tracks.videoTrackId,
            audio_track_id: tracks.audioTrackId,
          }),
        });
        // An expired session is 307'd to /login by middleware and arrives as a 200
        // with HTML, so res.ok alone cannot be trusted here (same trap as the
        // registry hooks).
        if (res.redirected) {
          setState({ kind: 'failed', reason: 'Sign-in expired — recording not started.' });
          return;
        }
        const body = (await res.json().catch(() => null)) as
          | { dry_run?: boolean; recording_id?: string; error?: string; detail?: string; missing?: string[] }
          | null;
        if (!res.ok) {
          const reason =
            body?.missing?.length
              ? `Recording not configured (${body.missing.join(', ')})`
              : body?.detail || body?.error || `Could not start recording (${res.status})`;
          setState({ kind: 'failed', reason });
          return;
        }
        setState(body?.dry_run ? { kind: 'dry-run' } : { kind: 'recording' });
      } catch (err) {
        setState({
          kind: 'failed',
          reason: err instanceof Error ? err.message : 'Could not reach the recorder.',
        });
      }
    },
    [sessionId, endpoints],
  );

  // Asks egress to stop. Fire-and-forget: LiveKit finalises on its own when the
  // room empties, and the webhook is what actually completes the row — so a failure
  // here costs nothing.
  const stop = useCallback(() => {
    if (!startedRef.current) return;
    startedRef.current = false;
    void fetch(endpoints.recordingStop, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(endpoints.recordingStopBody),
    }).catch(() => {
      /* LiveKit finalises when the room empties */
    });
  }, [endpoints]);

  return { state, start, stop };
}
