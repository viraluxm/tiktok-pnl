'use client';

import { useQuery } from '@tanstack/react-query';
import { useUser } from './useUser';
import type { TrailingFulfillmentRate } from '@/lib/shipping/trailingFulfillmentRate';
import type { DurationSource } from '@/lib/shows/duration';

// How many completed fulfillment days the rate pools.
//
// 14, not 7 and not 30. 7 is too noisy — the crew rate swung 2.2x day to day over one week, and
// picking runs in batches (weekly outflow ranged 45% to 112% of sales over August), so a short
// window measures which days happened to fall inside it. 30 is too long while the operation is
// SCALING: units sold per week ran 17,623 → 19,084 → 23,286 → 23,707 through August, up 35%, so
// a 30-day window prices today's shows partly off weeks that no longer resemble the business.
//
// 14 days spans the batch cycle without reaching back into the smaller weeks. It also happens to
// be where the two candidate denominators agree most closely ($0.520 per unit sold vs $0.601 per
// unit picked, a 16% spread against 23% at 30 days), which is a sign the window is long enough
// for fulfillment lag to average out and short enough to still describe current volume.
//
// See trailingFulfillmentRate.ts for the denominator argument and netEconomics.ts for why
// fulfillment cost is allocated rather than measured per show.
export const PICK_RATE_DAYS = 14;

export interface FulfillmentCostRateResponse extends TrailingFulfillmentRate {
  window: { days: number; first_day: string; last_day: string; start: string; end: string };
}

/**
 * The crew's pooled fulfillment labor cost per unit SOLD over the last N COMPLETED fulfillment
 * days.
 *
 * Deliberately keyed WITHOUT a session id: this figure is identical for every show, so one
 * fetch serves the whole tab no matter how many shows the user opens. 10-minute staleTime —
 * a 30-day trailing rate cannot move meaningfully faster than that.
 */
export function useFulfillmentCostRate(days: number = PICK_RATE_DAYS) {
  const { user } = useUser();
  return useQuery<FulfillmentCostRateResponse>({
    queryKey: ['fulfillment-cost-rate', user?.id, days],
    enabled: !!user,
    staleTime: 600_000,
    queryFn: async () => {
      const res = await fetch(`/api/team/fulfillment-cost-rate?days=${days}`);
      if (!res.ok) throw new Error('Failed to load fulfillment cost rate');
      return res.json();
    },
  });
}

// Host pay for one show, computed SERVER-side (an individual's hourly_rate never reaches the
// browser — see the route's header). host_pay_cents is null, never 0, when the show has no
// host mapped or that host has no rate set; host_rate_known distinguishes the two.
export interface ShowNetEconomicsResponse {
  duration_ms: number | null;
  duration_source: DurationSource;
  host_id: string | null;
  host_name: string | null;
  host_rate_known: boolean;
  host_pay_cents: number | null;
}

export function useShowNetEconomics(sessionId: string | null) {
  const { user } = useUser();
  return useQuery<ShowNetEconomicsResponse>({
    queryKey: ['show-net-economics', user?.id, sessionId],
    enabled: !!user && !!sessionId,
    staleTime: 60_000,
    queryFn: async () => {
      const res = await fetch(`/api/live/sessions/${sessionId}/net-economics`);
      if (!res.ok) throw new Error('Failed to load show economics');
      return res.json();
    },
  });
}
