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

class RateLimitError extends Error {
  constructor() { super('rate_limited'); }
}

async function doSyncCall(): Promise<SyncResponse> {
  const res = await fetch('/api/tiktok/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  if (res.status === 429) throw new RateLimitError();
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

  const runSyncLoop = useCallback(async () => {
    abortRef.current = false;
    setSyncProgress({ totalOrders: 0, currentRange: '', isSyncing: true });

    try {
      // Step 1: Fire the sync call (may run for up to 5 minutes)
      console.log('[SyncLoop] Starting sync call...');
      let result: SyncResponse;
      try {
        result = await doSyncCall();
      } catch (err) {
        if (err instanceof RateLimitError) {
          console.log('[SyncLoop] Rate limited, will retry...');
          await sleep(10_000);
          result = await doSyncCall();
        } else {
          throw err;
        }
      }

      // If we got "already_syncing", just poll status for progress
      if (result.status === 'already_syncing') {
        console.log('[SyncLoop] Another sync is running, polling status...');
      }

      // Step 2: Poll status for progress while sync is in progress
      // (The sync call above may have completed, or another instance may be running)
      let pollCount = 0;
      while (!abortRef.current) {
        pollCount++;
        await sleep(2_000);

        try {
          const status = await fetchStatus();
          const conn = status.connection;
          if (!conn) break;

          // Update progress from status endpoint
          setSyncProgress({
            totalOrders: conn.syncProgressOrders || 0,
            currentRange: conn.syncProgressDay || '',
            isSyncing: conn.syncInProgress,
          });

          queryClient.invalidateQueries({ queryKey: ['entries'] });

          if (!conn.syncInProgress) {
            console.log(`[SyncLoop] Sync complete after ${pollCount} polls`);
            // Check if we need another batch (not caught up yet)
            if (conn.needsBackfill || !conn.lastSyncedAt) {
              // Trigger another sync call
              console.log('[SyncLoop] Not caught up, starting another batch...');
              try {
                await doSyncCall();
              } catch {
                break;
              }
              continue; // Keep polling
            }
            break;
          }

          if (pollCount % 10 === 0) {
            console.log(`[SyncLoop] Poll ${pollCount}: ${conn.syncProgressOrders} orders, day=${conn.syncProgressDay}`);
          }
        } catch {
          // Status fetch failed — just keep polling
        }
      }

      // Final refresh
      queryClient.invalidateQueries({ queryKey: ['tiktok-status'] });
      queryClient.invalidateQueries({ queryKey: ['entries'] });

      // If the first sync completed and returned data, log it
      if (result.summary) {
        const s = result.summary;
        console.log(`[SyncLoop] Final: ${s.totalUniqueOrders} total, ${s.ordersThisBatch} this batch, ${s.elapsedMs}ms`);
      }
    } catch (err) {
      console.error('[SyncLoop] Error:', (err as Error).message);
    } finally {
      setSyncProgress((prev: SyncProgress | null) => prev ? { ...prev, isSyncing: false } : null);
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

    // If a sync is already in progress (e.g. from another tab), just poll status
    if (conn.syncInProgress) {
      setSyncProgress({
        totalOrders: conn.syncProgressOrders || 0,
        currentRange: conn.syncProgressDay || '',
        isSyncing: true,
      });
      // Start polling
      runSyncLoop();
    } else {
      runSyncLoop();
    }
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
