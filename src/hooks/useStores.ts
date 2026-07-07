'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useUser } from './useUser';

export interface StoreEntry {
  id: string;
  name: string;
  connected: boolean;
  shopName: string | null;
  shopLogo: string | null;
}

export interface StoresResponse {
  stores: StoreEntry[];
  activeStore: string; // a store_id or 'all'
}

export function useStores() {
  const { user } = useUser();
  return useQuery<StoresResponse>({
    queryKey: ['stores', user?.id],
    enabled: !!user,
    staleTime: 15_000,
    queryFn: async () => {
      const res = await fetch('/api/stores');
      if (!res.ok) throw new Error('Failed to load stores');
      return res.json();
    },
  });
}

// Sets the active store (server-validated cookie) and refetches everything scoped by
// it, so the dashboard/status/analytics switch to the new store immediately.
export function useSetActiveStore() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (storeId: string) => {
      const res = await fetch('/api/stores/active', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ store_id: storeId }),
      });
      if (!res.ok) throw new Error('Failed to set active store');
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['stores'] });
      qc.invalidateQueries({ queryKey: ['tiktok-status'] });
      qc.invalidateQueries({ queryKey: ['product-stats'] });
      qc.invalidateQueries({ queryKey: ['entries'] });
      qc.invalidateQueries({ queryKey: ['shop-videos-metrics'] });
      qc.invalidateQueries({ queryKey: ['pnl-by-sku'] });
      qc.invalidateQueries({ queryKey: ['pnl-by-show'] });
      qc.invalidateQueries({ queryKey: ['pnl-by-period'] });
      qc.invalidateQueries({ queryKey: ['support-conversations'] });
      qc.invalidateQueries({ queryKey: ['support-messages'] });
    },
  });
}
