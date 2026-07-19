'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useUser } from './useUser';

export interface ChannelMapping {
  id: string;
  channel_name: string;
  store_id: string;
  store_name: string | null;
  created_at: string;
}
export interface UnmappedChannel {
  channel_handle: string | null;
  session_count: number;
  session_ids: string[];
}
export interface NullSession {
  id: string;
  title: string | null;
  status: string | null;
  started_at: string | null;
  ended_at: string | null;
  last_seen_at: string | null;
}
export interface ChannelMapResponse {
  mappings: ChannelMapping[];
  stores: { id: string; name: string }[];
  unmapped_total: number;
  unmapped_by_channel: UnmappedChannel[];
  // Unmapped sessions with NO captured channel_handle — assignable directly to a store
  // by session id (they can't be mapped by channel name). May be absent on older API.
  null_sessions?: NullSession[];
}

const KEY = ['admin-channels'];

// Admin-only. On a non-admin (403) or logged-out (401) the query throws; callers that
// only want the flag count should treat an error as "nothing to show" (see the banner).
export function useChannelMap(enabled = true) {
  const { user } = useUser();
  return useQuery<ChannelMapResponse>({
    queryKey: [...KEY, user?.id],
    enabled: !!user && enabled,
    retry: false,
    staleTime: 30_000,
    queryFn: async () => {
      const res = await fetch('/api/admin/channels');
      if (!res.ok) throw new Error(res.status === 403 ? 'forbidden' : 'Failed to load channel map');
      return res.json();
    },
  });
}

export function useSaveChannelMapping() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { channel_name: string; store_id: string }) => {
      const res = await fetch('/api/admin/channels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || 'Failed to save mapping');
      return res.json() as Promise<{ mapping: ChannelMapping; backfilled_count: number }>;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY });
      // Backfill changed session store_ids → refresh the shows/sessions list too.
      qc.invalidateQueries({ queryKey: ['live-sessions'] });
    },
  });
}

// Directly attribute a single null-handle session to a store (by session id).
// Rescues sessions the channel-name mapping can't reach (channel_handle is null).
export function useAssignSessionStore() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { session_id: string; store_id: string }) => {
      const res = await fetch(`/api/admin/sessions/${input.session_id}/store`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ store_id: input.store_id }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || 'Failed to assign store');
      return res.json() as Promise<{ id: string; store_id: string }>;
    },
    onSuccess: () => {
      // Session now has a store_id → drops out of the unmapped list; refresh shows too.
      qc.invalidateQueries({ queryKey: KEY });
      qc.invalidateQueries({ queryKey: ['live-sessions'] });
    },
  });
}

export function useDeleteChannelMapping() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/admin/channels/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete mapping');
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}
