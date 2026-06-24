'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useUser } from './useUser';

export type AuctionResult = 'sold' | 'not_sold' | 'canceled' | 'manual';

export interface AuctionSkuLine {
  inventory_sku_id: string;
  sku_number: number;
  title: string;
  qty: number;
  unit_cost_cents: number | null;
}

export interface AuctionItem {
  id: string;
  auction_number: number;
  status: AuctionResult;
  is_bundle: boolean;
  expected_price_cents: number | null;
  sold_price_cents: number | null;
  won_price_cents: number | null; // real winning bid, joined from capture_events
  tiktok_title: string | null;    // TikTok product_name, joined from capture_events
  payment_failed: boolean;        // captured sale had a failed payment (logged not_sold)
  net_payout_cents: number | null; // true net payout (estimate or settled), from order_payouts
  payout_settled: boolean;        // true = settled actual, false = estimate (or no payout)
  buyer_handle: string | null;
  logged_at: string;
  units: number;
  total_cost_cents: number | null;
  skus: AuctionSkuLine[];
}

const KEY = 'auction-board';

export function useAuctionBoard(sessionId: string | null) {
  const { user } = useUser();

  return useQuery<AuctionItem[]>({
    queryKey: [KEY, sessionId, user?.id],
    enabled: !!user && !!sessionId,
    queryFn: async () => {
      const res = await fetch(`/api/live/sessions/${sessionId}/board`);
      if (!res.ok) throw new Error('Failed to load auction log');
      const json = await res.json();
      return json.items ?? [];
    },
    staleTime: 5_000,
  });
}

export interface QuickCloseInput {
  sessionId: string;
  result: AuctionResult;
  skus: { sku_id: string; qty: number }[];
  client_idempotency_key: string;
}

export function useQuickClose() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ sessionId, result, skus, client_idempotency_key }: QuickCloseInput) => {
      const res = await fetch(`/api/live/sessions/${sessionId}/quick-close`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ result, skus, client_idempotency_key }),
      });
      if (!res.ok) {
        let msg = 'Failed to log auction';
        try {
          const j = await res.json();
          msg = j.error || msg;
        } catch {
          /* ignore */
        }
        throw new Error(msg);
      }
      return res.json();
    },
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: [KEY, vars.sessionId] });
      // Sold decrements stock, so refresh the inventory selector too.
      qc.invalidateQueries({ queryKey: ['inventory-skus'] });
    },
  });
}

export function useDeleteAuctionItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ sessionId, itemId }: { sessionId: string; itemId: string }) => {
      const res = await fetch(`/api/live/sessions/${sessionId}/items/${itemId}`, { method: 'DELETE' });
      if (!res.ok) {
        let msg = 'Failed to delete auction row';
        try {
          const j = await res.json();
          msg = j.error || msg;
        } catch {
          /* ignore */
        }
        throw new Error(msg);
      }
      return res.json();
    },
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: [KEY, vars.sessionId] });
      qc.invalidateQueries({ queryKey: ['inventory-skus'] }); // restored stock on sold delete
    },
  });
}
