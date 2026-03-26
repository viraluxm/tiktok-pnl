'use client';

import { useEffect, useRef, useCallback, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useUser } from './useUser';

interface TikTokConnection {
  id: string;
  shopName: string | null;
  hasShop: boolean;
  advertiserCount: number;
  connectedAt: string;
  lastSyncedAt: string | null;
  needsBackfill: boolean;
}

interface TikTokStatusResponse {
  connected: boolean;
  connection: TikTokConnection | null;
}

interface SyncSummary {
  dateRange: { startDate: string; endDate: string };
  entriesCreated: number;
  entriesUpdated: number;
  ordersFetched: number;
  isCaughtUp: boolean;
  hasMorePages: boolean;
  errors?: string[];
}

interface SyncResponse {
  success: boolean;
  summary: SyncSummary;
}

interface BackfillProgress {
  totalOrders: number;
  currentRange: string;
  isComplete: boolean;
}

async function doSyncCall(): Promise<SyncResponse> {
  const res = await fetch('/api/tiktok/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || 'Sync failed');
  }
  return res.json();
}

export function useTikTok() {
  const { user } = useUser();
  const queryClient = useQueryClient();

  // Backfill state
  const [isBackfilling, setIsBackfilling] = useState(false);
  const [backfillProgress, setBackfillProgress] = useState<BackfillProgress | null>(null);
  const backfillAbortRef = useRef(false);

  // Auto-sync state
  const [isAutoSyncing, setIsAutoSyncing] = useState(false);
  const autoSyncRanRef = useRef(false);

  const connectionQuery = useQuery<TikTokStatusResponse>({
    queryKey: ['tiktok-status', user?.id],
    enabled: !!user,
    queryFn: async () => {
      const res = await fetch('/api/tiktok/status');
      if (!res.ok) throw new Error('Failed to fetch TikTok status');
      return res.json();
    },
    staleTime: 30_000,
  });

  const syncMutation = useMutation<SyncResponse, Error, void>({
    mutationFn: doSyncCall,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tiktok-status'] });
      queryClient.invalidateQueries({ queryKey: ['entries'] });
    },
  });

  const disconnectMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/tiktok/disconnect', { method: 'POST' });
      if (!res.ok) throw new Error('Failed to disconnect');
      return res.json();
    },
    onSuccess: () => {
      backfillAbortRef.current = true;
      setIsBackfilling(false);
      setBackfillProgress(null);
      queryClient.invalidateQueries({ queryKey: ['tiktok-status'] });
    },
  });

  // Backfill loop — runs on first connection (needsBackfill=true)
  const runBackfill = useCallback(async () => {
    setIsBackfilling(true);
    backfillAbortRef.current = false;
    let totalOrders = 0;

    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        if (backfillAbortRef.current) break;

        const result = await doSyncCall();
        const s = result.summary;
        totalOrders += s.ordersFetched;

        setBackfillProgress({
          totalOrders,
          currentRange: `${s.dateRange.startDate} — ${s.dateRange.endDate}`,
          isComplete: s.isCaughtUp && !s.hasMorePages,
        });

        if (s.isCaughtUp && !s.hasMorePages) break;
      }
    } catch {
      // Stop on error — user can manually retry
    } finally {
      setIsBackfilling(false);
      queryClient.invalidateQueries({ queryKey: ['tiktok-status'] });
      queryClient.invalidateQueries({ queryKey: ['entries'] });
    }
  }, [queryClient]);

  // Auto-sync on page load — single chunk for returning users
  const runAutoSync = useCallback(async () => {
    setIsAutoSyncing(true);
    try {
      await doSyncCall();
      queryClient.invalidateQueries({ queryKey: ['tiktok-status'] });
      queryClient.invalidateQueries({ queryKey: ['entries'] });
    } catch {
      // Silent fail for background auto-sync
    } finally {
      setIsAutoSyncing(false);
    }
  }, [queryClient]);

  // Trigger backfill or auto-sync when connection status is known
  useEffect(() => {
    const conn = connectionQuery.data?.connection;
    if (!conn || !connectionQuery.data?.connected) return;
    if (autoSyncRanRef.current) return;

    autoSyncRanRef.current = true;

    if (conn.needsBackfill) {
      runBackfill();
    } else {
      runAutoSync();
    }
  }, [connectionQuery.data, runBackfill, runAutoSync]);

  const isConnected = connectionQuery.data?.connected ?? false;
  const connection = connectionQuery.data?.connection ?? null;

  return {
    isConnected,
    connection,
    isLoading: connectionQuery.isLoading,
    isSyncing: syncMutation.isPending,
    isAutoSyncing,
    isBackfilling,
    backfillProgress,
    lastSyncResult: syncMutation.data?.summary ?? null,
    syncError: syncMutation.error?.message ?? null,
    sync: () => syncMutation.mutate(),
    disconnect: () => disconnectMutation.mutate(),
    isDisconnecting: disconnectMutation.isPending,
  };
}
