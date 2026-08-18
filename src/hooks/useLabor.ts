'use client';

import { useQuery } from '@tanstack/react-query';
import { useUser } from './useUser';

// Punch-derived labor for a bounded Pacific period. Host + fulfillment both measured from
// clock-in/out instants (see /api/labor). Unconfirmed punches are surfaced as `pending`.
export interface LaborByDate {
  date: string;
  host_cents: number;
  host_hours: number;
  fulfillment_cents: number;
  fulfillment_hours: number;
  unconfirmed_hours: number;
  basis: string;
  zero_rate_flag: boolean;
}

export interface LaborData {
  period: { from: string; to: string; tz: string };
  host: { labor_cents: number; hours: number; zero_rate_flag: boolean };
  fulfillment: { labor_cents: number; hours: number };
  pending: { hours: number; pct: number };
  provisional: boolean; // pending hours > 10% of period labor hours → net is provisional
  by_date: LaborByDate[];
}

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
