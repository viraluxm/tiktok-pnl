'use client';

import { useQuery } from '@tanstack/react-query';
import { useUser } from './useUser';

// Team-wide auction performance for a rolling window + store filter. Read-only.
// Shape mirrors GET /api/live/auction-performance.
export interface AuctionPerformance {
  store: string; // store_id or 'all'
  days: number;
  window_start: string;
  sample_size: number;
  unmatched: number;
  asp_hit_rate: number;
  below_breakeven_rate: number;
  thin_margin_rate: number;
  counts: { asp_hit: number; below_breakeven: number; thin_margin: number };
  median_final_price_cents: number | null;
  median_pct_of_goal: number | null;
  below_breakeven_baseline: number;
}

export function useAuctionPerformance(store: string, days = 21) {
  const { user } = useUser();
  return useQuery<AuctionPerformance>({
    queryKey: ['auction-performance', user?.id, store, days],
    enabled: !!user,
    staleTime: 60_000,
    queryFn: async () => {
      const res = await fetch(`/api/live/auction-performance?store=${encodeURIComponent(store)}&days=${days}`);
      if (!res.ok) throw new Error('Failed to load auction performance');
      return res.json();
    },
  });
}
