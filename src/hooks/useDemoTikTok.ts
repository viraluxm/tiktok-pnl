'use client';

import { useState } from 'react';
import { DEMO_SHOP_NAME } from '@/lib/demo/data';

/**
 * Drop-in replacement for useTikTok() when in demo mode.
 * Simulates a connected TikTok Shop with fake sync behavior.
 */
export function useDemoTikTok() {
  const [isSyncing, setIsSyncing] = useState(false);
  const [lastSyncResult, setLastSyncResult] = useState<{
    dateRange: { startDate: string; endDate: string };
    entriesCreated: number;
    entriesUpdated: number;
    errors?: string[];
  } | null>(null);

  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 86400000);

  return {
    isConnected: true,
    connection: {
      id: 'demo-connection-001',
      shopName: DEMO_SHOP_NAME,
      hasShop: true,
      advertiserCount: 2,
      connectedAt: new Date(now.getTime() - 45 * 86400000).toISOString(),
      lastSyncedAt: new Date(now.getTime() - 2 * 3600000).toISOString(), // 2 hours ago
    },
    isLoading: false,
    isSyncing,
    lastSyncResult,
    syncError: null,
    sync: (days?: number) => {
      setIsSyncing(true);
      setLastSyncResult(null);
      // Simulate a sync delay
      setTimeout(() => {
        const d = days || 30;
        const start = new Date(now.getTime() - d * 86400000);
        setLastSyncResult({
          dateRange: {
            startDate: start.toISOString().split('T')[0],
            endDate: now.toISOString().split('T')[0],
          },
          entriesCreated: 0,
          entriesUpdated: Math.floor(Math.random() * 5) + 3,
        });
        setIsSyncing(false);
      }, 2000);
    },
    disconnect: () => {
      // No-op in demo mode
    },
    isDisconnecting: false,
  };
}
