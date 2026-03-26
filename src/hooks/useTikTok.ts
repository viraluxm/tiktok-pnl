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
  // Also used for returning users to auto-catch-up
  const runSyncLoop = useCallback(async (isInitialBackfill: boolean) => {
    if (isInitialBackfill) {
      setIsBackfilling(true);
    } else {
      setIsAutoSyncing(true);
    }
    backfillAbortRef.current = false;
    let totalOrders = 0;
    let consecutiveErrors = 0;

    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        if (backfillAbortRef.current) break;

        let result: SyncResponse;
        try {
          result = await doSyncCall();
          consecutiveErrors = 0;
        } catch (err) {
          if (err instanceof RateLimitError) {
            // Wait 10s on rate limit, then retry same call
            await sleep(10_000);
            continue;
          }
          consecutiveErrors++;
          if (consecutiveErrors >= 3) break; // Give up after 3 consecutive non-429 errors
          await sleep(2_000);
          continue;
        }

        const s = result.summary;
        totalOrders += s.ordersFetched;

        if (isInitialBackfill) {
          setBackfillProgress({
            totalOrders,
            currentRange: `${s.dateRange.startDate} — ${s.dateRange.endDate}`,
            isComplete: s.isCaughtUp && !s.hasMorePages,
          });
        }

        if (s.isCaughtUp && !s.hasMorePages) break;

        // 2s delay between calls to avoid rate limits
        await sleep(2_000);
      }
    } finally {
      setIsBackfilling(false);
      setIsAutoSyncing(false);
      queryClient.invalidateQueries({ queryKey: ['tiktok-status'] });
      queryClient.invalidateQueries({ queryKey: ['entries'] });
    }
  }, [queryClient]);

  // Trigger backfill or auto-sync when connection status is known
  useEffect(() => {
    const conn = connectionQuery.data?.connection;
    if (!conn || !connectionQuery.data?.connected) return;
    if (autoSyncRanRef.current) return;

    autoSyncRanRef.current = true;

    // Both paths use the same loop — initial backfill shows onboarding UI,
    // returning users get a subtle "Updating..." indicator
    runSyncLoop(conn.needsBackfill);
  }, [connectionQuery.data, runSyncLoop]);

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
