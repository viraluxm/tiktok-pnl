'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useUser } from './useUser';

export interface LaborData {
  period: { from: string; to: string; tz: string };
  host: {
    labor_cents: number;
    hours: number;
    rate_dollars: number;
    rates_differ: boolean;
    sessions_counted: number;
    excluded_over_8h_count: number;
    excluded_over_8h_hours: number;
    excluded_under_10m: number;
  };
  packer: { labor_cents: number; note: string | null; updated_at: string | null; entered: boolean };
}

// Host labor is MEASURED (live_sessions); packer labor is an entered figure per period.
// Only fetches when a bounded period is selected (both from & to present).
export function useLabor(from: string | null, to: string | null) {
  const { user } = useUser();
  return useQuery<LaborData>({
    queryKey: ['labor', user?.id, from, to],
    enabled: !!user && !!from && !!to,
    queryFn: async () => {
      const res = await fetch(`/api/labor?from=${from}&to=${to}`);
      if (!res.ok) throw new Error('Failed to load labor');
      return res.json();
    },
    staleTime: 30_000,
  });
}

export function useSavePackerLabor() {
  const qc = useQueryClient();
  return useMutation<{ ok: boolean }, Error, { from: string; to: string; packer_labor_cents: number; note?: string }>({
    mutationFn: async (input) => {
      const res = await fetch('/api/labor', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Failed to save');
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['labor'] }),
  });
}
