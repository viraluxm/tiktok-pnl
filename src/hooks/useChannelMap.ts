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
export interface ChannelMapResponse {
  mappings: ChannelMapping[];
  stores: { id: string; name: string }[];
  unmapped_total: number;
  unmapped_by_channel: UnmappedChannel[];
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
