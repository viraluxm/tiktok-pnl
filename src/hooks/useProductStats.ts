'use client';

import { useQuery } from '@tanstack/react-query';
import { useUser } from './useUser';

export interface ProductSku {
  sku_id: string;
  sku_name: string;
  orders: number;
  gmv: number;
  inventory: number;
  active: boolean;
}

export interface ProductStats {
  tiktok_product_id: string;
  name: string;
  image_url: string | null;
  total_orders: number;
  total_gmv: number;
  total_shipping: number;
  skus: ProductSku[];
}

export interface DateBreakdown {
  gmv: number;
  shipping: number;
  affiliate: number;
  platformFee: number;
}

export interface OrderTotals {
  totalGMV: number;
  totalShipping: number;
  totalAffiliate: number;
  totalPlatformFee: number;
  totalUnits: number;
  totalOrders: number;
  byDate: Record<string, DateBreakdown>;
  returnsCount: number;
  returnsAmount: number;
  samplesCount: number;
  // COGS from the auction cost snapshot (dollars), read from the canonical order-grain view.
  // PARTIAL: only auction orders have a snapshot; cogsCoveredOrders/totalOrders is the auction coverage.
  snapshotCogs: number;
  cogsCoveredOrders: number;
  // Non-auction merchandise (dollars) = the view's uncaptured_gmv (gmv − shipping) for orders with no
  // auction. Recognises no auction revenue; the dashboard drops it from the headline GMV.
  nonAuctionMerch: number;
  // Set by the route when the COGS read errored or truncated part-way. A partially-summed COGS is
  // too LOW, not zero, so arithmetic alone cannot catch it — the server has to say so.
  cogsUnavailable?: boolean;
}

export interface ProductStatsResponse {
  products: ProductStats[];
  totals: OrderTotals;
}

export function useProductStats(dateFrom: string | null, dateTo: string | null) {
  const { user } = useUser();

  return useQuery<ProductStatsResponse>({
    queryKey: ['product-stats', user?.id, dateFrom, dateTo],
    enabled: !!user,
    queryFn: async () => {
      const params = new URLSearchParams();
      if (dateFrom) params.set('from', dateFrom);
      if (dateTo) params.set('to', dateTo);
      const res = await fetch(`/api/tiktok/product-stats?${params}`);
      if (!res.ok) throw new Error('Failed to fetch product stats');
      const data = await res.json();
      // Never fabricate a zeroed totals object: zero COGS against real GMV silently inflates net
      // profit on the dashboard. A response without totals is a failure, not an empty period.
      if (!data.totals) throw new Error('product-stats returned no totals');
      return {
        products: data.products || [],
        totals: data.totals as OrderTotals,
      };
    },
    staleTime: 30_000,
  });
}
