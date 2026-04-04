'use client';

import { useQuery } from '@tanstack/react-query';
import { useUser } from './useUser';

export interface PaymentRecord {
  id: string;
  amount: number;
  currency: string;
  status: string;
  createTime: string;
  paidTime: string;
  bankAccount: string;
}

export interface UnsettledSummary {
  totalCount: number;
  estRevenue: number;
  estFees: number;
  estAdjustments: number;
  estSettlement: number;
}

export interface FinanceData {
  statements: Array<{
    date: string;
    revenue: number;
    platformFee: number;
    shippingCost: number;
    settlement: number;
    netSales: number;
  }>;
  payments: PaymentRecord[];
  unsettled: UnsettledSummary;
}

export function useFinance(dateFrom: string | null, dateTo: string | null) {
  const { user } = useUser();

  return useQuery<FinanceData>({
    queryKey: ['finance', user?.id, dateFrom, dateTo],
    enabled: !!user,
    queryFn: async () => {
      const params = new URLSearchParams();
      if (dateFrom) params.set('from', dateFrom);
      if (dateTo) params.set('to', dateTo);
      const res = await fetch(`/api/tiktok/finance?${params}`);
      if (!res.ok) throw new Error('Failed to fetch finance data');
      return res.json();
    },
    staleTime: 60_000,
  });
}
