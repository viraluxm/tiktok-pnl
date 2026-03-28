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
  syncInProgress: boolean;
  syncProgressOrders: number;
  syncProgressDay: string | null;
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
  ordersThisBatch: number;
  totalUniqueOrders: number;
  isCaughtUp: boolean;
  hasMorePages: boolean;
  windowsProcessed: number;
  elapsedMs: number;
}

interface SyncResponse {
  success: boolean;
  status?: string;
  summary?: SyncSummary;
}

interface SyncProgress {
  totalOrders: number;
  currentRange: string;
  isSyncing: boolean;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function doSyncCall(): Promise<SyncResponse> {
  const res = await fetch('/api/tiktok/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  if (res.status === 429) throw new Error('rate_limited');
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || 'Sync failed');
  }
  return res.json();
}

async function fetchStatus(): Promise<TikTokStatusResponse> {
  const res = await fetch('/api/tiktok/status');
  if (!res.ok) throw new Error('Failed to fetch status');
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
    queryFn: fetchStatus,
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

  // Simple sync: fire sync call (runs up to 5 min), poll status in parallel, repeat if not caught up
  const runSyncLoop = useCallback(async () => {
    abortRef.current = false;
    setSyncProgress({ totalOrders: 0, currentRange: '', isSyncing: true });

    try {
      let attempts = 0;
      while (!abortRef.current && attempts < 10) {
        attempts++;
        console.log(`[SyncLoop] Attempt ${attempts}: firing sync call...`);

        // Start polling status in parallel with the sync call
        let pollAbort = false;
        const pollLoop = (async () => {
          while (!pollAbort && !abortRef.current) {
            await sleep(3_000);
            try {
              const st = await fetchStatus();
              const c = st.connection;
              if (c) {
                setSyncProgress({
                  totalOrders: c.syncProgressOrders || 0,
                  currentRange: c.syncProgressDay || '',
                  isSyncing: true,
                });
              }
            } catch { /* ignore */ }
          }
        })();

        // Fire the actual sync call (blocks for up to 5 minutes)
        let result: SyncResponse | null = null;
        try {
          result = await doSyncCall();
        } catch (err) {
          console.log(`[SyncLoop] Sync call error:`, (err as Error).message);
          if ((err as Error).message === 'rate_limited') {
            await sleep(10_000);
          }
        }

        // Stop polling
        pollAbort = true;
        await sleep(100); // Let poll loop exit

        // Refresh data
        queryClient.invalidateQueries({ queryKey: ['entries'] });
        queryClient.invalidateQueries({ queryKey: ['tiktok-status'] });

        if (result?.summary) {
          const s = result.summary;
          console.log(`[SyncLoop] Batch done: ${s.totalUniqueOrders} total, ${s.ordersThisBatch} this batch, caught_up=${s.isCaughtUp}`);
          setSyncProgress({
            totalOrders: s.totalUniqueOrders,
            currentRange: `${s.dateRange.startDate} — ${s.dateRange.endDate}`,
            isSyncing: !s.isCaughtUp,
          });

          if (s.isCaughtUp) {
            console.log('[SyncLoop] Fully caught up!');
            break;
          }

          // Small delay before next batch
          await sleep(1_000);
        } else {
          // No result — wait before retry
          await sleep(3_000);
        }
      }
    } catch (err) {
      console.error('[SyncLoop] Fatal error:', (err as Error).message);
    } finally {
      setSyncProgress((prev: SyncProgress | null) => prev ? { ...prev, isSyncing: false } : null);
      queryClient.invalidateQueries({ queryKey: ['tiktok-status'] });
      queryClient.invalidateQueries({ queryKey: ['entries'] });
    }
  }, [queryClient]);

  // Auto-start sync when connected
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
