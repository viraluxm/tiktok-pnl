'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
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
  isCaughtUp: boolean;
  syncInProgress: boolean;
  syncProgressOrders: number;
  syncProgressDay: string | null;
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

// Fire-and-forget sync trigger — no waiting for response
async function triggerSync(): Promise<void> {
  try {
    await fetch('/api/tiktok/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
  } catch {
    // Fire and forget — errors are fine, the self-chain handles retries
  }
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
  const pollingRef = useRef(false);
  const triggerFiredRef = useRef(false);

  const connectionQuery = useQuery<TikTokStatusResponse>({
    queryKey: ['tiktok-status', user?.id],
    enabled: !!user,
    queryFn: fetchStatus,
    staleTime: 10_000,
  });

  const disconnectMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/tiktok/disconnect', { method: 'POST' });
      if (!res.ok) throw new Error('Failed to disconnect');
      return res.json();
    },
    onSuccess: () => {
      pollingRef.current = false;
      triggerFiredRef.current = false;
      setSyncProgress(null);
      queryClient.invalidateQueries({ queryKey: ['tiktok-status'] });
      queryClient.invalidateQueries({ queryKey: ['entries'] });
    },
  });

  // Poll status every 3s while sync is in progress
  const startPolling = useCallback(async () => {
    if (pollingRef.current) return;
    pollingRef.current = true;
    console.log('[Sync] Polling started');

    while (pollingRef.current) {
      await sleep(3_000);
      if (!pollingRef.current) break;

      try {
        const st = await fetchStatus();
        const c = st.connection;
        if (!c) break;

        setSyncProgress({
          totalOrders: c.syncProgressOrders || 0,
          currentRange: c.syncProgressDay || '',
          isSyncing: !c.isCaughtUp,
        });

        // Refresh dashboard entries
        queryClient.invalidateQueries({ queryKey: ['entries'] });

        if (c.isCaughtUp) {
          console.log('[Sync] Caught up — stopping poll');
          pollingRef.current = false;
          setSyncProgress(null);
          queryClient.invalidateQueries({ queryKey: ['tiktok-status'] });
          break;
        }
      } catch {
        // Status fetch failed — keep polling
      }
    }

    pollingRef.current = false;
  }, [queryClient]);

  // Auto-trigger: fire sync once if not caught up, then poll
  useEffect(() => {
    const conn = connectionQuery.data?.connection;
    const connected = connectionQuery.data?.connected;
    if (!conn || !connected) return;
    if (triggerFiredRef.current) return;

    if (conn.isCaughtUp) {
      // Already caught up — nothing to do
      return;
    }

    // Not caught up — fire sync once and start polling
    triggerFiredRef.current = true;
    console.log(`[Sync] Not caught up (cursor at ${conn.syncProgressDay || 'start'}) — triggering sync`);
    triggerSync();
    startPolling();
    setSyncProgress({ totalOrders: conn.syncProgressOrders || 0, currentRange: conn.syncProgressDay || '', isSyncing: true });

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionQuery.data?.connected, connectionQuery.data?.connection?.isCaughtUp]);

  // Manual sync button
  const manualSync = useCallback(() => {
    triggerSync();
    setSyncProgress({ totalOrders: 0, currentRange: '', isSyncing: true });
    startPolling();
  }, [startPolling]);

  return {
    isConnected: connectionQuery.data?.connected ?? false,
    connection: connectionQuery.data?.connection ?? null,
    isLoading: connectionQuery.isLoading,
    isSyncing: false,
    syncProgress,
    lastSyncResult: null,
    syncError: null,
    sync: manualSync,
    disconnect: () => disconnectMutation.mutate(),
    isDisconnecting: disconnectMutation.isPending,
  };
}
