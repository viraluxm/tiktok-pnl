'use client';

import { useQuery } from '@tanstack/react-query';
import { useUser } from './useUser';
import type { PickerDayStats, FulfillmentDaySummary } from '@/lib/shipping/pickerPerformance';

// Daily fulfillment-picker performance for one business day. Read-only; mirrors
// GET /api/team/fulfillment-performance.
export interface FulfillmentPerformanceResponse {
  day: string;                 // YYYY-MM-DD (business day)
  tz: string;                  // America/Los_Angeles
  max_pick_ms: number;         // max valid per-box duration (durations above this are excluded)
  eligible_picker_count: number;
  pickers: PickerDayStats[];
  unassigned: { orders_picked: number; boxes_completed: number } | null;
  summary: FulfillmentDaySummary;
}

export function useFulfillmentPerformance(day: string) {
  const { user } = useUser();
  return useQuery<FulfillmentPerformanceResponse>({
    queryKey: ['fulfillment-performance', user?.id, day],
    enabled: !!user && !!day,
    staleTime: 60_000,
    queryFn: async () => {
      const res = await fetch(`/api/team/fulfillment-performance?date=${encodeURIComponent(day)}`);
      if (!res.ok) throw new Error('Failed to load fulfillment performance');
      return res.json();
    },
  });
}
