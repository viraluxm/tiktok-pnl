'use client';

import { useCallback, useRef } from 'react';
import type { Room } from 'livekit-client';

// Publishes the host's EXISTING camera track to LiveKit for the trainer preview.
// Best-effort: any failure is swallowed so the practice simulator keeps working.
// Does not acquire its own camera (no second getUserMedia) and does not own the
// device track (userProvidedTrack) — the simulator keeps full control of streamRef.
export function useVideoPublish(sessionId: string) {
  const roomRef = useRef<Room | null>(null);

  const stop = useCallback(async () => {
    const room = roomRef.current;
    roomRef.current = null;
    try {
      // disconnect() unpublishes; with userProvidedTrack it does NOT stop the
      // underlying camera MediaStreamTrack, so the simulator still owns it.
      if (room) await room.disconnect();
    } catch {
      /* non-fatal */
    }
  }, []);

  const publish = useCallback(
    async (track: MediaStreamTrack) => {
      if (!track) return;
      // Avoid duplicate rooms/connections if called again while connected.
      if (roomRef.current) await stop();
      try {
        const { Room, LocalVideoTrack, Track } = await import('livekit-client');

        const res = await fetch('/api/training/video-token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ role: 'host', session: sessionId }),
        });
        if (!res.ok) return; // 401/403/500 (or middleware redirect) -> skip video silently
        const { token, url } = (await res.json()) as { token?: string; url?: string };
        if (!token || !url) return;

        const room = new Room();
        roomRef.current = room;
        await room.connect(url, token);

        // Reuse the existing track; userProvidedTrack=true keeps device ownership
        // with the simulator (LiveKit won't stop/reacquire it).
        const localTrack = new LocalVideoTrack(track, undefined, true);
        await room.localParticipant.publishTrack(localTrack, {
          source: Track.Source.Camera,
          name: 'host-camera',
        });
      } catch {
        // Video is non-fatal — ensure we don't leak a half-open room.
        await stop();
      }
    },
    [sessionId, stop],
  );

  return { publish, stop };
}
