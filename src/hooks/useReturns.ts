'use client';

import { useQuery } from '@tanstack/react-query';
import { useUser } from './useUser';

export interface ReturnItem {
  order_id: string;
  product_name: string;
  product_image: string | null;
  gmv: number;
  status: string;
  return_type: string;
  role: string;
  reason: string;
  buyer_remarks: string;
  order_date: string;
  units: number;
}

export interface ReturnsSummary {
  totalReturns: number;
  pendingReturns: number;
  completedReturns: number;
  totalAmount: number;
  pendingAmount: number;
  completedAmount: number;
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
