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
  ordersSkipped: number;
  totalUniqueOrders: number;
  isCaughtUp: boolean;
  hasMorePages: boolean;
  currentChunk: string;
  nextChunk: string;
}

interface SyncResponse {
  success: boolean;
  summary: SyncSummary;
}

interface SyncProgress {
  totalOrders: number;
  currentRange: string;
  isSyncing: boolean;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

class RateLimitError extends Error {
  constructor() { super('rate_limited'); }
}

async function doSyncCall(): Promise<SyncResponse> {
  const res = await fetch('/api/tiktok/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  if (res.status === 429) {
    throw new RateLimitError();
  }
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || 'Sync failed');
  }
  return res.json();
}

export function useTikTok() {
  const { user } = useUser();
  const queryClient = useQueryClient();

  const [syncProgress, setSyncProgress] = useState<SyncProgress | null>(null);
  const abortRef = useRef(false);
  const loopRanRef = useRef(false);

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
      abortRef.current = true;
      setSyncProgress(null);
      loopRanRef.current = false;
      queryClient.invalidateQueries({ queryKey: ['tiktok-status'] });
      queryClient.invalidateQueries({ queryKey: ['entries'] });
    },
  });

  const runSyncLoop = useCallback(async () => {
    abortRef.current = false;
    let consecutiveErrors = 0;
    let iteration = 0;

    setSyncProgress({ totalOrders: 0, currentRange: '', isSyncing: true });

    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        iteration++;

        if (abortRef.current) {
          console.log(`[SyncLoop] Aborted at iteration ${iteration}`);
          break;
        }

        let result: SyncResponse;
        try {
          result = await doSyncCall();
          consecutiveErrors = 0;
        } catch (err) {
          if (err instanceof RateLimitError) {
            console.log(`[SyncLoop] Iteration ${iteration}: Rate limited, waiting 10s...`);
            await sleep(10_000);
            continue;
          }
          consecutiveErrors++;
          console.log(`[SyncLoop] Iteration ${iteration}: Error (${consecutiveErrors}/5):`, (err as Error).message);
          if (consecutiveErrors >= 5) {
            console.log(`[SyncLoop] Giving up after 5 consecutive errors at iteration ${iteration}`);
            break;
          }
          await sleep(500);
          continue;
        }

        const s = result.summary;

        console.log(`[SyncLoop] Iteration ${iteration}: caught_up=${s.isCaughtUp}, more_pages=${s.hasMorePages}, new=${s.ordersFetched}, skipped=${s.ordersSkipped}, total=${s.totalUniqueOrders}, chunk=${s.currentChunk}, next=${s.nextChunk}`);

        // Update progress banner
        setSyncProgress({
          totalOrders: s.totalUniqueOrders,
          currentRange: `${s.dateRange.startDate} — ${s.dateRange.endDate}`,
          isSyncing: true,
        });

        // Refresh dashboard data after every call
        queryClient.invalidateQueries({ queryKey: ['entries'] });

        // ONLY stop when fully caught up
        if (s.isCaughtUp && !s.hasMorePages) {
          console.log(`[SyncLoop] Fully caught up at iteration ${iteration}`);
          break;
        }

        await sleep(500);
      }
    } finally {
      setSyncProgress(prev => prev ? { ...prev, isSyncing: false } : null);
      queryClient.invalidateQueries({ queryKey: ['tiktok-status'] });
      queryClient.invalidateQueries({ queryKey: ['entries'] });
    }
  }, [queryClient]);

  // Auto-start sync loop when connected
  useEffect(() => {
    const conn = connectionQuery.data?.connection;
    if (!conn || !connectionQuery.data?.connected) return;
    if (loopRanRef.current) return;

    loopRanRef.current = true;
    runSyncLoop();
  }, [connectionQuery.data, runSyncLoop]);

  const isConnected = connectionQuery.data?.connected ?? false;
  const connection = connectionQuery.data?.connection ?? null;

  return {
    isConnected,
    connection,
    isLoading: connectionQuery.isLoading,
    isSyncing: syncMutation.isPending,
    syncProgress,
    lastSyncResult: syncMutation.data?.summary ?? null,
    syncError: syncMutation.error?.message ?? null,
    sync: () => syncMutation.mutate(),
    disconnect: () => disconnectMutation.mutate(),
    isDisconnecting: disconnectMutation.isPending,
  };
}
