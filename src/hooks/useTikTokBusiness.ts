'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { useUser } from './useUser';

interface BusinessStatus {
  connected: boolean;
  advertiserId?: string;
  advertiserName?: string;
  connectedAt?: string;
}

export function useTikTokBusiness() {
  const queryClient = useQueryClient();
  const { user } = useUser();

  const statusQuery = useQuery<BusinessStatus>({
    // Scope by user id so a same-tab user switch can't read the previous user's
    // cached ad-account status; gate on user so we never fetch pre-auth.
    queryKey: ['tiktok-business-status', user?.id],
    enabled: !!user,
    queryFn: async () => {
      const res = await fetch('/api/tiktok-business/status');
      if (!res.ok) return { connected: false };
      return res.json();
    },
    staleTime: 30_000,
  });

  const connect = useCallback(() => {
    window.location.href = '/api/tiktok-business/auth';
  }, []);

  const disconnect = useCallback(async () => {
    await fetch('/api/tiktok-business/disconnect', { method: 'POST' });
    queryClient.invalidateQueries({ queryKey: ['tiktok-business-status'] });
    queryClient.invalidateQueries({ queryKey: ['ad-spend'] });
  }, [queryClient]);

  const syncAdSpend = useCallback(async () => {
    const res = await fetch('/api/tiktok-business/sync-adspend', { method: 'POST' });
    const data = await res.json();
    queryClient.invalidateQueries({ queryKey: ['ad-spend'] });
    return data;
  }, [queryClient]);

  return {
    isConnected: statusQuery.data?.connected ?? false,
    advertiserId: statusQuery.data?.advertiserId,
    advertiserName: statusQuery.data?.advertiserName,
    isLoading: statusQuery.isLoading,
    connect,
    disconnect,
    syncAdSpend,
  };
}
