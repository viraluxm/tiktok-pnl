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
  store_id: string | null;
  // Resolved from store_id by the sessions API; null when no store / not readable.
  store_name: string | null;
  // Captured streaming-channel handle (e.g. "onlybidss"); null on old sessions or
  // before the extension's channel capture has landed. Display-only.
  channel_handle: string | null;
  // host_id resolved to the employee name by the sessions API; null when no host
  // selected or not readable. Display-only.
  host_name: string | null;
}

const KEY = 'live-sessions';

// ── Post-live order coverage check (read-only, list only) ──────────────────
// Surfaces synced-but-never-captured orders — the set reconcile can't see.
export interface CoverageGapOrder {
  order_id: string;
  order_date: string | null;
  created_at: string | null;
  buyer: string | null; // synced_order_ids has no buyer column → always null
  gmv: number | null;
  status: string | null;
  auto_combine_group_id: string | null;
}

export interface ShowCoverage {
  total_synced: number;
  captured_but_unbound_count: number;
  captured_but_unbound_ids: string[];
  coverage_gap_count: number;
  coverage_gap: CoverageGapOrder[];
  window: { start_date: string | null; end_date: string | null; store_id: string | null };
}

export const showCoverageKey = (id: string, userId?: string) => ['show-coverage', userId, id];

export async function fetchShowCoverage(id: string): Promise<ShowCoverage> {
  const res = await fetch(`/api/shows/${id}/coverage`);
  if (!res.ok) throw new Error('Failed to load coverage');
  return res.json();
}

// Auto-runs whenever a show detail is mounted (opened). Also refreshed when a
// show is ended — see useEndSession below.
export function useShowCoverage(id: string | null) {
  const { user } = useUser();
  return useQuery<ShowCoverage>({
    queryKey: showCoverageKey(id ?? '', user?.id),
    enabled: !!user && !!id,
    queryFn: () => fetchShowCoverage(id!),
    staleTime: 30_000,
  });
}

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
  const { user } = useUser();
  return useMutation<LiveSession, Error, string>({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/live/sessions/${id}/end`, { method: 'POST' });
      if (!res.ok) throw new Error('Failed to end session');
      const json = await res.json();
      return json.session;
    },
    onSuccess: (_data, id) => {
      qc.invalidateQueries({ queryKey: [KEY] });
      // Run the order coverage check automatically when a show ends, so the gap
      // (synced-but-never-captured) is computed the moment the live wraps —
      // populated in cache and ready when the show detail is viewed.
      qc.prefetchQuery({ queryKey: showCoverageKey(id, user?.id), queryFn: () => fetchShowCoverage(id) });
    },
  });
}
