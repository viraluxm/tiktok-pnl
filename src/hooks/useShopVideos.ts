'use client';

import { useQuery } from '@tanstack/react-query';
import { createClient } from '@/lib/supabase/client';
import { useUser } from './useUser';

export interface ShopVideoRow {
  id: string;
  tiktok_video_id: string;
  title: string;
  username: string;
  video_post_time: string;
  duration: number;
  views: number;
  gmv_amount: number;
  sku_orders: number;
  items_sold: number;
}

export interface VideoMetrics {
  totalVideos: number;
  totalViews: number;
  totalGmv: number;
  totalOrders: number;
  totalItemsSold: number;
}

export function useShopVideos(dateFrom: string | null, dateTo: string | null) {
  const { user } = useUser();
  const supabase = createClient();

  return useQuery<VideoMetrics>({
    queryKey: ['shop-videos-metrics', user?.id, dateFrom, dateTo],
    enabled: !!user,
    queryFn: async () => {
      let q = supabase
        .from('shop_videos')
        .select('views, gmv_amount, sku_orders, items_sold, video_post_time');

      if (dateFrom) q = q.gte('video_post_time', `${dateFrom}T00:00:00`);
      if (dateTo) q = q.lte('video_post_time', `${dateTo}T23:59:59`);

      const { data, error } = await q;
      if (error) throw error;

      const rows = data || [];
      return {
        totalVideos: rows.length,
        totalViews: rows.reduce((sum, r) => sum + (Number(r.views) || 0), 0),
        totalGmv: rows.reduce((sum, r) => sum + (Number(r.gmv_amount) || 0), 0),
        totalOrders: rows.reduce((sum, r) => sum + (Number(r.sku_orders) || 0), 0),
        totalItemsSold: rows.reduce((sum, r) => sum + (Number(r.items_sold) || 0), 0),
      };
    },
    staleTime: 30_000,
  });
}
