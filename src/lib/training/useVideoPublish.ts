'use client';

import { useCallback, useRef } from 'react';
import type { Room } from 'livekit-client';
import { PRACTICE_ROOM_OPTIONS } from '@/lib/training/media';

// Publishes the host's EXISTING camera track to LiveKit for the trainer preview,
// and RETURNS THE PUBLISHED TRACK SIDS.
//
// The SIDs are what a track-composite egress is defined by, so publish() now
// resolves with them instead of discarding the publishTrack results. Kept
// best-effort: a failed publish resolves null and the practice session carries on
// exactly as before — recording is additive, never a precondition.
// Best-effort: any failure is swallowed so the practice simulator keeps working.
// Does not acquire its own camera (no second getUserMedia) and does not own the
// device track (userProvidedTrack) — the simulator keeps full control of streamRef.
export interface PublishedTracks {
  videoTrackId: string;
  // null when the host has no microphone — the recording start route omits the
  // audio track entirely in that case rather than passing an empty id.
  audioTrackId: string | null;
}

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
    async (stream: MediaStream): Promise<PublishedTracks | null> => {
      const videoTrack = stream.getVideoTracks()[0];
      if (!videoTrack) return null;
      // Avoid duplicate rooms/connections if called again while connected.
      if (roomRef.current) await stop();
      try {
        const { Room, LocalVideoTrack, LocalAudioTrack, Track } = await import('livekit-client');

        const res = await fetch('/api/training/video-token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ role: 'host', session: sessionId }),
        });
        if (!res.ok) return null; // 401/403/500 (or middleware redirect) -> skip video silently
        const { token, url } = (await res.json()) as { token?: string; url?: string };
        if (!token || !url) return null;

        // dynacast lets the SFU pause simulcast layers nobody is watching, which
        // is the publisher half of the bandwidth fix (adaptiveStream on the
        // trainer side is the subscriber half — the two only pay off as a pair).
        // Without it every host uploads its full simulcast ladder regardless of
        // demand, which is the dominant Wi-Fi cost when ~20 hosts publish at once.
        const room = new Room(PRACTICE_ROOM_OPTIONS);
        roomRef.current = room;
        await room.connect(url, token);

        // Reuse the existing tracks; userProvidedTrack=true keeps device ownership
        // with the simulator (LiveKit won't stop/reacquire them).
        const localVideo = new LocalVideoTrack(videoTrack, undefined, true);
        const videoPub = await room.localParticipant.publishTrack(localVideo, {
          source: Track.Source.Camera,
          name: 'host-camera',
        });

        // Publish the existing mic track too, if present — best-effort / non-fatal.
        let audioTrackId: string | null = null;
        const audioTrack = stream.getAudioTracks()[0];
        if (audioTrack) {
          try {
            const localAudio = new LocalAudioTrack(audioTrack, undefined, true);
            const audioPub = await room.localParticipant.publishTrack(localAudio, {
              source: Track.Source.Microphone,
              name: 'host-mic',
            });
            audioTrackId = audioPub.trackSid || null;
          } catch {
            /* audio is best-effort; video already published */
          }
        }

        // The SIDs the egress request needs. Video is required; without it there
        // is nothing to record, so resolve null rather than a half-usable pair.
        return videoPub.trackSid ? { videoTrackId: videoPub.trackSid, audioTrackId } : null;
      } catch {
        // Video is non-fatal — ensure we don't leak a half-open room.
        await stop();
        return null;
      }
    },
    [sessionId, stop],
  );

  return { publish, stop };
}
