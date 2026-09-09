'use client';

import { useStores, useSetActiveStore } from '@/hooks/useStores';
import { useTikTok } from '@/hooks/useTikTok';

// The seller's own shop: connect it, pick which one is active, sync it.
//
// NOT a reuse of TikTokConnect. That component offers Disconnect, which DELETES the store's synced
// orders — the record of what the seller sold from our stock, and the thing we reconcile against.
// /api/tiktok/disconnect is therefore not in the seller allowlist, and rendering a button that
// 403s would be worse than not rendering it. Removal is an owner action.
//
// Every endpoint touched here (/api/stores, /api/stores/active, /api/tiktok/auth, status, sync)
// filters on the caller's own user_id, so "their shop" is resolved from their own store_members
// rows rather than from anything this component sends.
const connectHref = (storeId: string) => `/api/tiktok/auth?store_id=${encodeURIComponent(storeId)}`;
const NEW_STORE_HREF = '/api/tiktok/auth?new=1';

export default function SellerShop() {
  const { data: storesData, isLoading } = useStores();
  const setActive = useSetActiveStore();
  const { syncProgress, sync } = useTikTok();
  // useTikTok's own `isSyncing` is a hardcoded false; syncProgress is the live signal.
  const syncing = syncProgress?.isSyncing ?? false;

  const stores = storesData?.stores ?? [];
  const activeStore = storesData?.activeStore ?? 'all';

  if (isLoading) {
    return <div className="text-xs text-tt-muted">Loading your shop…</div>;
  }

  if (!stores.length) {
    return (
      <div className="rounded-xl border border-dashed border-tt-border p-6 text-center">
        <h2 className="text-sm font-semibold text-tt-text mb-1">Connect your TikTok Shop</h2>
        <p className="text-xs text-tt-muted mb-4">
          Your orders, and the labels you buy for them, stay on your own account.
        </p>
        <a
          href={NEW_STORE_HREF}
          className="inline-block px-4 py-2 rounded-lg bg-tt-cyan/15 text-tt-cyan border border-tt-cyan/30 text-xs font-semibold hover:bg-tt-cyan/25 transition-colors"
        >
          Connect a shop
        </a>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {stores.map((s) => {
        const isActive = s.id === activeStore;
        return (
          <div
            key={s.id}
            className={`rounded-xl border p-4 flex items-center justify-between gap-4 flex-wrap ${
              isActive ? 'border-tt-cyan/40 bg-tt-cyan/5' : 'border-tt-border bg-tt-card'
            }`}
          >
            <div className="min-w-0">
              <div className="text-sm font-semibold text-tt-text truncate">{s.shopName || s.name}</div>
              <div className="text-[11px] text-tt-muted">
                {s.connected ? (
                  s.needsReconnect ? (
                    <span className="text-tt-red">
                      Reconnect needed{s.reconnectBy ? ` by ${new Date(s.reconnectBy).toLocaleDateString()}` : ''}
                    </span>
                  ) : (
                    <span className="text-tt-green">Connected</span>
                  )
                ) : (
                  'Not connected'
                )}
              </div>
            </div>

            <div className="flex items-center gap-2">
              {!isActive && (
                <button
                  onClick={() => setActive.mutate(s.id)}
                  className="text-[11px] px-2.5 py-1 rounded border border-tt-border text-tt-muted hover:text-tt-cyan hover:border-tt-cyan transition-colors"
                >
                  Select
                </button>
              )}
              {/* In-place OAuth: refreshes the tokens for THIS store without touching its data. */}
              <a
                href={connectHref(s.id)}
                className="text-[11px] px-2.5 py-1 rounded border border-tt-border text-tt-muted hover:text-tt-cyan hover:border-tt-cyan transition-colors"
              >
                {s.connected ? 'Reconnect' : 'Connect'}
              </a>
              {s.connected && isActive && (
                <button
                  onClick={() => sync()}
                  disabled={syncing}
                  className="text-[11px] px-2.5 py-1 rounded border border-tt-border text-tt-muted hover:text-tt-cyan hover:border-tt-cyan transition-colors disabled:opacity-50"
                >
                  {syncing ? 'Syncing…' : 'Sync orders'}
                </button>
              )}
            </div>
          </div>
        );
      })}

      {syncProgress?.isSyncing && (
        <div className="text-[11px] text-tt-cyan">
          Syncing — {syncProgress.totalOrders.toLocaleString()} orders imported
          {syncProgress.currentRange ? ` (${syncProgress.currentRange})` : ''}
        </div>
      )}

      <a
        href={NEW_STORE_HREF}
        className="inline-block text-[11px] text-tt-muted hover:text-tt-cyan transition-colors"
      >
        + Connect another shop
      </a>
    </div>
  );
}
