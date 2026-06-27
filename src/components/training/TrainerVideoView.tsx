'use client';

import { useEffect, useRef, useState } from 'react';

type VideoStatus = 'connecting' | 'waiting' | 'live' | 'error';

// Trainer-side viewer: subscribes to the host's published camera track over
// LiveKit and shows it in a phone-shaped preview. Best-effort and self-contained
// — failure shows "Video unavailable" and never affects the Supabase controls.
export default function TrainerVideoView({ sessionId }: { sessionId: string }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [status, setStatus] = useState<VideoStatus>('connecting');

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
        if (track.kind === Track.Kind.Video && videoRef.current) {
          track.attach(videoRef.current);
          if (!cancelled) setStatus('live');
        }
      };

      room = new Room();
      room
        .on(RoomEvent.TrackSubscribed, (track) => attach(track))
        .on(RoomEvent.TrackUnsubscribed, () => {
          if (!cancelled) setStatus('waiting');
        })
        .on(RoomEvent.Disconnected, () => {
          if (!cancelled) setStatus('waiting');
        });

      await room.connect(url, token);
      if (cancelled) {
        await room.disconnect();
        return;
      }

      // The host may already be publishing — attach any existing video track.
      let hasVideo = false;
      room.remoteParticipants.forEach((p) => {
        p.trackPublications.forEach((pub) => {
          if (pub.track && pub.kind === Track.Kind.Video) {
            attach(pub.track);
            hasVideo = true;
          }
        });
      });
      if (!hasVideo && !cancelled) setStatus('waiting');
    })().catch(() => {
      if (!cancelled) setStatus('error');
    });

    return () => {
      cancelled = true;
      if (room) void room.disconnect();
    };
  }, [sessionId]);

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
      {status === 'live' && (
        <span className="absolute left-2 top-2 rounded-full bg-[#FE2C55] px-2 py-0.5 text-[10px] font-bold uppercase text-white">
          Live
        </span>
      )}
    </div>
  );
}
