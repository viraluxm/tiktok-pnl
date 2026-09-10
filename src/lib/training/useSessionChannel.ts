'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/client';
import { createPublicRealtimeClient } from '@/lib/supabase/publicRealtime';
import { TRAINER_EVENT, type TrainerEvent } from '@/components/training/trainerEvents';
import { isValidTrainingSessionId, trainingRealtimeChannel } from '@/lib/training/session';

export type ChannelStatus = 'connecting' | 'connected' | 'error';
type Role = 'host' | 'controller';

// Shared Supabase Realtime Broadcast + Presence hook for the practice session.
// Both the host screen and the trainer controller join the same channel
// (`trainer:<sessionId>`). No database, no RLS — pure broadcast.
// `sessionless` selects the Realtime client. A tokenised host page MUST pass true:
// the default client is @supabase/ssr's cookie-managing browser client, and creating
// one on a public page would establish a Supabase auth session — which the capture
// extension would relay, silently mis-attributing captures (CLAUDE.md). See
// createPublicRealtimeClient.
export function useSessionChannel(
  sessionId: string,
  role: Role,
  onEvent?: (event: TrainerEvent) => void,
  sessionless = false,
) {
  const [status, setStatus] = useState<ChannelStatus>('connecting');
  const [peerPresent, setPeerPresent] = useState(false); // is the OTHER role connected?
  const channelRef = useRef<RealtimeChannel | null>(null);
  const onEventRef = useRef(onEvent);
  useEffect(() => {
    onEventRef.current = onEvent;
  });

  useEffect(() => {
    // Defense in depth: the pages already fail closed on an invalid id, so this
    // hook is never mounted with one. Guard anyway — never open a channel for an
    // invalid session (the previous channel, if any, was already torn down by the
    // prior effect's cleanup).
    if (!isValidTrainingSessionId(sessionId)) {
      channelRef.current = null;
      return;
    }
    const supabase = sessionless ? createPublicRealtimeClient() : createClient();
    const channel = supabase.channel(trainingRealtimeChannel(sessionId), {
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
      void channel.unsubscribe();
      channelRef.current = null;
    };
  }, [sessionId, role, sessionless]);

  const send = useCallback((event: TrainerEvent) => {
    const channel = channelRef.current;
    if (!channel) return;
    void channel.send({ type: 'broadcast', event: TRAINER_EVENT, payload: event });
  }, []);

  return { status, peerPresent, send };
}
