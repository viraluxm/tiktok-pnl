'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/client';
import { TRAINER_EVENT, type TrainerEvent } from '@/components/training/trainerEvents';

export type ChannelStatus = 'connecting' | 'connected' | 'error';
type Role = 'host' | 'controller';

// Shared Supabase Realtime Broadcast + Presence hook for the practice session.
// Both the host screen and the trainer controller join the same channel
// (`trainer:<sessionId>`). No database, no RLS — pure broadcast.
export function useSessionChannel(
  sessionId: string,
  role: Role,
  onEvent?: (event: TrainerEvent) => void,
) {
  const [status, setStatus] = useState<ChannelStatus>('connecting');
  const [peerPresent, setPeerPresent] = useState(false); // is the OTHER role connected?
  const channelRef = useRef<RealtimeChannel | null>(null);
  const onEventRef = useRef(onEvent);
  useEffect(() => {
    onEventRef.current = onEvent;
  });

  useEffect(() => {
    const supabase = createClient();
    const channel = supabase.channel(`trainer:${sessionId}`, {
      config: { broadcast: { self: false }, presence: { key: role } },
    });
    channelRef.current = channel;

    const otherRole: Role = role === 'host' ? 'controller' : 'host';
    const syncPeers = () => {
      setPeerPresent(Object.keys(channel.presenceState()).includes(otherRole));
    };

    channel
      .on('broadcast', { event: TRAINER_EVENT }, ({ payload }) => {
        onEventRef.current?.(payload as TrainerEvent);
      })
      .on('presence', { event: 'sync' }, syncPeers)
      .on('presence', { event: 'join' }, syncPeers)
      .on('presence', { event: 'leave' }, syncPeers)
      .subscribe((s: string) => {
        if (s === 'SUBSCRIBED') {
          setStatus('connected');
          void channel.track({ role });
        } else if (s === 'CHANNEL_ERROR' || s === 'TIMED_OUT') {
          setStatus('error');
        } else if (s === 'CLOSED') {
          setStatus('connecting');
        }
      });

    return () => {
      void supabase.removeChannel(channel);
      channelRef.current = null;
    };
  }, [sessionId, role]);

  const send = useCallback((event: TrainerEvent) => {
    const channel = channelRef.current;
    if (!channel) return;
    void channel.send({ type: 'broadcast', event: TRAINER_EVENT, payload: event });
  }, []);

  return { status, peerPresent, send };
}
