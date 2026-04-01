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
      return {
        products: data.products || [],
        totals: data.totals || { totalGMV: 0, totalShipping: 0, totalAffiliate: 0, totalPlatformFee: 0, totalUnits: 0, totalOrders: 0, byDate: {} },
      };
    },
    staleTime: 30_000,
  });
}
