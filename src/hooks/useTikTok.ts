'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useUser } from './useUser';

interface TikTokConnection {
  id: string;
  shopName: string | null;
  hasShop: boolean;
  advertiserCount: number;
  connectedAt: string;
  lastSyncedAt: string | null;
  needsBackfill: boolean;
  isCaughtUp: boolean;
  syncInProgress: boolean;
  syncProgressOrders: number;
  syncProgressDay: string | null;
  shopLogo: string | null;
}

interface TikTokStatusResponse {
  connected: boolean;
  connection: TikTokConnection | null;
}

interface SyncProgress {
  totalOrders: number;
  currentRange: string;
  isSyncing: boolean;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export function useTikTok() {
  const { user } = useUser();
  const queryClient = useQueryClient();
  const [syncProgress, setSyncProgress] = useState<SyncProgress | null>(null);
  const loopRunningRef = useRef(false);
  const loopStartedRef = useRef(false);

  const connectionQuery = useQuery<TikTokStatusResponse>({
    queryKey: ['tiktok-status', user?.id],
    enabled: !!user,
    queryFn: async () => {
      const res = await fetch('/api/tiktok/status');
      if (!res.ok) throw new Error('Status fetch failed');
      return res.json();
    },
    staleTime: 10_000,
  });

  // The sync driver: fire sync, poll status, repeat until caught up
  const runSyncDriver = useCallback(async () => {
    if (loopRunningRef.current) return;
    loopRunningRef.current = true;
    setSyncProgress({ totalOrders: 0, currentRange: '', isSyncing: true });
    console.log('[SyncDriver] Starting');

    try {
      for (let attempt = 0; attempt < 30; attempt++) {
        // 1. Fire sync call (with 90s timeout to handle slow batches)
        console.log(`[SyncDriver] Firing sync batch ${attempt + 1}`);
        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 90_000);
          const res = await fetch('/api/tiktok/sync', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: controller.signal,
          });
          clearTimeout(timeout);

          if (res.ok) {
            const data = await res.json();
            if (data.summary) {
              console.log(`[SyncDriver] Batch done: caught_up=${data.summary.isCaughtUp}, orders=${data.summary.totalUniqueOrders}, cursor=${data.summary.currentDay}`);
              setSyncProgress({
                totalOrders: data.summary.totalUniqueOrders || 0,
                currentRange: data.summary.currentDay || '',
                isSyncing: !data.summary.isCaughtUp,
              });
              queryClient.invalidateQueries({ queryKey: ['entries'] });

              if (data.summary.isCaughtUp) {
                console.log('[SyncDriver] CAUGHT UP — syncing videos');
                // Sync video analytics after orders are caught up
                try {
                  await fetch('/api/tiktok/sync-videos', { method: 'POST' });
                  queryClient.invalidateQueries({ queryKey: ['shop-videos-metrics'] });
                  console.log('[SyncDriver] Video sync complete');
                } catch (e) { console.log('[SyncDriver] Video sync error:', e); }
                break;
              }
            }
          }
        } catch (err) {
          // Timeout or network error — check status and continue
          console.log('[SyncDriver] Call error:', (err as Error).name);
        }

        // 2. Brief pause, then poll status to update progress
        await sleep(2_000);
        try {
          const st = await fetch('/api/tiktok/status').then(r => r.json()) as TikTokStatusResponse;
          if (st.connection) {
            setSyncProgress({
              totalOrders: st.connection.syncProgressOrders || 0,
              currentRange: st.connection.syncProgressDay || '',
              isSyncing: !st.connection.isCaughtUp,
            });
            queryClient.invalidateQueries({ queryKey: ['entries'] });

            if (st.connection.isCaughtUp) {
              console.log('[SyncDriver] Status says caught up — done');
              break;
            }
          }
        } catch { /* ignore */ }
      }
    } finally {
      loopRunningRef.current = false;
      setSyncProgress(null);
      queryClient.invalidateQueries({ queryKey: ['tiktok-status'] });
      queryClient.invalidateQueries({ queryKey: ['entries'] });
      console.log('[SyncDriver] Finished');
    }
  }, [queryClient]);

  // Auto-start when connected and not caught up
  useEffect(() => {
    const conn = connectionQuery.data?.connection;
    if (!conn || !connectionQuery.data?.connected) return;
    if (loopStartedRef.current) return;
    if (conn.isCaughtUp) return;

    loopStartedRef.current = true;
    runSyncDriver();
  }, [connectionQuery.data?.connected, connectionQuery.data?.connection?.isCaughtUp, runSyncDriver]);

  // Disconnect
  const disconnect = useCallback(async () => {
    try {
      await fetch('/api/tiktok/disconnect', { method: 'POST' });
    } catch { /* ignore */ }
    loopStartedRef.current = false;
    loopRunningRef.current = false;
    setSyncProgress(null);
    queryClient.invalidateQueries({ queryKey: ['tiktok-status'] });
    queryClient.invalidateQueries({ queryKey: ['entries'] });
  }, [queryClient]);

  // Manual sync
  const sync = useCallback(() => {
    loopStartedRef.current = false;
    loopRunningRef.current = false;
    runSyncDriver();
  }, [runSyncDriver]);

  // Auto-sync on page load + poll every 5 minutes while tab is active
  const autoSyncRef = useRef(false);
  useEffect(() => {
    if (!connectionQuery.data?.connected || autoSyncRef.current) return;
    autoSyncRef.current = true;

    // Sync on first load (silent — no spinner)
    const doSilentSync = async () => {
      if (loopRunningRef.current) return;
      try {
        const res = await fetch('/api/tiktok/sync', { method: 'POST' });
        if (res.ok) {
          queryClient.invalidateQueries({ queryKey: ['entries'] });
          queryClient.invalidateQueries({ queryKey: ['product-stats'] });
          // Also sync videos silently
          fetch('/api/tiktok/sync-videos', { method: 'POST' }).then(() => {
            queryClient.invalidateQueries({ queryKey: ['shop-videos-metrics'] });
          }).catch(() => {});
        }
      } catch { /* silent */ }
    };

    doSilentSync();

    // Poll every 5 minutes while tab is visible
    const interval = setInterval(() => {
      if (document.visibilityState === 'visible' && !loopRunningRef.current) {
        doSilentSync();
      }
    }, 5 * 60 * 1000);

    return () => clearInterval(interval);
  }, [connectionQuery.data?.connected, queryClient]);

  return {
    isConnected: connectionQuery.data?.connected ?? false,
    connection: connectionQuery.data?.connection ?? null,
    isLoading: connectionQuery.isLoading,
    isSyncing: false,
    syncProgress,
    lastSyncResult: null,
    syncError: null,
    sync,
    disconnect,
    isDisconnecting: false,
  };
}
