'use client';

import { useCallback, useRef } from 'react';
import type { Room } from 'livekit-client';
import { PRACTICE_ROOM_OPTIONS, PRACTICE_VIDEO_ENCODING } from '@/lib/training/media';
import type { PracticeEndpoints } from '@/lib/training/transport';

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
// Why a publish did not happen. The old code returned void and swallowed every
// failure in a bare catch, which is why "Waiting for host video…" was the only
// symptom available for a fault anywhere between the token route and the SFU.
// Recording made that unacceptable: a host must be told WHY nothing is recording.
export type PublishResult =
  | { ok: true; tracks: PublishedTracks }
  | { ok: false; reason: string };

export interface PublishedTracks {
  videoTrackId: string;
  // null when the host has no microphone — the recording start route omits the
  // audio track entirely in that case rather than passing an empty id.
  audioTrackId: string | null;
}

export function useVideoPublish(sessionId: string, endpoints: PracticeEndpoints) {
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
    async (stream: MediaStream): Promise<PublishResult> => {
      const videoTrack = stream.getVideoTracks()[0];
      if (!videoTrack) return { ok: false, reason: 'no camera track' };
      // Avoid duplicate rooms/connections if called again while connected.
      if (roomRef.current) await stop();
      try {
        const { Room, LocalVideoTrack, LocalAudioTrack, Track } = await import('livekit-client');

        const res = await fetch(endpoints.livekitToken.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(endpoints.livekitToken.body),
        });
        // An expired session is 307'd to /login by middleware and, because fetch
        // follows redirects, arrives as a 200 with HTML — res.ok would be TRUE.
        if (res.redirected) return { ok: false, reason: 'sign-in expired' };
        if (!res.ok) {
          return {
            ok: false,
            reason:
              res.status === 403
                ? 'this account is not an admin'
                : res.status === 500
                  ? 'LiveKit is not configured on the server'
                  : `video token failed (${res.status})`,
          };
        }
        const { token, url } = (await res.json()) as { token?: string; url?: string };
        if (!token || !url) return { ok: false, reason: 'video token was empty' };

        // dynacast lets the SFU pause simulcast layers nobody is watching, which
        // is the publisher half of the bandwidth fix (adaptiveStream on the
        // trainer side is the subscriber half — the two only pay off as a pair).
        // Without it every host uploads its full simulcast ladder regardless of
        // demand, which is the dominant Wi-Fi cost when ~20 hosts publish at once.
        const room = new Room(PRACTICE_ROOM_OPTIONS);
        roomRef.current = room;
        // Separated from the publish below so the two failure modes are
        // distinguishable: reaching the SFU at all, versus being allowed to send.
        try {
          await room.connect(url, token);
        } catch (err) {
          await stop();
          const detail = err instanceof Error ? err.message : String(err);
          return { ok: false, reason: `could not reach LiveKit — ${detail}` };
        }

        // Reuse the existing tracks; userProvidedTrack=true keeps device ownership
        // with the simulator (LiveKit won't stop/reacquire them).
        const localVideo = new LocalVideoTrack(videoTrack, undefined, true);
        const videoPub = await room.localParticipant.publishTrack(localVideo, {
          source: Track.Source.Camera,
          name: 'host-camera',
          // degradationPreference IS LOAD-BEARING — DO NOT REMOVE IT.
          //
          // Without it, publishTrack does:
          //     opts.degradationPreference ??= getDefaultDegradationPreference(track)
          // and that default function reads
          //     track.constraints.height && unwrapConstraint(track.constraints.height) >= 1080
          // where livekit-client's unwrapConstraint() understands only a bare
          // number, an array, `{exact}` or `{ideal}`. media.ts deliberately caps
          // capture with `{ max: 1280 }` ranges (and deliberately NO ideal/exact,
          // so neither axis is pinned and a portrait phone keeps its framing), so
          // the default computation reached `throw Error('could not unwrap
          // constraint')` and aborted EVERY publish in EVERY browser. The camera
          // still ran and the host saw themselves, so it looked like a network
          // fault while the trainer sat on "Waiting for host video…" forever.
          //
          // Passing constraints to the LocalVideoTrack constructor does NOT fix
          // this: its constructor kicks off setMediaStreamTrack() asynchronously,
          // which resets _constraints back to mediaTrack.getConstraints() after
          // the constructor's own assignment. Supplying the preference here is the
          // only place that reliably skips the broken computation, because `??=`
          // means the default is never evaluated when a value is already present.
          //
          // 'balanced' is exactly what getDefaultDegradationPreference would have
          // returned for a sub-1080p camera, so behaviour is unchanged.
          degradationPreference: 'balanced',
          // The bandwidth cap, moved here from the capture constraints (see
          // media.ts). Capping the upload is what actually saves Wi-Fi, and it
          // involves no constraint parsing, so it cannot break publishing.
          videoEncoding: PRACTICE_VIDEO_ENCODING,
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
        if (!videoPub.trackSid) {
          return { ok: false, reason: 'camera published without a track id' };
        }
        return { ok: true, tracks: { videoTrackId: videoPub.trackSid, audioTrackId } };
      } catch (err) {
        // Still non-fatal to the practice session — but the reason is reported
        // now instead of vanishing.
        await stop();
        const detail = err instanceof Error ? err.message : String(err);
        return { ok: false, reason: `publish failed — ${detail}` };
      }
    },
    [endpoints, stop],
  );

  return { publish, stop };
}
