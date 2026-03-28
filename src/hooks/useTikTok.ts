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
  const syncCompleteRef = useRef(false);
  const autoSyncFiredRef = useRef(false);

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
      syncCompleteRef.current = false;
      autoSyncFiredRef.current = false;
      setSyncProgress(null);
      queryClient.invalidateQueries({ queryKey: ['tiktok-status'] });
      queryClient.invalidateQueries({ queryKey: ['entries'] });
    },
  });

  const runSyncLoop = useCallback(async () => {
    if (syncCompleteRef.current) {
      console.log('[SyncLoop] Already completed, skipping');
      return;
    }

    abortRef.current = false;
    setSyncProgress({ totalOrders: 0, currentRange: '', isSyncing: true });

    try {
      let attempts = 0;
      const MAX_ATTEMPTS = 10;

      while (!abortRef.current && attempts < MAX_ATTEMPTS) {
        attempts++;
        console.log(`[SyncLoop] Attempt ${attempts}/${MAX_ATTEMPTS}`);

        // Poll status in parallel
        let pollAbort = false;
        const pollPromise = (async () => {
          while (!pollAbort && !abortRef.current) {
            await sleep(3_000);
            if (pollAbort) break;
            try {
              const st = await fetchStatus();
              if (st.connection && !pollAbort) {
                setSyncProgress({
                  totalOrders: st.connection.syncProgressOrders || 0,
                  currentRange: st.connection.syncProgressDay || '',
                  isSyncing: true,
                });
              }
            } catch { /* ignore */ }
          }
        })();

        // Fire sync call (blocks up to 5 min)
        let result: SyncResponse | null = null;
        try {
          result = await doSyncCall();
        } catch (err) {
          console.log(`[SyncLoop] Error:`, (err as Error).message);
          if ((err as Error).message === 'rate_limited') {
            pollAbort = true;
            await sleep(10_000);
            continue;
          }
        }

        pollAbort = true;

        if (!result?.summary) {
          console.log('[SyncLoop] No summary in response, retrying in 3s');
          await sleep(3_000);
          continue;
        }

        const s = result.summary;
        console.log(`[SyncLoop] isCaughtUp: ${s.isCaughtUp} — will fire again: ${!s.isCaughtUp} (attempt ${attempts}/${MAX_ATTEMPTS}, total=${s.totalUniqueOrders}, entries=${s.entriesCreated}, range=${s.dateRange.startDate}..${s.dateRange.endDate})`);

        setSyncProgress({
          totalOrders: s.totalUniqueOrders,
          currentRange: `${s.dateRange.startDate} — ${s.dateRange.endDate}`,
          isSyncing: !s.isCaughtUp,
        });

        queryClient.invalidateQueries({ queryKey: ['entries'] });

        // ONLY stop when isCaughtUp is true
        if (s.isCaughtUp === true) {
          console.log('[SyncLoop] isCaughtUp=true — DONE, setting hard stop');
          syncCompleteRef.current = true;
          break;
        }

        // Not caught up — server's time budget expired, need another call
        console.log(`[SyncLoop] Not caught up yet, waiting 2s before next call...`);
        await sleep(2_000);
      }

      if (attempts >= MAX_ATTEMPTS && !syncCompleteRef.current) {
        console.warn(`[SyncLoop] Hit ${MAX_ATTEMPTS} attempts without catching up — stopping. Click Sync to continue.`);
      }
    } catch (err) {
      console.error('[SyncLoop] Fatal:', (err as Error).message);
    } finally {
      setSyncProgress(null);
      queryClient.invalidateQueries({ queryKey: ['tiktok-status'] });
      queryClient.invalidateQueries({ queryKey: ['entries'] });
    }
  }, [queryClient]);

  // Auto-sync: fires ONCE on first connect
  useEffect(() => {
    const conn = connectionQuery.data?.connection;
    if (!conn || !connectionQuery.data?.connected) return;
    if (autoSyncFiredRef.current) return;
    if (syncCompleteRef.current) return;
    if (!conn.needsBackfill) {
      syncCompleteRef.current = true;
      return;
    }
    autoSyncFiredRef.current = true;
    console.log('[SyncLoop] Auto-starting first-time backfill');
    runSyncLoop();
  }, [connectionQuery.data, runSyncLoop]);

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
