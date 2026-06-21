'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useUser } from './useUser';

export type SessionStatus = 'draft' | 'live' | 'ended' | 'reconciled';

export interface LiveSession {
  id: string;
  title: string;
  status: SessionStatus;
  started_at: string | null;
  ended_at: string | null;
  tiktok_live_id: string | null;
  source: string;
  created_at: string;
  updated_at: string;
}

const KEY = 'live-sessions';

export function useLiveSessions() {
  const { user } = useUser();

  return useQuery<LiveSession[]>({
    queryKey: [KEY, user?.id],
    enabled: !!user,
    queryFn: async () => {
      const res = await fetch('/api/live/sessions');
      if (!res.ok) throw new Error('Failed to load sessions');
      const json = await res.json();
      return json.sessions ?? [];
    },
    staleTime: 15_000,
  });
}

export function useLiveSession(id: string | null) {
  const { user } = useUser();

  return useQuery<LiveSession>({
    queryKey: [KEY, 'one', id, user?.id],
    enabled: !!user && !!id,
    queryFn: async () => {
      const res = await fetch(`/api/live/sessions/${id}`);
      if (!res.ok) throw new Error('Failed to load session');
      const json = await res.json();
      return json.session;
    },
    staleTime: 15_000,
  });
}

export function useStartSession() {
  const qc = useQueryClient();
  return useMutation<LiveSession, Error, { title?: string } | void>({
    mutationFn: async (input) => {
      const res = await fetch('/api/live/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input ?? {}),
      });
      if (!res.ok) throw new Error('Failed to start session');
      const json = await res.json();
      return json.session;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: [KEY] }),
  });
}

export function useEndSession() {
  const qc = useQueryClient();
  return useMutation<LiveSession, Error, string>({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/live/sessions/${id}/end`, { method: 'POST' });
      if (!res.ok) throw new Error('Failed to end session');
      const json = await res.json();
      return json.session;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: [KEY] }),
  });
}
