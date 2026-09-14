'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { StaffingOutlookPayload } from '@/lib/schedule/capacity';

// Staffing capacity, read and written through the admin ROUTE rather than the browser Supabase
// client. Deliberate: every capacity write is owner-scoped from the session uid on the server, and
// the outlook needs a staffed count joined across employees — neither belongs in the browser.

export type CapacityPayload = Omit<StaffingOutlookPayload, never>;

const KEY = 'capacity';

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: 'no-store' });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Failed (${res.status})`);
  return body as T;
}

async function send(method: 'POST' | 'PATCH', body: unknown): Promise<void> {
  const res = await fetch('/api/admin/schedule/capacity', {
    method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Failed (${res.status})`);
}

// `enabled: false` is how the /preview route keeps its ZERO-NETWORK guarantee: the panel still
// calls the hook (rules of hooks) but the query never runs and no fetch is issued.
export function useCapacity(opts: { from?: string; days?: number; enabled?: boolean } = {}) {
  const qc = useQueryClient();
  const params = new URLSearchParams();
  if (opts.from) params.set('from', opts.from);
  if (opts.days) params.set('days', String(opts.days));
  const qs = params.toString();

  const query = useQuery<CapacityPayload>({
    queryKey: [KEY, opts.from ?? null, opts.days ?? null],
    queryFn: () => getJson<CapacityPayload>(`/api/admin/schedule/capacity${qs ? `?${qs}` : ''}`),
    staleTime: 30_000,
    enabled: opts.enabled !== false,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: [KEY] });

  return {
    data: query.data,
    isLoading: query.isLoading,
    error: query.error as Error | null,
    refetch: query.refetch,
    saveBlock: useMutation({
      mutationFn: (b: Record<string, unknown>) => send('POST', b),
      onSuccess: invalidate,
    }),
    setBlockActive: useMutation({
      mutationFn: (v: { blockId: string; active: boolean }) => send('PATCH', { scope: 'block', ...v }),
      onSuccess: invalidate,
    }),
    setTeamCapacity: useMutation({
      mutationFn: (v: { team: string; capacity: number | null; closed?: boolean }) => send('PATCH', { scope: 'team', ...v }),
      onSuccess: invalidate,
    }),
    setDateCapacity: useMutation({
      mutationFn: (v: { blockId: string; date: string; capacity?: number | null; closed?: boolean }) => send('PATCH', { scope: 'date', ...v }),
      onSuccess: invalidate,
    }),
  };
}
