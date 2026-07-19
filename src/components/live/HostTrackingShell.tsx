'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useLiveSession, useEndSession } from '@/hooks/useLiveSessions';
import { useInventorySkus, type InventorySku } from '@/hooks/useInventorySkus';
import { useAuctionBoard, useQuickClose, useDeleteAuctionItem, type AuctionResult } from '@/hooks/useLiveAuctions';
import { notSoldBadge } from '@/lib/paymentStatus';

const fmtCents = (c: number | null) => (c == null ? '—' : `$${(c / 100).toFixed(2)}`);
const EXPECTED_MULTIPLIER = 3;

interface SelLine {
  sku_id: string;
  sku_number: number;
  title: string;
  thumbnail_url: string | null;
  shortcut_letter: string | null;
  unit_cost_cents: number | null;
  qty: number;
}

interface PendingRow {
  tempId: string;
  key: string; // client_idempotency_key, reused on retry
  result: AuctionResult;
  number: number;
  skus: SelLine[];
  state: 'saving' | 'confirmed' | 'failed';
  error?: string;
}

const STATUS_META: Record<AuctionResult, { label: string; cls: string }> = {
  sold: { label: 'Sold', cls: 'bg-tt-green/15 text-tt-green' },
  not_sold: { label: 'Not sold', cls: 'bg-tt-border text-tt-muted' },
  canceled: { label: 'Canceled', cls: 'bg-tt-red/15 text-tt-red' },
  manual: { label: 'Manual', cls: 'bg-tt-cyan/15 text-tt-cyan' },
};

