'use client';

import { useQuery } from '@tanstack/react-query';
import { useUser } from './useUser';

export interface ReturnItem {
  order_id: string;
  product_name: string;
  gmv: number;
  status: string;
  order_date: string;
  units: number;
}

export interface ReturnsSummary {
  totalReturns: number;
  pendingReturns: number;
  completedReturns: number;
  totalAmount: number;
}

export interface ReturnsResponse {
  summary: ReturnsSummary;
  items: ReturnItem[];
}

export function useReturns(dateFrom: string | null, dateTo: string | null) {
  const { user } = useUser();

  return useQuery<ReturnsResponse>({
    queryKey: ['returns', user?.id, dateFrom, dateTo],
    enabled: !!user,
    queryFn: async () => {
      const params = new URLSearchParams();
      if (dateFrom) params.set('from', dateFrom);
      if (dateTo) params.set('to', dateTo);
      const res = await fetch(`/api/tiktok/returns?${params}`);
      if (!res.ok) throw new Error('Failed to fetch returns');
      return res.json();
    },
    staleTime: 30_000,
  });
}
