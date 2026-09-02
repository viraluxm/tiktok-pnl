'use client';

import { useQuery } from '@tanstack/react-query';
import { useUser } from './useUser';
import type { PickerDayStats, FulfillmentDaySummary } from '@/lib/shipping/pickerPerformance';
import type { PickerCostRow, CostBlock } from '@/lib/shipping/pickCostEconomics';

// Daily fulfillment performance + unit economics for one fulfillment day (04:00 → 04:00 PT).
// Read-only; mirrors GET /api/team/fulfillment-performance.
export interface FulfillmentPerformanceResponse {
  day: string;                 // YYYY-MM-DD (fulfillment day)
  tz: string;                  // America/Los_Angeles
  max_pick_ms: number;         // max valid per-box duration (durations above this are excluded)
  eligible_picker_count: number;
  pickers: PickerDayStats[];   // unchanged contract from aggregateFulfillmentDay
  unassigned: { orders_picked: number; boxes_completed: number } | null;
  summary: FulfillmentDaySummary;
  // `rows` is `pickers` plus fulfillment_track, cost, and the people who were on the clock
  // but completed zero boxes (who have no verification row, so never appear in `pickers`).
  rows: PickerCostRow[];
  cost: CostBlock;             // crew-wide, over ALL fulfillment hours on the clock that day
  unproductive_hours: number;  // hours by on-clock staff who completed zero boxes
  unproductive_cents: number;
  suspect_hours: number;       // forgotten clock-outs, excluded from every cost figure
  suspect_punches: number;
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