function csvCell(v: string | number): string {
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function computeFromSkus(skus: { qty: number; unit_cost_cents: number | null; sku_number: number; title: string }[]) {
  let units = 0;
  let totalCost: number | null = 0;
  for (const l of skus) {
    units += l.qty;
    if (l.unit_cost_cents == null) totalCost = null;
    else if (totalCost != null) totalCost += l.unit_cost_cents * l.qty;
  }
  const expected = totalCost == null ? null : totalCost * EXPECTED_MULTIPLIER;
  const itemsStr = skus.map((l) => `${l.sku_number} ${l.title}${l.qty > 1 ? ` ×${l.qty}` : ''}`).join('; ');
  return { units, totalCost, expected, itemsStr };
}

export default function HostTrackingShell({ sessionId }: { sessionId: string }) {
  const { data: session, isLoading: sessionLoading, isError } = useLiveSession(sessionId);
  const { data: allSkus = [] } = useInventorySkus();
  const { data: board = [] } = useAuctionBoard(sessionId);
  const quickClose = useQuickClose();
  const deleteItem = useDeleteAuctionItem();
  const endSession = useEndSession();

  const [selection, setSelection] = useState<SelLine[]>([]);
  const [pending, setPending] = useState<PendingRow[]>([]);
  const [lastBundle, setLastBundle] = useState<SelLine[] | null>(null);
  const [shortcut, setShortcut] = useState('');
  const [flash, setFlash] = useState<string | null>(null);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const shortcutRef = useRef<HTMLInputElement | null>(null);
  // Hard synchronous guard: a save "arms" when a selection exists and is consumed on fire,
  // so a rapid double-click can't fire the same selection twice (independent of React timing).
  const armedRef = useRef(false);

  const isLive = session?.status === 'live' || session?.status === 'draft';
  const readOnly = !!session && !isLive;
  const activeSkus = useMemo(() => allSkus.filter((s) => s.is_active), [allSkus]);

  const boardNumbers = useMemo(() => new Set(board.map((b) => b.auction_number)), [board]);

  const nextNumber = useMemo(() => {
    const nums = [...board.map((b) => b.auction_number), ...pending.map((p) => p.number)];
    return (nums.length ? Math.max(...nums) : 0) + 1;
  }, [board, pending]);

  const costMissing = selection.some((l) => l.unit_cost_cents == null);
  const sel = computeFromSkus(selection);

  // Note: confirmed optimistic rows are hidden at render time once the board has
  // their number (see `rows`), and pruned from state when the next save fires.

  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 2500);
    return () => clearTimeout(t);
  }, [flash]);

  function focusShortcut() {
    requestAnimationFrame(() => shortcutRef.current?.focus());
  }

  function addSku(s: InventorySku) {
    if (readOnly) return;
    if ((s.qty_on_hand ?? 0) <= 0) {
      setFlash(`SKU ${s.sku_number} is out of stock`);
      return;
    }
    setSelection((prev) => {
      const found = prev.find((l) => l.sku_id === s.id);
      if (found) return prev.map((l) => (l.sku_id === s.id ? { ...l, qty: l.qty + 1 } : l));
      return [
        ...prev,
        {
          sku_id: s.id,
          sku_number: s.sku_number,
          title: s.title,
          thumbnail_url: s.thumbnail_url,
          shortcut_letter: s.shortcut_letter,
          unit_cost_cents: s.unit_cost_cents,
          qty: 1,
        },
      ];
    });
    armedRef.current = true;
    focusShortcut();
  }

  const changeQty = (id: string, d: number) => {
    armedRef.current = true;
    setSelection((prev) => prev.map((l) => (l.sku_id === id ? { ...l, qty: Math.max(1, l.qty + d) } : l)));
  };
  const removeSku = (id: string) => setSelection((prev) => prev.filter((l) => l.sku_id !== id));
  const clearSelection = () => {
    armedRef.current = false;
    setSelection([]);
  };

  function onShortcutKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const val = shortcut.trim().toUpperCase();
    setShortcut('');
    if (!val) return;
    const matches = activeSkus.filter(
      (s) => (s.shortcut_letter && s.shortcut_letter.toUpperCase() === val) || String(s.sku_number) === val,
    );
    if (matches.length === 0) setFlash(`No SKU for "${val}"`);
    else if (matches.length === 1) addSku(matches[0]);
    else setFlash(`Multiple matches for "${val}" — tap a card`);
  }

  function fireSave(entry: PendingRow) {
    quickClose.mutate(
      {
        sessionId,
        result: entry.result,
        skus: entry.skus.map((l) => ({ sku_id: l.sku_id, qty: l.qty })),
        client_idempotency_key: entry.key,
      },
      {
        onSuccess: (res) =>
          setPending((prev) =>
            prev.map((p) => (p.tempId === entry.tempId ? { ...p, state: 'confirmed', number: res.auction_number } : p)),
          ),
        onError: (err) =>
          setPending((prev) =>
            prev.map((p) =>
              p.tempId === entry.tempId ? { ...p, state: 'failed', error: err instanceof Error ? err.message : 'Save failed' } : p,
            ),
          ),
      },
    );
  }

  // Optimistic: clear selection + show the row immediately, save in the background.
  function doClose(result: AuctionResult) {
    if (readOnly || selection.length === 0 || !armedRef.current) return;
    armedRef.current = false; // consume synchronously: a rapid 2nd click on the same selection is a no-op
    const skusSnap = selection;
    setLastBundle(skusSnap); // remember for Rerun
    setSelection([]);
    focusShortcut();
    setPending((prev) => {
      // Drop confirmed rows the board has already absorbed, so state stays bounded.
      const cleaned = prev.filter((p) => !(p.state === 'confirmed' && boardNumbers.has(p.number)));
      const used = [...board.map((b) => b.auction_number), ...cleaned.map((p) => p.number)];
      const number = (used.length ? Math.max(...used) : 0) + 1;
      const entry: PendingRow = { tempId: crypto.randomUUID(), key: crypto.randomUUID(), result, number, skus: skusSnap, state: 'saving' };
      // Fire after state commit so the row renders first.
      queueMicrotask(() => fireSave(entry));
      return [...cleaned, entry];
    });
  }

  // Rerun: repopulate Current Selection with the last logged bundle. Does NOT save.
  // Re-resolves from current inventory and blocks if any SKU is now unavailable / out of stock.
  function rerunLast() {
    if (readOnly || !lastBundle) return;
    const restored: SelLine[] = [];
    for (const l of lastBundle) {
      const cur = activeSkus.find((s) => s.id === l.sku_id);
      if (!cur) {
        setFlash(`Cannot rerun — SKU ${l.sku_number} is no longer available`);
        return;
      }
      if ((cur.qty_on_hand ?? 0) <= 0) {
        setFlash(`Cannot rerun — SKU ${cur.sku_number} is out of stock`);
        return;
      }
      restored.push({
        sku_id: cur.id,
        sku_number: cur.sku_number,
        title: cur.title,
        thumbnail_url: cur.thumbnail_url,
        shortcut_letter: cur.shortcut_letter,
        unit_cost_cents: cur.unit_cost_cents,
        qty: l.qty,
      });
    }
    setSelection(restored); // a fresh save attempt (new idempotency key) happens on next Sold/Not Sold
    armedRef.current = true;
    focusShortcut();
  }

  function onConfirmDelete(itemId: string) {
    setConfirmDeleteId(null);
    deleteItem.mutate({ sessionId, itemId });
  }

  function retry(tempId: string) {
    setPending((prev) => {
      const entry = prev.find((p) => p.tempId === tempId);
      if (entry) queueMicrotask(() => fireSave({ ...entry, state: 'saving' })); // same key -> idempotent
      return prev.map((p) => (p.tempId === tempId ? { ...p, state: 'saving', error: undefined } : p));
    });
  }

  function dismissFailed(tempId: string) {
    setPending((prev) => prev.filter((p) => p.tempId !== tempId));
  }

  async function onEnd() {
    try {
      await endSession.mutateAsync(sessionId);
      setConfirmEnd(false);
    } catch {
      setConfirmEnd(false);
    }
  }

  function exportCsv() {
    if (board.length === 0) {
      setFlash('No auctions to export yet');
      return;
    }
    const header = ['Auction #', 'Status', 'SKUs', 'Quantity', 'Logged At', 'Total Cost', 'Expected Price'];
    const rows = board.map((it) => [
      it.auction_number,
      STATUS_META[it.status].label,
      it.skus.map((s) => `${s.sku_number} ${s.title}${s.qty > 1 ? ` x${s.qty}` : ''}`).join('; '),
      it.units,
      it.logged_at,
      it.total_cost_cents == null ? 'Cost missing' : fmtCents(it.total_cost_cents),
      it.expected_price_cents == null ? 'Cost missing' : fmtCents(it.expected_price_cents),
    ]);
    const csv = [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `auction-log-${sessionId}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // Merge optimistic (not yet in board) + server rows, newest first.
  const rows = useMemo(() => {
    const p = pending
      .filter((x) => !boardNumbers.has(x.number))
      .map((x) => {
        const c = computeFromSkus(x.skus);
        return {
          key: x.tempId,
          tempId: x.tempId,
          itemId: undefined as string | undefined,
          number: x.number,
          status: x.result,
          itemsStr: c.itemsStr,
          units: c.units,
          totalCost: c.totalCost,
          expected: c.expected,
          loggedAt: null as string | null,
          pendingState: x.state,
          error: x.error,
          order_status: null as number | null, // optimistic rows have no capture yet
          payment_failed: false,
        };
      });
    const s = board.map((b) => ({
      key: b.id,
      tempId: undefined as string | undefined,
      itemId: b.id as string | undefined,
      number: b.auction_number,
      status: b.status,
      itemsStr: b.skus.map((x) => `${x.sku_number} ${x.title}${x.qty > 1 ? ` ×${x.qty}` : ''}`).join('; ') || '—',
      units: b.units,
      totalCost: b.total_cost_cents,
      expected: b.expected_price_cents,
      loggedAt: b.logged_at,
      pendingState: undefined as PendingRow['state'] | undefined,
      error: undefined as string | undefined,
      order_status: b.order_status,
      payment_failed: b.payment_failed,
    }));
    return [...p, ...s].sort((a, b) => b.number - a.number);
  }, [pending, board, boardNumbers]);

  return (
    <div className="min-h-screen bg-tt-bg text-tt-text">
      <header className="sticky top-0 z-40 flex items-center gap-4 px-6 py-4 border-b border-tt-border bg-[rgba(15,15,15,0.95)] backdrop-blur-xl">
        <Link href="/dashboard" className="text-sm text-tt-muted hover:text-tt-text transition-colors">‹ Live Tracking</Link>
        <div className="flex items-center gap-3 min-w-0">
          <span className={`w-2 h-2 rounded-full ${isLive ? 'bg-tt-green animate-pulse' : 'bg-tt-muted'}`} aria-hidden />
          <h1 className="text-base font-semibold truncate">{sessionLoading ? 'Loading…' : session ? session.title : 'Session'}</h1>
          {session && (
            <span className={`text-xs font-medium px-2 py-0.5 rounded-md ${isLive ? 'bg-tt-green/15 text-tt-green' : 'bg-tt-border text-tt-muted'}`}>
              {isLive ? 'Live' : 'Ended'}
            </span>
          )}
        </div>
        <div className="ml-auto flex items-center gap-2">
          {board.length > 0 && (
            <button onClick={exportCsv} className="px-3 py-1.5 rounded-lg border border-tt-border text-sm text-tt-text cursor-pointer hover:bg-tt-card-hover transition-colors">Export CSV</button>
          )}
          {isLive && (confirmEnd ? (
            <span className="inline-flex items-center gap-2">
              <span className="text-sm text-tt-muted">End session?</span>
              <button onClick={onEnd} disabled={endSession.isPending} className="px-3 py-1.5 rounded-lg bg-tt-red/90 text-white text-sm font-medium cursor-pointer hover:opacity-90 disabled:opacity-50">{endSession.isPending ? 'Ending…' : 'Yes, end'}</button>
              <button onClick={() => setConfirmEnd(false)} className="px-3 py-1.5 rounded-lg border border-tt-border text-sm text-tt-muted cursor-pointer hover:bg-tt-card-hover">Cancel</button>
            </span>
          ) : (
            <button onClick={() => setConfirmEnd(true)} className="px-4 py-2 rounded-lg border border-tt-border text-sm text-tt-text cursor-pointer hover:bg-tt-card-hover transition-colors">End Session</button>
          ))}
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6 py-6">
        {sessionLoading ? (
          <div className="flex items-center justify-center py-24 text-tt-muted">
            <div className="w-5 h-5 border-2 border-tt-muted border-t-transparent rounded-full animate-spin mr-3" />
            Loading session…
          </div>
        ) : isError || !session ? (
          <div className="rounded-2xl border border-tt-border bg-tt-card py-16 text-center">
            <div className="text-tt-text font-medium">Session not found</div>
            <Link href="/dashboard" className="inline-block mt-4 px-4 py-2 rounded-lg border border-tt-border text-sm hover:bg-tt-card-hover transition-colors">Back to Live Tracking</Link>
          </div>
        ) : (
          <>
            {readOnly && (
              <div className="mb-6 rounded-lg border border-tt-border bg-tt-card-hover px-4 py-3 text-sm text-tt-muted">
                This session has ended. It is read-only: the auction log and CSV export remain available; live logging is disabled.
              </div>
            )}
            {flash && <div className="mb-4 rounded-lg border border-tt-cyan/30 bg-tt-cyan/10 px-4 py-2 text-sm text-tt-cyan">{flash}</div>}

            {!readOnly && (
              <div className="grid lg:grid-cols-3 gap-6 mb-8">
                {/* Inventory selector */}
                <div className="lg:col-span-2">
                  <input
                    ref={shortcutRef}
                    value={shortcut}
                    onChange={(e) => setShortcut(e.target.value)}
                    onKeyDown={onShortcutKey}
                    autoFocus
                    placeholder="Type a shortcut letter or SKU #, then Enter"
                    className="w-full mb-3 rounded-lg px-3 py-2.5 text-sm font-mono outline-none"
                    style={{ background: 'var(--color-tt-input-bg)', border: '1px solid var(--color-tt-input-border)', color: 'var(--color-tt-text)' }}
                  />
                  {activeSkus.length === 0 ? (
                    <div className="rounded-2xl border border-tt-border bg-tt-card py-12 text-center text-sm text-tt-muted">No active SKUs. Add inventory in the Inventory tab first.</div>
                  ) : (
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                      {activeSkus.map((s) => {
                        const oos = (s.qty_on_hand ?? 0) <= 0;
                        return (
                          <button
                            key={s.id}
                            onClick={() => addSku(s)}
                            disabled={oos}
                            className={`relative block w-full aspect-[4/5] rounded-xl overflow-hidden border text-left transition-transform ${oos ? 'border-tt-red/30 opacity-60 cursor-not-allowed' : 'border-tt-border hover:-translate-y-0.5 cursor-pointer'}`}
                          >
                            {/* Image fills the whole tile so every card has the same footprint */}
                            <div className="absolute inset-0 bg-tt-input-bg">
                              {s.thumbnail_url ? (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img
                                  src={s.thumbnail_url}
                                  alt=""
                                  className={`w-full h-full object-cover ${oos ? 'grayscale' : ''}`}
                                  onError={(e) => { e.currentTarget.style.display = 'none'; }}
                                />
                              ) : (
                                <div className="w-full h-full flex items-center justify-center text-tt-muted text-xs">No image</div>
                              )}
                            </div>

                            {/* Shortcut badge */}
                            {s.shortcut_letter && (
                              <span className="absolute top-2 left-2 z-10 inline-flex items-center justify-center min-w-7 h-7 px-1.5 rounded-md bg-black/70 text-tt-cyan text-sm font-bold backdrop-blur-sm">{s.shortcut_letter}</span>
                            )}

                            {/* Bottom info panel: image felt behind via gradient + slight blur, text stays high-contrast */}
                            <div className="absolute inset-x-0 bottom-0 p-3 bg-gradient-to-t from-black/90 via-black/55 to-transparent backdrop-blur-[2px]">
                              <div className="flex items-baseline justify-between gap-2">
                                <span className="text-lg font-bold leading-none text-white">SKU #{s.sku_number}</span>
                                <span className={`text-xs font-semibold shrink-0 ${oos ? 'text-tt-red' : 'text-white/80'}`}>{oos ? 'Out of stock' : `${s.qty_on_hand} left`}</span>
                              </div>
                              <div className="text-sm text-white/90 truncate mt-1">{s.title || 'Untitled'}</div>
                              <div className="text-[11px] text-white/55 tabular-nums mt-0.5">Cost {fmtCents(s.unit_cost_cents)}</div>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* Current selection + actions */}
                <div className="lg:sticky lg:top-24 self-start rounded-2xl border border-tt-border bg-tt-card p-5">
                  <div className="flex items-center justify-between mb-3">
                    <span className="text-xs uppercase tracking-wide text-tt-muted">Current selection</span>
                    <span className="inline-flex items-center px-2 py-0.5 rounded-md bg-tt-green/15 text-tt-green text-xs font-bold">#{nextNumber}</span>
                  </div>

                  {selection.length === 0 ? (
                    <p className="text-sm text-tt-muted py-6 text-center">Tap a SKU or type its shortcut to start.</p>
                  ) : (
                    <div className="space-y-2 mb-4">
                      {selection.map((l) => (
                        <div key={l.sku_id} className="flex items-center gap-3">
                          <div className="w-11 h-11 shrink-0 rounded-md border border-tt-border bg-tt-input-bg overflow-hidden flex items-center justify-center">
                            {l.thumbnail_url ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img src={l.thumbnail_url} alt="" className="w-full h-full object-cover" onError={(e) => { e.currentTarget.style.display = 'none'; }} />
                            ) : (
                              <span className="text-tt-muted text-[10px]">—</span>
                            )}
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5">
                              {l.shortcut_letter && <span className="inline-flex items-center justify-center min-w-5 h-5 px-1 rounded bg-tt-cyan/15 text-tt-cyan text-[11px] font-bold">{l.shortcut_letter}</span>}
                              <span className="text-sm font-bold">#{l.sku_number}</span>
                            </div>
                            <div className="text-xs text-tt-muted truncate">{l.title || 'Untitled'}</div>
                          </div>
                          <div className="flex items-center gap-1">
                            <button onClick={() => changeQty(l.sku_id, -1)} className="w-6 h-6 rounded border border-tt-border text-tt-muted cursor-pointer hover:bg-tt-card-hover">−</button>
                            <span className="w-6 text-center tabular-nums text-sm">{l.qty}</span>
                            <button onClick={() => changeQty(l.sku_id, 1)} className="w-6 h-6 rounded border border-tt-border text-tt-muted cursor-pointer hover:bg-tt-card-hover">+</button>
                          </div>
                          <button onClick={() => removeSku(l.sku_id)} aria-label="Remove" className="text-tt-muted hover:text-tt-red cursor-pointer">✕</button>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Expected price is the primary number; raw cost is not shown here. */}
                  <div className="border-t border-tt-border pt-3 mb-4">
                    <div className="text-xs uppercase tracking-wide text-tt-muted">Expected</div>
                    {selection.length === 0 ? (
                      <div className="text-2xl font-bold text-tt-muted tabular-nums">—</div>
                    ) : costMissing ? (
                      <div className="text-base font-semibold text-tt-muted">Cost missing</div>
                    ) : (
                      <div className="text-3xl font-bold text-tt-cyan tabular-nums">{fmtCents(sel.expected)}</div>
                    )}
                  </div>

                  <button
                    onClick={() => doClose('sold')}
                    disabled={selection.length === 0}
                    className="w-full mb-2 px-4 py-3.5 rounded-lg bg-tt-green text-black text-lg font-bold cursor-pointer hover:opacity-90 transition-opacity disabled:opacity-40"
                  >
                    Sold
                  </button>
                  <button
                    onClick={() => doClose('not_sold')}
                    disabled={selection.length === 0}
                    className="w-full mb-2 px-4 py-2.5 rounded-lg border border-tt-border text-sm font-medium text-tt-text cursor-pointer hover:bg-tt-card-hover transition-colors disabled:opacity-40"
                  >
                    Not Sold
                  </button>
                  <div className="flex gap-2">
                    {lastBundle && (
                      <button onClick={rerunLast} className="flex-1 px-4 py-2 rounded-lg text-sm text-tt-cyan cursor-pointer hover:bg-tt-card-hover transition-colors">↻ Rerun last</button>
                    )}
                    <button onClick={clearSelection} disabled={selection.length === 0} className="flex-1 px-4 py-2 rounded-lg text-sm text-tt-muted cursor-pointer hover:bg-tt-card-hover transition-colors disabled:opacity-40">Clear</button>
                  </div>
                </div>
              </div>
            )}

            {/* Auction log */}
            <div>
              <div className="text-xs uppercase tracking-wide text-tt-muted mb-2">Auction log ({rows.length})</div>
              {rows.length === 0 ? (
                <div className="rounded-2xl border border-tt-border bg-tt-card py-12 text-center text-sm text-tt-muted">No auctions logged yet.</div>
              ) : (
                <div className="rounded-2xl border border-tt-border bg-tt-card overflow-hidden">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-tt-border text-tt-muted text-xs uppercase tracking-wide">
                        <th className="text-left font-medium px-4 py-3 w-12">#</th>
                        <th className="text-left font-medium px-4 py-3">Status</th>
                        <th className="text-left font-medium px-4 py-3">Item(s)</th>
                        <th className="text-right font-medium px-4 py-3">Qty</th>
                        <th className="text-right font-medium px-4 py-3">Expected</th>
                        <th className="text-right font-medium px-4 py-3 text-tt-muted">Cost</th>
                        <th className="text-right font-medium px-4 py-3">Logged</th>
                        {!readOnly && <th className="px-4 py-3" />}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => (
                        <tr key={r.key} className={`border-b border-tt-border last:border-0 ${r.pendingState === 'saving' ? 'opacity-70' : ''}`}>
                          <td className="px-4 py-3 font-bold tabular-nums">{r.number}</td>
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-2">
                              {r.status === 'not_sold' ? (
                                // Show the payment-recovery state (order_status) on not_sold rows.
                                (() => { const b = notSoldBadge(r.order_status, r.payment_failed); return (
                                  <span className={`text-xs font-medium ${b.cls}`}>{b.label}</span>
                                ); })()
                              ) : (
                                <span className={`text-xs font-medium px-2 py-0.5 rounded-md ${STATUS_META[r.status].cls}`}>{STATUS_META[r.status].label}</span>
                              )}
                              {r.pendingState === 'saving' && <span className="text-xs text-tt-muted">Saving…</span>}
                              {r.pendingState === 'failed' && (
                                <span className="inline-flex items-center gap-1.5">
                                  <span className="text-xs text-tt-red">Save failed</span>
                                  <button onClick={() => retry(r.tempId!)} className="text-xs text-tt-cyan cursor-pointer hover:underline">Retry</button>
                                  <button onClick={() => dismissFailed(r.tempId!)} className="text-xs text-tt-muted cursor-pointer hover:underline">Dismiss</button>
                                </span>
                              )}
                            </div>
                            {r.pendingState === 'failed' && r.error && <div className="text-[11px] text-tt-red mt-1">{r.error}</div>}
                          </td>
                          <td className="px-4 py-3"><span className="truncate">{r.itemsStr || '—'}</span></td>
                          <td className="px-4 py-3 text-right tabular-nums">{r.units}</td>
                          <td className="px-4 py-3 text-right tabular-nums font-medium">{r.expected == null ? <span className="text-tt-muted">—</span> : fmtCents(r.expected)}</td>
                          <td className="px-4 py-3 text-right tabular-nums text-tt-muted">{r.totalCost == null ? '—' : fmtCents(r.totalCost)}</td>
                          <td className="px-4 py-3 text-right text-tt-muted text-xs whitespace-nowrap">{r.loggedAt ? new Date(r.loggedAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : '—'}</td>
                          {!readOnly && (
                            <td className="px-4 py-3 text-right whitespace-nowrap">
                              {r.itemId ? (
                                confirmDeleteId === r.itemId ? (
                                  <span className="inline-flex items-center gap-2">
                                    <span className="text-xs text-tt-muted">Delete this row?</span>
                                    <button onClick={() => onConfirmDelete(r.itemId!)} className="text-xs text-tt-red font-medium cursor-pointer hover:underline">Yes</button>
                                    <button onClick={() => setConfirmDeleteId(null)} className="text-xs text-tt-muted cursor-pointer hover:underline">No</button>
                                  </span>
                                ) : (
                                  <button onClick={() => setConfirmDeleteId(r.itemId!)} className="text-xs text-tt-muted cursor-pointer hover:text-tt-red transition-colors">Delete</button>
                                )
                              ) : null}
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </>
        )}
      </main>
    </div>
  );
}
