'use client';

import { useQuery } from '@tanstack/react-query';
import { createClient } from '@/lib/supabase/client';
import { useUser } from './useUser';

export interface AdSpendMetrics {
  totalSpend: number;
  totalImpressions: number;
  totalClicks: number;
  totalConversions: number;
}

export function useAdSpend(dateFrom: string | null, dateTo: string | null) {
  const { user } = useUser();
  const supabase = createClient();

  return useQuery<AdSpendMetrics>({
    queryKey: ['ad-spend', user?.id, dateFrom, dateTo],
    enabled: !!user,
    queryFn: async () => {
      let q = supabase.from('ad_spend').select('spend_amount, impressions, clicks, conversions');

      if (dateFrom) q = q.gte('date', dateFrom);
      if (dateTo) q = q.lte('date', dateTo);

      const { data, error } = await q;
      if (error) throw error;

      const rows = data || [];
      return {
        totalSpend: rows.reduce((sum, r) => sum + (Number(r.spend_amount) || 0), 0),
        totalImpressions: rows.reduce((sum, r) => sum + (Number(r.impressions) || 0), 0),
        totalClicks: rows.reduce((sum, r) => sum + (Number(r.clicks) || 0), 0),
        totalConversions: rows.reduce((sum, r) => sum + (Number(r.conversions) || 0), 0),
      };
    },
    staleTime: 30_000,
  });
}
