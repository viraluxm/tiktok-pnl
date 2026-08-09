'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

// Member binding queue — the first 'member' scope, rendered under the bare (station) route group
// (server layout, no app chrome). Read-only shell: it lists the cross-session unbound queue and,
// per row, lets a member pick an internal SKU. There is NO bind write yet — the confirm button is
// deliberately disabled ("binding not yet enabled"). Data comes only from the owner-scoped
// /api/member/* routes.
//
// Pagination is KEYSET (Prev/Next + page number; no jump-to-page — keyset can't). No total is
// shown — the header reports the current page, the loaded count, and whether more is available.
// (An exact total will come from a SECURITY DEFINER SQL function in a later migration pass.)

interface UnboundRow {
  order_id: string;
  tiktok_title: string | null;
  seller_sku_hint: string | null;
  won_price_cents: number | null;
  buyer_handle: string | null;
  logged_at: string;
  store_id: string | null;
}
interface Sku { id: string; sku_number: number | null; title: string | null; thumbnail_url: string | null }

function money(cents: number | null): string {
  if (cents == null) return '—';
  return `$${(cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function fmtDate(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '—';
  return new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export default function MemberBindingPage() {
  const [rows, setRows] = useState<UnboundRow[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [pageIdx, setPageIdx] = useState(0);
  const cursorsRef = useRef<(string | null | undefined)[]>([null]); // cursor to fetch each page; page 0 = null
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const [skus, setSkus] = useState<Sku[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);           // order_id
  const [picked, setPicked] = useState<Record<string, string>>({});        // order_id → sku id
  const [query, setQuery] = useState('');

  const loadPage = useCallback(async (idx: number) => {
    setLoading(true); setErr(null); setExpanded(null);
    try {
      const cursor = cursorsRef.current[idx] ?? null;
      const qs = new URLSearchParams({ limit: '50' });
      if (cursor) qs.set('cursor', cursor);
      const res = await fetch(`/api/member/unbound?${qs.toString()}`);
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Failed to load queue (${res.status})`);
      const u = await res.json();
      setRows((u.unbound ?? []) as UnboundRow[]);
      setHasMore(!!u.has_more);
      const nc = (u.next_cursor ?? null) as string | null;
      setNextCursor(nc);
      // Remember the cursor for the NEXT page so Prev/Next can revisit it.
      if (u.has_more && nc && cursorsRef.current[idx + 1] === undefined) cursorsRef.current[idx + 1] = nc;
      setPageIdx(idx);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadPage(0);
    fetch('/api/member/catalog')
      .then((r) => (r.ok ? r.json() : { skus: [] }))
      .then((d) => setSkus((d.skus ?? []) as Sku[]))
      .catch(() => { /* catalog is best-effort; the picker just shows no SKUs */ });
  }, [loadPage]);

  const filteredSkus = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return skus;
    return skus.filter((s) =>
      String(s.sku_number ?? '').includes(q) || (s.title ?? '').toLowerCase().includes(q),
    );
  }, [skus, query]);

  const skuById = useMemo(() => {
    const m = new Map<string, Sku>();
    for (const s of skus) m.set(s.id, s);
    return m;
  }, [skus]);

  return (
    <main className="min-h-screen bg-tt-bg text-tt-text p-6 max-w-3xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Binding queue</h1>
        <p className="mt-1 text-sm text-tt-muted">Captured sales with no SKU bound. Pick the right item for each.</p>
        <div className="mt-2 text-sm font-semibold text-tt-text">
          Page {pageIdx + 1} · {rows.length.toLocaleString()} loaded{hasMore ? ' · more available' : ''}
        </div>
      </div>

      {loading && rows.length === 0 && <div className="text-lg text-tt-muted">Loading queue…</div>}
      {err && <div className="rounded-xl border-2 border-tt-red/50 bg-tt-red/10 px-4 py-3 text-tt-red font-semibold">{err}</div>}

      {!loading && !err && rows.length === 0 && pageIdx === 0 && (
        <div className="rounded-2xl border border-tt-border bg-tt-card px-6 py-10 text-center text-tt-muted">
          Nothing to bind — the queue is clear.
        </div>
      )}

      <div className="space-y-3">
        {rows.map((r) => {
          const isOpen = expanded === r.order_id;
          const chosen = picked[r.order_id] ? skuById.get(picked[r.order_id]) ?? null : null;
          return (
            <div key={r.order_id} className="rounded-2xl border border-tt-border bg-tt-card overflow-hidden">
              <button
                onClick={() => { setExpanded(isOpen ? null : r.order_id); setQuery(''); }}
                className="w-full flex items-start justify-between gap-3 px-4 py-3 text-left hover:bg-tt-card-hover"
              >
                <div className="min-w-0">
                  <div className="font-semibold text-tt-text truncate">{r.tiktok_title || 'Unknown item'}</div>
                  <div className="mt-0.5 text-xs text-tt-yellow">Captured · no SKU bound</div>
                  <div className="mt-1 text-xs text-tt-muted break-all">
                    {r.seller_sku_hint ? `Lot ${r.seller_sku_hint} · ` : ''}Order #{r.order_id}
                    {r.buyer_handle ? ` · @${r.buyer_handle}` : ''} · {fmtDate(r.logged_at)}
                  </div>
                </div>
                <div className="shrink-0 text-right">
                  <div className="font-bold tabular-nums">{money(r.won_price_cents)}</div>
                  <div className="text-xs text-tt-muted">{isOpen ? 'Close' : 'Bind'}</div>
                </div>
              </button>

              {isOpen && (
                <div className="border-t border-tt-border p-4 space-y-3">
                  <input
                    autoFocus
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search SKU # or title…"
                    className="w-full rounded-lg border border-tt-border bg-white/5 px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-tt-cyan/50"
                  />
                  <div className="max-h-72 overflow-y-auto flex flex-col gap-2 pr-1">
                    {filteredSkus.length === 0 && <div className="text-sm text-tt-muted px-1 py-2">No SKUs match.</div>}
                    {filteredSkus.map((s) => {
                      const sel = picked[r.order_id] === s.id;
                      return (
                        <button
                          key={s.id}
                          onClick={() => setPicked((p) => ({ ...p, [r.order_id]: s.id }))}
                          className={`flex items-center gap-3 rounded-xl border-2 p-2 text-left ${sel ? 'border-tt-cyan bg-tt-cyan/10' : 'border-tt-border bg-tt-bg hover:bg-tt-card-hover'}`}
                        >
                          {s.thumbnail_url ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={s.thumbnail_url} alt="" className="h-12 w-12 rounded-lg object-cover border border-tt-border" onError={(e) => { e.currentTarget.style.display = 'none'; }} />
                          ) : (
                            <span className="h-12 w-12 rounded-lg border border-tt-border flex items-center justify-center font-mono text-xs text-tt-muted">#{s.sku_number ?? '?'}</span>
                          )}
                          <div className="min-w-0">
                            <div className="font-mono font-bold text-tt-text">#{s.sku_number ?? '?'}</div>
                            <div className="text-sm text-tt-muted truncate">{s.title ?? '—'}</div>
                          </div>
                          {sel && <span className="ml-auto text-tt-cyan font-bold">✓</span>}
                        </button>
                      );
                    })}
                  </div>

                  <div className="flex items-center justify-between gap-3 pt-1">
                    <div className="text-sm text-tt-muted">
                      {chosen ? <>Selected <span className="font-mono text-tt-text">#{chosen.sku_number ?? '?'}</span> {chosen.title}</> : 'No SKU selected'}
                    </div>
                    <button
                      disabled
                      title="binding not yet enabled"
                      className="rounded-lg bg-tt-card-hover px-4 py-2 text-sm font-semibold text-tt-muted cursor-not-allowed"
                    >
                      Bind — not yet enabled
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Keyset pagination — Prev/Next + page number only (no arbitrary jump). */}
      {!err && (rows.length > 0 || pageIdx > 0) && (
        <div className="mt-5 flex items-center justify-between">
          <button
            onClick={() => loadPage(pageIdx - 1)}
            disabled={pageIdx === 0 || loading}
            className="rounded-lg border border-tt-border px-4 py-2 text-sm text-tt-text hover:bg-tt-card-hover disabled:opacity-40"
          >
            ‹ Prev
          </button>
          <span className="text-sm text-tt-muted">Page {pageIdx + 1}</span>
          <button
            onClick={() => loadPage(pageIdx + 1)}
            disabled={!hasMore || loading}
            className="rounded-lg border border-tt-border px-4 py-2 text-sm text-tt-text hover:bg-tt-card-hover disabled:opacity-40"
          >
            Next ›
          </button>
        </div>
      )}
    </main>
  );
}
