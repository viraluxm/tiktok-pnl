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

// The sync route is a Vercel function with maxDuration = 60s. Abort the client fetch just
// BELOW that (55s) so the client gives up when the server is already being killed — the old
// 90s wait meant the client kept waiting on (then re-firing) a request the platform had
// already terminated at 60s. And cap the driver at a sane number of batches per run (was 30
// — 30 hammer calls at an already-struggling server); the 5-min auto-sync resumes any
// remaining backfill on the next tick, so a lower cap costs nothing but incident load.
const SYNC_BATCH_TIMEOUT_MS = 55_000;
const MAX_SYNC_BATCHES = 10;

// ─── Single-owner election (module scope) ────────────────────────────────────
// useTikTok is mounted by BOTH RealDashboard AND TikTokConnect, so a single dashboard
// session had TWO instances, each with its own refs — each spawning a sync driver and a
// 5-min auto-sync interval → two drivers hammering /api/tiktok/sync in parallel. We elect
// ONE owner across all instances; only the owner runs the sync-driving effects. On the
// owner's unmount, ownership hands off to another still-mounted instance so the driver is
// never orphaned. React Query already dedups the shared status query, so non-owners still
// see connection state — they just don't drive sync.
let syncOwner: symbol | null = null;
const ownerClaimers = new Set<() => void>();

export function useTikTok() {
  const { user } = useUser();
  const queryClient = useQueryClient();
  const [syncProgress, setSyncProgress] = useState<SyncProgress | null>(null);
  const loopRunningRef = useRef(false);
  const loopStartedRef = useRef(false);
  const ownerIdRef = useRef<symbol | null>(null);
  if (ownerIdRef.current === null) ownerIdRef.current = Symbol('useTikTok');
  const [isOwner, setIsOwner] = useState(false);

  // Claim sync ownership on mount; release + hand off on unmount.
  useEffect(() => {
    const id = ownerIdRef.current!;
    const tryClaim = () => { if (syncOwner === null) { syncOwner = id; setIsOwner(true); } };
    ownerClaimers.add(tryClaim);
    tryClaim();
    return () => {
      ownerClaimers.delete(tryClaim);
      if (syncOwner === id) {
        syncOwner = null;
        setIsOwner(false);
        for (const claim of ownerClaimers) { claim(); if (syncOwner !== null) break; }
      }
    };
  }, []);

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
      for (let attempt = 0; attempt < MAX_SYNC_BATCHES; attempt++) {
        // 1. Fire sync call. Abort just below the 60s server maxDuration (see constant).
        console.log(`[SyncDriver] Firing sync batch ${attempt + 1}`);
        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), SYNC_BATCH_TIMEOUT_MS);
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

  // Auto-start when connected and not caught up — OWNER ONLY (see single-owner election).
  // Re-fires on STORE CHANGE too: selecting a different store invalidates ['tiktok-status'], so the
  // connection refetches with the new store's id/caught-up state. Previously loopStartedRef (a
  // once-per-mount latch) blocked the driver from re-running for the newly-selected store — so a
  // packer could sit on any tab with a store selected and nothing synced. Now a change in the
  // connection id resets the latch, kicking that store's sync from wherever useTikTok is mounted.
  const activeConnIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!isOwner) return;
    const conn = connectionQuery.data?.connection;
    if (!conn || !connectionQuery.data?.connected) return;
    if (conn.id !== activeConnIdRef.current) {
      activeConnIdRef.current = conn.id;   // new store selected → allow the driver to run for it
      loopStartedRef.current = false;
    }
    if (loopStartedRef.current) return;
    if (conn.isCaughtUp) return;

    loopStartedRef.current = true;
    runSyncDriver();
  }, [isOwner, connectionQuery.data?.connected, connectionQuery.data?.connection?.id, connectionQuery.data?.connection?.isCaughtUp, runSyncDriver]);

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

  // Auto-sync on page load + poll every 5 minutes while tab is active — OWNER ONLY.
  const autoSyncRef = useRef(false);
  useEffect(() => {
    if (!isOwner) return;
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
  }, [isOwner, connectionQuery.data?.connected, queryClient]);

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
