'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import MemberNav from '@/components/member/MemberNav';

// Member binding queue — the first 'member' scope, rendered under the bare (station) route group
// (server layout, no app chrome). Lists the cross-session unbound queue; expanding a row lets the
// member pick the live session and the internal SKU line(s) and BIND the order via the owner-scoped
// /api/member/* routes. Binding is live.
//
// Pagination is KEYSET (Prev/Next + page number; no jump-to-page — keyset can't). No total is shown
// — the header reports the current page, the loaded count, and whether more is available.

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
interface SessionCandidate {
  id: string; started_at: string | null; ended_at: string | null; host_name: string | null;
  store_id: string | null; store_name: string | null; channel_handle: string | null;
  // Room-only fallback: in_window is false when no session's window contained the order and the
  // member is picking by room. seq_min/seq_max/bound_count help match the order's lot #.
  in_window: boolean; seq_min: number | null; seq_max: number | null; bound_count: number;
}
interface Line { sku_id: string; qty: number }

type DateFilter = 'today' | '7d' | '30d' | 'all';
const DATE_PILLS: Array<[DateFilter, string]> = [['today', 'Today'], ['7d', '7 days'], ['30d', '30 days'], ['all', 'All']];

function money(cents: number | null): string {
  if (cents == null) return '—';
  return `$${(cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function fmtDate(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '—';
  return new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
function fmtDateTime(iso: string | null): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '—';
  return new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
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
  const [expanded, setExpanded] = useState<string | null>(null); // order_id
  const activeOrderRef = useRef<string | null>(null);            // guards against out-of-order session fetches
  const [query, setQuery] = useState('');

  // Store filter (pills). null = All stores. The ref lets the stable loadPage read the current
  // filter without re-creating; selectStore keeps them in sync and resets the keyset to page 1.
  const [stores, setStores] = useState<{ id: string; name: string | null }[]>([]);
  const [selectedStore, setSelectedStore] = useState<string | null>(null); // store uuid | 'unmapped' | null(all)
  const selectedStoreRef = useRef<string | null>(null);

  // Date filter (pills). Default 7 days. Ref mirrors it for the stable loadPage.
  const [dateFilter, setDateFilter] = useState<DateFilter>('7d');
  const dateFilterRef = useRef<DateFilter>('7d');
  const [hasUnmapped, setHasUnmapped] = useState(false); // any null-store rows in the current date range
  const [copiedOrder, setCopiedOrder] = useState<string | null>(null);

  // ── Working state for the single expanded row ──
  const [sessions, setSessions] = useState<SessionCandidate[]>([]);
  const [sessLoading, setSessLoading] = useState(false);
  const [sessErr, setSessErr] = useState<string | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [binding, setBinding] = useState(false);
  const [bindErr, setBindErr] = useState<string | null>(null);
  const [outOfStock, setOutOfStock] = useState(false); // set after a 409 out-of-stock → reveal "Bind anyway"

  const resetWorking = () => {
    setQuery(''); setSessions([]); setSessErr(null); setSelectedSessionId(null);
    setLines([]); setBindErr(null); setOutOfStock(false); setSessLoading(false);
  };

  const loadPage = useCallback(async (idx: number) => {
    setLoading(true); setErr(null); setExpanded(null); activeOrderRef.current = null;
    try {
      const cursor = cursorsRef.current[idx] ?? null;
      const qs = new URLSearchParams({ limit: '50', date: dateFilterRef.current });
      if (cursor) qs.set('cursor', cursor);
      if (selectedStoreRef.current) qs.set('store_id', selectedStoreRef.current);
      const res = await fetch(`/api/member/unbound?${qs.toString()}`);
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Failed to load queue (${res.status})`);
      const u = await res.json();
      setRows((u.unbound ?? []) as UnboundRow[]);
      setHasMore(!!u.has_more);
      const nc = (u.next_cursor ?? null) as string | null;
      setNextCursor(nc);
      if (u.has_more && nc && cursorsRef.current[idx + 1] === undefined) cursorsRef.current[idx + 1] = nc;
      setPageIdx(idx);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  // Switch the store filter: keyset can't resume across a different filter, so reset to page 1.
  const selectStore = useCallback((storeId: string | null) => {
    if (selectedStoreRef.current === storeId) return;
    selectedStoreRef.current = storeId;
    setSelectedStore(storeId);
    cursorsRef.current = [null]; // drop all page cursors — new filter starts fresh
    setNextCursor(null);
    loadPage(0);
  }, [loadPage]);

  // Probe whether any null-store ("unmapped") rows exist in the given date range → drives the
  // Unmapped pill. Bounded to the range (cheap for Today/7d/30d; a wider scan for All).
  const probeUnmapped = useCallback((d: DateFilter) => {
    fetch(`/api/member/unbound?store_id=unmapped&date=${d}&limit=1`)
      .then((r) => (r.ok ? r.json() : { unbound: [], has_more: false }))
      .then((j) => setHasUnmapped(((j.unbound ?? []).length > 0) || !!j.has_more))
      .catch(() => setHasUnmapped(false));
  }, []);

  // Switch the date filter: reset the keyset to page 1 and re-probe the unmapped bucket.
  const selectDate = useCallback((d: DateFilter) => {
    if (dateFilterRef.current === d) return;
    dateFilterRef.current = d;
    setDateFilter(d);
    cursorsRef.current = [null];
    setNextCursor(null);
    loadPage(0);
    probeUnmapped(d);
  }, [loadPage, probeUnmapped]);

  const copyOrder = (oid: string) => {
    navigator.clipboard?.writeText(oid)
      .then(() => { setCopiedOrder(oid); setTimeout(() => setCopiedOrder((c) => (c === oid ? null : c)), 1500); })
      .catch(() => { /* clipboard blocked — no-op */ });
  };

  useEffect(() => {
    loadPage(0);
    fetch('/api/member/catalog')
      .then((r) => (r.ok ? r.json() : { skus: [] }))
      .then((d) => setSkus((d.skus ?? []) as Sku[]))
      .catch(() => { /* catalog is best-effort; the picker just shows no SKUs */ });
    fetch('/api/member/stores')
      .then((r) => (r.ok ? r.json() : { stores: [] }))
      .then((d) => setStores((d.stores ?? []) as { id: string; name: string | null }[]))
      .catch(() => { /* best-effort; no pills if it fails */ });
    probeUnmapped('7d');
  }, [loadPage, probeUnmapped]);

  const loadSessions = useCallback(async (orderId: string) => {
    setSessLoading(true); setSessErr(null); setSessions([]); setSelectedSessionId(null);
    try {
      const res = await fetch(`/api/member/sessions?order_id=${encodeURIComponent(orderId)}`);
      const json = await res.json().catch(() => ({}));
      if (activeOrderRef.current !== orderId) return; // a different row was opened meanwhile
      if (!res.ok) { setSessErr(json.error || `Failed to load sessions (${res.status})`); return; }
      const cands = (json.sessions ?? []) as SessionCandidate[];
      setSessions(cands);
      // Auto-select a lone candidate ONLY when it is in-window — an out-of-window (room-only)
      // session mis-attributes show totals, so it always requires an explicit pick.
      if (cands.length === 1 && cands[0].in_window) setSelectedSessionId(cands[0].id);
    } catch (e) {
      if (activeOrderRef.current === orderId) setSessErr((e as Error).message);
    } finally {
      if (activeOrderRef.current === orderId) setSessLoading(false);
    }
  }, []);

  const openRow = (orderId: string) => {
    if (expanded === orderId) { setExpanded(null); activeOrderRef.current = null; resetWorking(); return; }
    setExpanded(orderId); activeOrderRef.current = orderId; resetWorking();
    loadSessions(orderId);
  };

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

  const addLine = (sku_id: string) => {
    setLines((ls) => (ls.some((l) => l.sku_id === sku_id) ? ls : [...ls, { sku_id, qty: 1 }]));
    setBindErr(null); setOutOfStock(false);
  };
  const setLineQty = (sku_id: string, qty: number) =>
    setLines((ls) => ls.map((l) => (l.sku_id === sku_id ? { ...l, qty: Math.max(1, qty) } : l)));
  const removeLine = (sku_id: string) => setLines((ls) => ls.filter((l) => l.sku_id !== sku_id));

  const canBind = !!expanded && !!selectedSessionId && lines.length > 0 && !binding;

  // Room-only fallback state for the expanded row. `fallbackMode` = candidates exist but none is
  // in-window (the member is picking by room); `selectedOutOfWindow` gates the bind-time caution.
  const selectedSession = sessions.find((s) => s.id === selectedSessionId) ?? null;
  const fallbackMode = sessions.length > 0 && sessions.every((s) => !s.in_window);
  const selectedOutOfWindow = !!selectedSession && !selectedSession.in_window;

  const doBind = async (allowNegative: boolean) => {
    if (!expanded || !selectedSessionId || lines.length === 0) return;
    const orderId = expanded;
    setBinding(true); setBindErr(null);
    try {
      const res = await fetch('/api/member/bind', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order_id: orderId, session_id: selectedSessionId, lines, allow_negative: allowNegative }),
      });
      const json = await res.json().catch(() => ({}));
      if (res.ok) {
        // Success: drop the row locally, no refetch.
        setRows((rs) => rs.filter((r) => r.order_id !== orderId));
        setExpanded(null); activeOrderRef.current = null; resetWorking();
        return;
      }
      // 409 out-of-stock → offer the explicit negative-stock override (never the first action).
      if (res.status === 409 && /out of stock/i.test(String(json.error ?? ''))) {
        setOutOfStock(true);
        setBindErr(String(json.error ?? 'Out of stock'));
        return;
      }
      // Everything else (incl. a 409 SESSION_ENDED, which should not happen — the route sends
      // p_manual: true) surfaces verbatim on the row; never a silent no-op.
      setBindErr(String(json.error ?? `Bind failed (${res.status})`));
    } catch (e) {
      setBindErr((e as Error).message);
    } finally {
      setBinding(false);
    }
  };

  const showUnmapped = hasUnmapped || selectedStore === 'unmapped';
  const storeButtons: { value: string; label: string }[] = [
    ...stores.map((s) => ({ value: s.id, label: s.name ?? s.id })),
    ...(showUnmapped ? [{ value: 'unmapped', label: 'Unmapped' }] : []),
  ];
  const showAllPill = storeButtons.length > 1; // "All stores" only meaningful with >1 bucket
  const pillCls = (active: boolean) =>
    `px-3 py-1.5 rounded-full text-xs font-semibold transition-all ${active ? 'bg-tt-cyan text-black' : 'bg-tt-card-hover text-tt-muted hover:text-tt-text'}`;

  return (
    <main className="min-h-screen bg-tt-bg text-tt-text p-6 max-w-3xl mx-auto">
      <MemberNav active="binding" />
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Binding queue</h1>
        <p className="mt-1 text-sm text-tt-muted">Captured sales with no SKU bound. Pick the session and item for each.</p>
        <div className="mt-2 text-sm font-semibold text-tt-text">
          Page {pageIdx + 1} · {rows.length.toLocaleString()} loaded{hasMore ? ' · more available' : ''}
        </div>
      </div>

      {/* Date filter pills (default 7 days). Today/7d/30d scan newest-first, bounded at the PT
          day-start so the scan seeds at the bound; All is the oldest-first backlog. */}
      <div className="mb-2 flex flex-wrap gap-1">
        {DATE_PILLS.map(([v, label]) => (
          <button key={v} onClick={() => selectDate(v)} className={pillCls(dateFilter === v)}>{label}</button>
        ))}
      </div>

      {/* Store filter pills + an "Unmapped" pill when null-store rows exist in this range. Both
          filters compose (store + date); selecting refetches from page 1. A single-store member with
          nothing unmapped sees just their store as a label pill. */}
      {storeButtons.length > 0 && (
        <div className="mb-4 flex flex-wrap gap-1">
          {showAllPill && (
            <button onClick={() => selectStore(null)} className={pillCls(selectedStore === null)}>All stores</button>
          )}
          {storeButtons.map((b) => {
            const active = selectedStore === b.value || (!showAllPill && selectedStore === null);
            return (
              <button key={b.value} onClick={() => selectStore(b.value)} className={pillCls(active)}>{b.label}</button>
            );
          })}
        </div>
      )}

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
          const noSessions = isOpen && !sessLoading && !sessErr && sessions.length === 0;
          return (
            <div key={r.order_id} className="rounded-2xl border border-tt-border bg-tt-card overflow-hidden">
              <button
                onClick={() => openRow(r.order_id)}
                className="w-full flex items-start justify-between gap-3 px-4 py-3 text-left hover:bg-tt-card-hover"
              >
                <div className="min-w-0">
                  <div className="font-semibold text-tt-text truncate">{r.tiktok_title || 'Unknown item'}</div>
                  <div className="mt-0.5 text-xs text-tt-yellow">Captured · no SKU bound</div>
                  <div className="mt-1 text-xs text-tt-muted break-all">
                    {r.seller_sku_hint ? `Lot ${r.seller_sku_hint} · ` : ''}Order #{r.order_id}
                    {/* Copy the order number. A span (not a nested button) with stopPropagation so it
                        doesn't toggle the row open. */}
                    <span
                      role="button"
                      tabIndex={0}
                      onClick={(e) => { e.stopPropagation(); copyOrder(r.order_id); }}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); e.preventDefault(); copyOrder(r.order_id); } }}
                      className="ml-1 inline-flex items-center rounded px-1 py-0.5 text-[10px] font-semibold text-tt-cyan hover:bg-tt-cyan/10 cursor-pointer align-middle select-none"
                      title="Copy order number"
                    >
                      {copiedOrder === r.order_id ? 'Copied' : 'Copy'}
                    </span>
                    {r.buyer_handle ? ` · @${r.buyer_handle}` : ''} · {fmtDate(r.logged_at)}
                  </div>
                </div>
                <div className="shrink-0 text-right">
                  <div className="font-bold tabular-nums">{money(r.won_price_cents)}</div>
                  <div className="text-xs text-tt-muted">{isOpen ? 'Close' : 'Bind'}</div>
                </div>
              </button>

              {isOpen && (
                <div className="border-t border-tt-border p-4 space-y-4">
                  {/* ── Session picker ── */}
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <div className="text-[11px] uppercase tracking-wide text-tt-muted">Live session</div>
                      {/* Order's lot # — prominent so the member can match it to a session's auction
                          range (esp. in the room-only fallback where the time window is no help). */}
                      {r.seller_sku_hint && (
                        <div className="rounded-md bg-tt-cyan/15 px-2 py-0.5 text-xs font-bold text-tt-cyan tabular-nums">
                          This order · Lot #{r.seller_sku_hint}
                        </div>
                      )}
                    </div>
                    {sessLoading && <div className="text-sm text-tt-muted">Loading sessions…</div>}
                    {sessErr && <div className="text-sm text-tt-red">{sessErr}</div>}
                    {noSessions && (
                      <div className="rounded-lg border-2 border-tt-yellow/40 bg-tt-yellow/10 px-3 py-2 text-sm text-tt-yellow">
                        No live session carries this order&apos;s room — nothing to bind into.
                      </div>
                    )}
                    {/* Room-only fallback: no session's time window contains this order, so the member
                        picks by room. Say so plainly and point them at the lot #/auction-range match. */}
                    {!sessLoading && !sessErr && fallbackMode && (
                      <div className="mb-2 rounded-lg border-2 border-tt-yellow/40 bg-tt-yellow/10 px-3 py-2 text-sm text-tt-yellow">
                        No session&apos;s time window contains this order. Picking by room — match Lot #{r.seller_sku_hint ?? '—'} to a session&apos;s auction range below.
                      </div>
                    )}
                    {!sessLoading && !sessErr && sessions.length > 0 && (
                      <div className="flex flex-col gap-2">
                        {sessions.map((s) => {
                          const sel = selectedSessionId === s.id;
                          const seqRange = s.seq_min != null && s.seq_max != null
                            ? (s.seq_min === s.seq_max ? `#${s.seq_min}` : `#${s.seq_min}–#${s.seq_max}`)
                            : null;
                          return (
                            <button
                              key={s.id}
                              onClick={() => { setSelectedSessionId(s.id); setBindErr(null); setOutOfStock(false); }}
                              className={`flex items-center gap-3 rounded-xl border-2 px-3 py-2 text-left ${sel ? 'border-tt-cyan bg-tt-cyan/10' : 'border-tt-border bg-tt-bg hover:bg-tt-card-hover'}`}
                            >
                              <span className={`shrink-0 w-4 h-4 rounded-full border-2 ${sel ? 'border-tt-cyan bg-tt-cyan' : 'border-tt-border'}`} />
                              {/* Mirror the Shows tab: channel_handle primary, then store_name
                                  (red "Unmapped store" fallback), then host, time range, and the
                                  auction spread + bound count for lot-range disambiguation. */}
                              <div className="min-w-0 text-sm">
                                <div className="font-medium text-tt-text truncate">{s.channel_handle || 'TikTok Live'}</div>
                                <div className="text-xs text-tt-muted">
                                  {s.store_name ?? <span className="font-semibold text-tt-red">Unmapped store</span>}
                                  {s.host_name ? <> · Host: {s.host_name}</> : null}
                                </div>
                                <div className="text-xs text-tt-muted">{fmtDateTime(s.started_at)} → {s.ended_at ? fmtDateTime(s.ended_at) : 'ongoing'}</div>
                                <div className="text-xs text-tt-muted">
                                  {seqRange ? `Auctions ${seqRange}` : 'No auctions'} · {s.bound_count} bound
                                </div>
                              </div>
                            </button>
                          );
                        })}
                        {sessions.length > 1 && !selectedSessionId && (
                          <div className="text-xs text-tt-yellow">
                            {fallbackMode
                              ? 'Multiple sessions in this room — match the lot # to an auction range.'
                              : 'Multiple sessions match — choose the one this order was sold in.'}
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                  {/* ── SKU picker → lines ── */}
                  {!noSessions && (
                    <div>
                      <div className="text-[11px] uppercase tracking-wide text-tt-muted mb-1">Items</div>
                      {/* selected lines with qty */}
                      {lines.length > 0 && (
                        <div className="flex flex-col gap-2 mb-2">
                          {lines.map((l) => {
                            const s = skuById.get(l.sku_id);
                            return (
                              <div key={l.sku_id} className="flex items-center gap-3 rounded-xl border border-tt-cyan/40 bg-tt-cyan/5 p-2">
                                {s?.thumbnail_url ? (
                                  // eslint-disable-next-line @next/next/no-img-element
                                  <img src={s.thumbnail_url} alt="" className="h-10 w-10 rounded-lg object-cover border border-tt-border" onError={(e) => { e.currentTarget.style.display = 'none'; }} />
                                ) : (
                                  <span className="h-10 w-10 rounded-lg border border-tt-border flex items-center justify-center font-mono text-xs text-tt-muted">#{s?.sku_number ?? '?'}</span>
                                )}
                                <div className="min-w-0 flex-1">
                                  <div className="font-mono font-bold text-tt-text text-sm">#{s?.sku_number ?? '?'}</div>
                                  <div className="text-xs text-tt-muted truncate">{s?.title ?? '—'}</div>
                                </div>
                                <div className="shrink-0 flex items-center gap-1">
                                  <button onClick={() => setLineQty(l.sku_id, l.qty - 1)} className="w-7 h-7 rounded-lg border border-tt-border text-tt-text disabled:opacity-40" disabled={l.qty <= 1}>−</button>
                                  <span className="w-8 text-center font-bold tabular-nums">{l.qty}</span>
                                  <button onClick={() => setLineQty(l.sku_id, l.qty + 1)} className="w-7 h-7 rounded-lg border border-tt-border text-tt-text">+</button>
                                </div>
                                <button onClick={() => removeLine(l.sku_id)} className="shrink-0 ml-1 text-tt-muted hover:text-tt-red" aria-label="Remove">×</button>
                              </div>
                            );
                          })}
                        </div>
                      )}

                      <input
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder="Search SKU # or title to add…"
                        className="w-full rounded-lg border border-tt-border bg-white/5 px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-tt-cyan/50"
                      />
                      <div className="mt-2 max-h-56 overflow-y-auto flex flex-col gap-2 pr-1">
                        {filteredSkus.length === 0 && <div className="text-sm text-tt-muted px-1 py-2">No SKUs match.</div>}
                        {filteredSkus.map((s) => {
                          const added = lines.some((l) => l.sku_id === s.id);
                          return (
                            <button
                              key={s.id}
                              onClick={() => addLine(s.id)}
                              disabled={added}
                              className={`flex items-center gap-3 rounded-xl border-2 p-2 text-left ${added ? 'border-tt-cyan/40 bg-tt-cyan/5 opacity-60' : 'border-tt-border bg-tt-bg hover:bg-tt-card-hover'}`}
                            >
                              {s.thumbnail_url ? (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img src={s.thumbnail_url} alt="" className="h-10 w-10 rounded-lg object-cover border border-tt-border" onError={(e) => { e.currentTarget.style.display = 'none'; }} />
                              ) : (
                                <span className="h-10 w-10 rounded-lg border border-tt-border flex items-center justify-center font-mono text-xs text-tt-muted">#{s.sku_number ?? '?'}</span>
                              )}
                              <div className="min-w-0">
                                <div className="font-mono font-bold text-tt-text text-sm">#{s.sku_number ?? '?'}</div>
                                <div className="text-xs text-tt-muted truncate">{s.title ?? '—'}</div>
                              </div>
                              <span className="ml-auto text-xs text-tt-muted">{added ? 'added' : 'add'}</span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* ── errors + bind ── */}
                  {bindErr && (
                    <div className="rounded-lg border-2 border-tt-red/50 bg-tt-red/10 px-3 py-2 text-sm text-tt-red">{bindErr}</div>
                  )}
                  {/* Out-of-window caution: binding into a session whose window doesn't contain this
                      order will fold it into that session's show-level totals. Shown only once such a
                      session is selected, right at the point of action. */}
                  {selectedOutOfWindow && (
                    <div className="rounded-lg border-2 border-tt-yellow/50 bg-tt-yellow/10 px-3 py-2 text-sm text-tt-yellow">
                      ⚠ This order is outside the selected session&apos;s time window. Binding here will include it in that session&apos;s show-level totals (revenue, units/hr, payouts).
                    </div>
                  )}
                  <div className="flex items-center justify-end gap-2 pt-1">
                    {/* Primary bind (allow_negative:false) — the ONLY first action. */}
                    <button
                      onClick={() => doBind(false)}
                      disabled={!canBind}
                      className="rounded-lg bg-tt-cyan px-4 py-2 text-sm font-bold text-black hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      {binding ? 'Binding…' : 'Bind'}
                    </button>
                    {/* Revealed ONLY after a 409 out-of-stock; reposts with allow_negative:true. */}
                    {outOfStock && (
                      <button
                        onClick={() => doBind(true)}
                        disabled={!canBind}
                        className="rounded-lg bg-tt-red px-4 py-2 text-sm font-bold text-white hover:opacity-90 disabled:opacity-40"
                      >
                        {binding ? 'Binding…' : 'Bind anyway — stock will go negative'}
                      </button>
                    )}
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
