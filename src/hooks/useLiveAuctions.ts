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
  order_status: number | null;    // TikTok order status: 2=pending, 3=paid/recovered, 4=cancelled (frozen snapshot)
  synced_status: string | null;   // truthful refreshed TikTok status from synced_order_ids; null = not yet swept
  net_payout_cents: number | null; // true net payout (estimate or settled), from order_payouts
  payout_settled: boolean;        // true = settled actual, false = estimate (or no payout)
  buyer_handle: string | null;
  logged_at: string;
  units: number;
  total_cost_cents: number | null;
  skus: AuctionSkuLine[];
  // Captured-but-unbound sale unioned into the board (no live_auction_items row yet). Bindable
  // via /bind; carries the capture context for identification. Absent/false on normal bound rows.
  unbound?: boolean;
  order_id?: string;
  // TikTok live LOT number (order.sku_desc / synced sku_name) — a per-show sequence
  // (1,2,3…), NOT the inventory sku_number. Present on BOTH bound and unbound rows so
  // the board can be replayed in lot order and an unbound lot can borrow the SKU of its
  // nearest bound lots as a hint. Numeric for auction shows; absent/text for catalog stores.
  seller_sku_hint?: string | null;
}

const KEY = 'auction-board';

// A SKU actually sold in THIS show — the PRIMARY narrowing list for the bind picker
// (never the full catalogue). Carries category (for tertiary grouping) + barcode (scan).
export interface SessionSku {
  id: string;
  sku_number: number | null;
  title: string | null;
  category: string | null;
  barcode: string | null;
}

// Full board payload: the auction rows PLUS the ranked-picker inputs. Older callers that
// only need the rows read `.items`.
export interface BoardResponse {
  items: AuctionItem[];
  session_skus: SessionSku[];
  live_categories: string[];
  // Set when the board loaded but a non-fatal enrichment join failed (e.g. the skus
  // join degraded). The rows/sale value are still real — cost/units may be incomplete.
  // Distinguishes a degraded load from a genuine no-sales show; surfaced in the UI.
  warning: string | null;
}

export function useAuctionBoard(sessionId: string | null) {
  const { user } = useUser();

  return useQuery<BoardResponse>({
    queryKey: [KEY, sessionId, user?.id],
    enabled: !!user && !!sessionId,
    queryFn: async () => {
      const res = await fetch(`/api/live/sessions/${sessionId}/board`);
      if (!res.ok) throw new Error('Failed to load auction log');
      const json = await res.json();
      return {
        items: json.items ?? [],
        session_skus: json.session_skus ?? [],
        live_categories: json.live_categories ?? [],
        warning: json.warning ?? null,
      };
    },
    staleTime: 5_000,
  });
}

// Reverse a retroactive bind (unbind / change-SKU correction). Delegates to the
// /unbind endpoint → lensed_unbind (restock + delete). Idempotent. On success,
// refresh the board (row returns to unbound) and inventory (stock restored).
export function useUnbind(sessionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (orderId: string) => {
      const res = await fetch(`/api/live/sessions/${sessionId}/unbind`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order_id: orderId }),
      });
      if (!res.ok) {
        let msg = 'Failed to unbind';
        try { msg = (await res.json()).error || msg; } catch { /* ignore */ }
        throw new Error(msg);
      }
      return res.json() as Promise<{ ok: boolean; unbound: boolean; restocked_lines: number; restocked_units: number }>;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [KEY, sessionId] });
      qc.invalidateQueries({ queryKey: ['inventory-skus'] });
    },
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
