'use client';

import { useEffect, useRef, useState } from 'react';
import TrainerPreviewOverlay, { type PreviewAuction } from './TrainerPreviewOverlay';
import type { LiveComment } from './simulatorData';

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
  const roomRef = useRef<import('livekit-client').Room | null>(null);
  const [status, setStatus] = useState<VideoStatus>('connecting');
  const [needAudioUnlock, setNeedAudioUnlock] = useState(false);

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
          // LiveKit creates + manages the audio element and its playback.
          track.attach();
        }
      };

      room = new Room();
      roomRef.current = room;
      room
        .on(RoomEvent.TrackSubscribed, (track) => attach(track))
        .on(RoomEvent.TrackUnsubscribed, (track) => {
          track.detach();
          if (track.kind === Track.Kind.Video && !cancelled) setStatus('waiting');
        })
        .on(RoomEvent.AudioPlaybackStatusChanged, () => {
          if (!cancelled && room) setNeedAudioUnlock(!room.canPlaybackAudio);
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
      if (!cancelled) setNeedAudioUnlock(!room.canPlaybackAudio);
    })().catch(() => {
      if (!cancelled) setStatus('error');
    });

    return () => {
      cancelled = true;
      roomRef.current = null;
      if (room) void room.disconnect();
    };
  }, [sessionId]);

  async function enableAudio() {
    try {
      await roomRef.current?.startAudio();
      setNeedAudioUnlock(false);
    } catch {
      /* ignore — trainer can tap again */
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
      {status === 'live' && needAudioUnlock && (
        <button
          type="button"
          onClick={enableAudio}
          className="absolute left-1/2 top-2 -translate-x-1/2 cursor-pointer rounded-full bg-black/70 px-3 py-1 text-[11px] font-semibold text-white backdrop-blur-md transition-colors hover:bg-black/80 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/50"
        >
          Enable host audio
        </button>
      )}
    </div>
  );
}
