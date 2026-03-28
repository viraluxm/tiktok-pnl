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
  const syncCompleteRef = useRef(false);
  const syncRunningRef = useRef(false); // true while the loop is executing

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
      syncCompleteRef.current = false;
      syncRunningRef.current = false;
      setSyncProgress(null);
      queryClient.invalidateQueries({ queryKey: ['tiktok-status'] });
      queryClient.invalidateQueries({ queryKey: ['entries'] });
    },
  });

  // The sync loop — runs independently of UI state.
  // Only starts once, runs until isCaughtUp=true or max attempts.
  // Refs prevent re-entry even if the effect re-fires.
  const startSyncLoop = useCallback(async () => {
    // Guards: prevent concurrent or duplicate loops
    if (syncCompleteRef.current) return;
    if (syncRunningRef.current) return;
    syncRunningRef.current = true;

    console.log('[SyncLoop] Starting');
    setSyncProgress({ totalOrders: 0, currentRange: '', isSyncing: true });

    try {
      let attempts = 0;
      const MAX = 10;

      while (attempts < MAX) {
        attempts++;
        console.log(`[SyncLoop] Attempt ${attempts}/${MAX}`);

        let result: SyncResponse | null = null;
        try {
          result = await doSyncCall();
        } catch (err) {
          console.log('[SyncLoop] Call error:', (err as Error).message);
          if ((err as Error).message === 'rate_limited') await sleep(10_000);
          else await sleep(3_000);
          continue;
        }

        if (!result?.summary) {
          console.log('[SyncLoop] No summary, retrying in 3s');
          await sleep(3_000);
          continue;
        }

        const s = result.summary;
        console.log(`[SyncLoop] isCaughtUp=${s.isCaughtUp}, total=${s.totalUniqueOrders}, entries=${s.entriesCreated}, range=${s.dateRange.startDate}..${s.dateRange.endDate}`);

        setSyncProgress({
          totalOrders: s.totalUniqueOrders,
          currentRange: `${s.dateRange.startDate} — ${s.dateRange.endDate}`,
          isSyncing: !s.isCaughtUp,
        });

        // Refresh dashboard data — this does NOT affect the loop
        queryClient.invalidateQueries({ queryKey: ['entries'] });

        if (s.isCaughtUp === true) {
          console.log('[SyncLoop] DONE');
          syncCompleteRef.current = true;
          break;
        }

        await sleep(2_000);
      }

      if (attempts >= MAX && !syncCompleteRef.current) {
        console.warn('[SyncLoop] Max attempts reached without catching up');
      }
    } catch (err) {
      console.error('[SyncLoop] Fatal:', (err as Error).message);
    } finally {
      syncRunningRef.current = false;
      setSyncProgress(null);
      queryClient.invalidateQueries({ queryKey: ['tiktok-status'] });
      queryClient.invalidateQueries({ queryKey: ['entries'] });
    }
  }, [queryClient]);

  // Auto-start effect — depends ONLY on connection status, not entries or UI
  useEffect(() => {
    const conn = connectionQuery.data?.connection;
    const connected = connectionQuery.data?.connected;
    if (!conn || !connected) return;

    // Already done or already running — skip
    if (syncCompleteRef.current || syncRunningRef.current) return;

    if (!conn.needsBackfill) {
      // Returning user with existing sync — mark complete, don't sync
      syncCompleteRef.current = true;
      console.log('[SyncLoop] Returning user, skipping auto-sync');
      return;
    }

    // First-time connection — start the loop
    console.log('[SyncLoop] First connect detected, starting backfill');
    startSyncLoop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionQuery.data?.connected, connectionQuery.data?.connection?.needsBackfill]);

  return {
    isConnected: connectionQuery.data?.connected ?? false,
    connection: connectionQuery.data?.connection ?? null,
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
