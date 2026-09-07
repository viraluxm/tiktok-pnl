'use client';

import { useEffect, useRef, useState } from 'react';
import TrainerPreviewOverlay, { type PreviewAuction } from './TrainerPreviewOverlay';
import type { LiveComment } from './simulatorData';
import { PRACTICE_ROOM_OPTIONS } from '@/lib/training/media';

type VideoStatus = 'connecting' | 'waiting' | 'live' | 'error';

// Trainer-side viewer: subscribes to the host's published camera (and mic) over
// LiveKit and shows it in a phone-shaped preview. Best-effort and self-contained
// — failure shows "Video unavailable" and never affects the Supabase controls.
export default function TrainerVideoView({
  sessionId,
  comments = [],
  auction,
}: {
  sessionId: string;
  comments?: LiveComment[];
  auction?: PreviewAuction;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const roomRef = useRef<import('livekit-client').Room | null>(null);
  const [status, setStatus] = useState<VideoStatus>('connecting');
  // Host audio is OFF by default and scoped to THIS tab. A trainer machine can
  // hold several controller tabs, and LiveKit's bare attach() would create its
  // own unmuted <audio> for each one — every host's mic playing at once. The
  // trainer opts in per tab with a click, which also satisfies the browser
  // autoplay policy. hostAudioOnRef mirrors the state for the connect closure.
  const [hostAudioOn, setHostAudioOn] = useState(false);
  const hostAudioOnRef = useRef(false);
  const [hasHostAudio, setHasHostAudio] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let room: import('livekit-client').Room | null = null;

    (async () => {
      const { Room, RoomEvent, Track } = await import('livekit-client');

      const res = await fetch('/api/training/video-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'controller', session: sessionId }),
      });
      if (!res.ok) {
        if (!cancelled) setStatus('error');
        return;
      }
      const { token, url } = (await res.json()) as { token?: string; url?: string };
      if (!token || !url) {
        if (!cancelled) setStatus('error');
        return;
      }
      if (cancelled) return;

      const attach = (track: import('livekit-client').RemoteTrack) => {
        if (track.kind === Track.Kind.Video) {
          if (videoRef.current) track.attach(videoRef.current);
          if (!cancelled) setStatus('live');
        } else if (track.kind === Track.Kind.Audio) {
          // Attach to OUR element so this tab controls playback. attach() sets
          // element.muted = false internally, so re-apply the trainer's choice
          // immediately after — otherwise subscribing alone would start audio.
          if (audioRef.current) {
            track.attach(audioRef.current);
            audioRef.current.muted = !hostAudioOnRef.current;
          }
          if (!cancelled) setHasHostAudio(true);
        }
      };

      // adaptiveStream is the subscriber half of the bandwidth fix: it requests
      // a simulcast layer sized to this small preview element instead of pulling
      // the host's full-resolution top layer. dynacast is its publisher-side
      // pair. Together they cut both host upload and trainer download sharply
      // when ~20 sessions run at once.
      room = new Room(PRACTICE_ROOM_OPTIONS);
      roomRef.current = room;
      room
        .on(RoomEvent.TrackSubscribed, (track) => attach(track))
        .on(RoomEvent.TrackUnsubscribed, (track) => {
          track.detach();
          if (track.kind === Track.Kind.Video && !cancelled) setStatus('waiting');
          if (track.kind === Track.Kind.Audio && !cancelled) setHasHostAudio(false);
        })
        .on(RoomEvent.Disconnected, () => {
          if (!cancelled) setStatus('waiting');
        });

      await room.connect(url, token);
      if (cancelled) {
        await room.disconnect();
        return;
      }

      // The host may already be publishing — attach any existing tracks.
      let hasVideo = false;
      room.remoteParticipants.forEach((p) => {
        p.trackPublications.forEach((pub) => {
          if (!pub.track) return;
          if (pub.kind === Track.Kind.Video) {
            attach(pub.track);
            hasVideo = true;
          } else if (pub.kind === Track.Kind.Audio) {
            attach(pub.track);
          }
        });
      });
      if (!hasVideo && !cancelled) setStatus('waiting');
    })().catch(() => {
      if (!cancelled) setStatus('error');
    });

    return () => {
      cancelled = true;
      roomRef.current = null;
      if (room) void room.disconnect();
    };
  }, [sessionId]);

  // Explicit per-tab opt-in/out for this host's audio. Runs from a click, so
  // room.startAudio() and element.play() both count as a user gesture and clear
  // the browser's autoplay block. Muting keeps the subscription intact (video is
  // untouched) — it only silences local playback.
  async function toggleHostAudio() {
    const next = !hostAudioOn;
    hostAudioOnRef.current = next;
    setHostAudioOn(next);
    const el = audioRef.current;
    if (!next) {
      if (el) el.muted = true;
      return;
    }
    try {
      await roomRef.current?.startAudio();
    } catch {
      /* ignore — the element play() below is the real unlock */
    }
    if (el) {
      el.muted = false;
      try {
        await el.play();
      } catch {
        /* blocked — trainer can tap again */
      }
    }
  }

  return (
    <div className="relative aspect-[9/16] w-full overflow-hidden rounded-2xl border border-tt-border bg-black">
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        className="h-full w-full object-cover"
      />
      {status !== 'live' && (
        <div className="absolute inset-0 flex items-center justify-center px-4 text-center text-[13px] text-white/70">
          {status === 'connecting'
            ? 'Connecting…'
            : status === 'waiting'
              ? 'Waiting for host video…'
              : 'Video unavailable'}
        </div>
      )}
      {status === 'live' && auction && (
        <TrainerPreviewOverlay comments={comments} auction={auction} />
      )}
      {/* Host mic sink. Starts muted; only this tab's toggle unmutes it. */}
      <audio ref={audioRef} autoPlay playsInline muted className="hidden" />
      {status === 'live' && hasHostAudio && (
        <button
          type="button"
          onClick={() => void toggleHostAudio()}
          aria-pressed={hostAudioOn}
          className="absolute left-1/2 top-2 -translate-x-1/2 cursor-pointer rounded-full bg-black/70 px-3 py-1 text-[11px] font-semibold text-white backdrop-blur-md transition-colors hover:bg-black/80 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/50"
        >
          {hostAudioOn ? 'Mute host' : 'Hear host'}
        </button>
      )}
    </div>
  );
}
