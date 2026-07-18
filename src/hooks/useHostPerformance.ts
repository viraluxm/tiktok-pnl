'use client';

import { useQuery } from '@tanstack/react-query';
import { useUser } from './useUser';

// Per-host auction performance for the Roster badges. Read-only.
// `hosts` is keyed by employees.id; a host with no attributed auctions is absent.
export interface HostAgg {
  asp7_n: number;      // attributed sold auctions in the 7d ASP window
  asp7_hits: number;   // of those, final_price >= asp_goal
  be14_n: number;      // attributed sold auctions in the 14d below-BE window
  be14_below: number;  // of those, final_price < break_even
}

export interface HostPerformance {
  asp_window_days: number;
  be_window_days: number;
  hosts: Record<string, HostAgg>;
}

export function useHostPerformance() {
  const { user } = useUser();
  return useQuery<HostPerformance>({
    queryKey: ['host-performance', user?.id],
    enabled: !!user,
    staleTime: 60_000,
    queryFn: async () => {
      const res = await fetch('/api/live/host-performance');
      if (!res.ok) throw new Error('Failed to load host performance');
      return res.json();
    },
  });
}
