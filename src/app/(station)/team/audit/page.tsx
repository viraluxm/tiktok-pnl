'use client';

import { useCallback, useEffect, useState } from 'react';
import MemberNav from '@/components/member/MemberNav';

// Bundle audit — the squish over-bind queue. Second member surface under the 'binding' scope
// (same team, same confinement, no new scope to provision).
//
// WHAT A ROW IS. A sold order whose bound SKUs are ALL squish and total more than one unit. Squish
// is never bundled, so the host either scanned one item twice or scanned the next item onto the
// previous sale. The fix is one click: say which SKU was the real item.
//
// Pagination is OFFSET (real page numbers) — the API returns the true total for the window, unlike
// the keyset binding queue where no total exists.

interface Line {
  sku_id: string;
  sku_number: number | null;
  title: string | null;
  qty: number;
  unit_cost_cents: number | null;
  category: string | null;
  thumbnail_url: string | null;
}
interface Row {
  order_id: string;
  item_id: string;
  bound_at: string;
  units: number;
  line_count: number;
  tiktok_title: string | null;
  buyer_handle: string | null;
  won_price_cents: number | null;
  lot_hint: string | null;
  tiktok_status: string | null;
  pack_verified: boolean;
  unpacked: boolean;
  lines: Line[];
}

const PAGE_SIZE = 25;
const WINDOWS = [7, 14, 30];

function money(cents: number | null): string {
  if (cents == null) return '—';
  return `$${(cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function fmtDateTime(iso: string | null): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '—';
  return new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
// Pack state, and it decides whether the fix is even correct.
//
// The status alone CANNOT tell you this, which an earlier version of this file got wrong by calling
// AWAITING_COLLECTION "already packed". AWAITING_COLLECTION means the LABEL IS BOUGHT and the box is
// in the pack-ready queue — 182 of the live queue's orders are in that state and NOT yet packed.
// The authority is `unpacked` from the RPC: no shipment_verifications row AND the platform still
// says the parcel has not moved.
function packHint(r: Row): { label: string; tone: string } {
  if (r.unpacked) {
    return r.tiktok_status === 'AWAITING_COLLECTION'
      ? { label: 'label bought, not packed yet — fix it before someone packs two', tone: 'text-tt-yellow' }
      : { label: 'not packed yet, no label bought — safe to fix', tone: 'text-tt-yellow' };
  }
  if (r.pack_verified) return { label: 'ALREADY PACKED — both items went in the box', tone: 'text-tt-red' };
  return { label: `already ${(r.tiktok_status ?? 'shipped').toLowerCase().replace(/_/g, ' ')}`, tone: 'text-tt-red' };
}

export default function MemberAuditPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [days, setDays] = useState(14);
  // Defaults ON: the other rows cannot be corrected without creating an inventory error.
  const [unpackedOnly, setUnpackedOnly] = useState(true);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const [busyOrder, setBusyOrder] = useState<string | null>(null);
  const [rowErr, setRowErr] = useState<Record<string, string>>({});
  // unit_key, not sku_id: a qty-2 line renders as TWO cards, and only the clicked one may highlight.
  const [confirmKeep, setConfirmKeep] = useState<{ order_id: string; unit_key: string; sku_id: string } | null>(null);

  // Shop filter — the team verifies a shop at a time. null = all shops in scope.
  const [shops, setShops] = useState<{ id: string; name: string | null }[]>([]);
  const [selectedShop, setSelectedShop] = useState<string | null>(null);
  // Surfaced, never swallowed: a failed shop fetch must not read as "this member has no shops"
  // (that is how a middleware allowlist gap once hid as a missing feature).
  const [shopsErr, setShopsErr] = useState<string | null>(null);

  const load = useCallback(async (idx: number, windowDays: number, shopId: string | null, unpacked: boolean) => {
    setLoading(true); setErr(null); setConfirmKeep(null);
    try {
      const qs = new URLSearchParams({ days: String(windowDays), limit: String(PAGE_SIZE), offset: String(idx * PAGE_SIZE) });
      if (shopId) qs.set('store_id', shopId);
      if (!unpacked) qs.set('unpacked', '0');
      const res = await fetch(`/api/member/audit?${qs.toString()}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `Failed to load queue (${res.status})`);
      setRows((json.rows ?? []) as Row[]);
      setTotal(Number(json.total) || 0);
      setPage(idx);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  // Any filter change resets to page 1 — an offset into a different filter's result set is meaningless.
  useEffect(() => { load(0, days, selectedShop, unpackedOnly); }, [load, days, selectedShop, unpackedOnly]);

  useEffect(() => {
    fetch('/api/member/stores')
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `Failed to load shops (${r.status})`);
        return r.json();
      })
      .then((d) => { setShops((d.stores ?? []) as { id: string; name: string | null }[]); setShopsErr(null); })
      .catch((e) => setShopsErr((e as Error).message));
  }, []);

  // Drop the row locally on success — no refetch, so the member's place in the list is kept.
  const settle = (orderId: string) => {
    setRows((rs) => rs.filter((r) => r.order_id !== orderId));
    setTotal((t) => Math.max(0, t - 1));
    setConfirmKeep(null);
  };

  const doKeep = async (row: Row, skuId: string) => {
    setBusyOrder(row.order_id);
    setRowErr((e) => ({ ...e, [row.order_id]: '' }));
    try {
      const res = await fetch('/api/member/audit/keep', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order_id: row.order_id, item_id: row.item_id, keep_sku_id: skuId }),
      });
      const json = await res.json().catch(() => ({}));
      if (res.ok) { settle(row.order_id); return; }
      setRowErr((e) => ({ ...e, [row.order_id]: String(json.error ?? `Failed (${res.status})`) }));
    } catch (e) {
      setRowErr((er) => ({ ...er, [row.order_id]: (e as Error).message }));
    } finally {
      setBusyOrder(null);
    }
  };

  const doDismiss = async (row: Row) => {
    setBusyOrder(row.order_id);
    setRowErr((e) => ({ ...e, [row.order_id]: '' }));
    try {
      const res = await fetch('/api/member/audit/dismiss', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order_id: row.order_id, item_id: row.item_id }),
      });
      const json = await res.json().catch(() => ({}));
      if (res.ok) { settle(row.order_id); return; }
      setRowErr((e) => ({ ...e, [row.order_id]: String(json.error ?? `Failed (${res.status})`) }));
    } catch (e) {
      setRowErr((er) => ({ ...er, [row.order_id]: (e as Error).message }));
    } finally {
      setBusyOrder(null);
    }
  };

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const pillCls = (active: boolean) =>
    `px-3 py-1 rounded-full text-xs font-semibold transition-all ${active ? 'bg-tt-cyan text-black' : 'bg-tt-card-hover text-tt-muted hover:text-tt-text'}`;

  // Expand each LINE into one card PER UNIT. A double-scan is one line with qty 2, and rendering it
  // as a single "×2" card gave the member nothing to act on — "Keep this one" read as "leave this
  // row alone" when it in fact keeps ONE unit. Two identical cards, one Keep each, makes the choice
  // literal: keep this unit, the rest goes back to stock. Both units of a SKU post the same
  // keep_sku_id, and the route always re-binds qty 1, so either card produces the same correct write.
  const unitsOf = (r: Row) =>
    r.lines.flatMap((l) =>
      Array.from({ length: Math.max(1, Number(l.qty) || 1) }, (_, i) => ({
        line: l,
        unit_key: `${l.sku_id}:${i}`,
        ordinal: i + 1,
        of: Math.max(1, Number(l.qty) || 1),
      })),
    );

  return (
    <main className="min-h-screen bg-tt-bg text-tt-text p-6 max-w-3xl mx-auto">
      <MemberNav active="audit" />
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Bundle audit</h1>
        <p className="mt-1 text-sm text-tt-muted">
          Squish orders with more than one item bound. Squish is never bundled — so one of these was
          scanned by mistake. Pick the item the buyer actually won.
        </p>
        <div className="mt-3 flex items-center justify-between gap-3">
          <div className="text-sm font-semibold text-tt-text">
            {total.toLocaleString()} to review<span className="text-tt-muted font-normal"> · last {days} days</span>
          </div>
          <div className="flex gap-1">
            {WINDOWS.map((d) => (
              <button
                key={d}
                onClick={() => setDays(d)}
                className={`px-3 py-1 rounded-full text-xs font-semibold ${d === days ? 'bg-tt-cyan text-black' : 'bg-tt-card-hover text-tt-muted hover:text-tt-text'}`}
              >
                {d}d
              </button>
            ))}
          </div>
        </div>

        {/* Shop pills. Shown independently of the error below so a rejected /api/member/stores can
            never be read as "this member has no shops". "All shops" always renders, including for a
            single-shop member — otherwise there is no way back once a shop is picked. */}
        {shops.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1">
            <button onClick={() => setSelectedShop(null)} className={pillCls(selectedShop === null)}>All shops</button>
            {shops.map((s) => (
              <button key={s.id} onClick={() => setSelectedShop(s.id)} className={pillCls(selectedShop === s.id)}>
                {s.name ?? s.id}
              </button>
            ))}
          </div>
        )}
        {/* Pack-state filter. "Fixable now" is the default because Keep is only correct on an
            unpacked box; on a packed one it would restock a unit that is already with a customer. */}
        <div className="mt-3 flex flex-wrap gap-1">
          <button onClick={() => setUnpackedOnly(true)} className={pillCls(unpackedOnly)}>Fixable now (not packed)</button>
          <button onClick={() => setUnpackedOnly(false)} className={pillCls(!unpackedOnly)}>Everything</button>
        </div>

        {shopsErr && (
          <div className="mt-2 rounded-lg border border-tt-yellow/40 bg-tt-yellow/10 px-3 py-2 text-xs text-tt-yellow">
            Shop filter unavailable — {shopsErr}. The queue below is not filtered by shop.
          </div>
        )}
      </div>

      {loading && rows.length === 0 && <div className="text-lg text-tt-muted">Loading queue…</div>}
      {err && <div className="rounded-xl border-2 border-tt-red/50 bg-tt-red/10 px-4 py-3 text-tt-red font-semibold">{err}</div>}

      {!loading && !err && rows.length === 0 && (
        <div className="rounded-2xl border border-tt-border bg-tt-card px-6 py-10 text-center text-tt-muted">
          {page === 0 ? 'Nothing to review — no over-bound squish orders in this window.' : 'No rows on this page.'}
        </div>
      )}

      <div className="space-y-3">
        {rows.map((r) => {
          const busy = busyOrder === r.order_id;
          const hint = packHint(r);
          const rerr = rowErr[r.order_id];
          return (
            <div key={r.item_id} className="rounded-2xl border border-tt-border bg-tt-card overflow-hidden">
              {/* ── Order header ── */}
              <div className="flex items-start justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <div className="font-semibold text-tt-text truncate">{r.tiktok_title || 'Unknown item'}</div>
                  <div className="mt-0.5 text-xs font-bold text-tt-red">
                    {r.units} items bound{r.line_count === 1 ? ' · same SKU scanned twice' : ''}
                  </div>
                  <div className="mt-1 text-xs text-tt-muted break-all">
                    {r.lot_hint ? `Lot ${r.lot_hint} · ` : ''}Order #{r.order_id}
                    {r.buyer_handle ? ` · @${r.buyer_handle}` : ''} · {fmtDateTime(r.bound_at)}
                  </div>
                  <div className={`mt-1 text-xs ${hint.tone}`}>{hint.label}</div>
                </div>
                <div className="shrink-0 text-right">
                  <div className="font-bold tabular-nums">{money(r.won_price_cents)}</div>
                  <div className="text-xs text-tt-muted">paid for one</div>
                </div>
              </div>

              {/* ── The bound lines: pick the one to keep ── */}
              <div className="border-t border-tt-border p-4 space-y-3">
                <div className="text-[11px] uppercase tracking-wide text-tt-muted">
                  {/* One line with qty 2 is the SAME item scanned twice — there is no choice to
                      make there, only a confirmation, so the prompt must not ask "which". */}
                  {!r.unpacked
                    ? 'Too late to fix — this box is already gone'
                    : r.line_count === 1 ? 'Scanned twice — keep one of them?' : 'Which item did they win?'}
                </div>

                {/* Keep is WITHHELD on a box that already went out. Both units were picked and
                    shipped, so "keep one" would return a unit to stock that is with the customer —
                    it trades a COGS error for an inventory error. Dismiss is still offered: that is
                    the honest resolution for these. (The API still permits the write; this is the
                    UI refusing to invite it.) */}
                {!r.unpacked && (
                  <div className="rounded-lg border-2 border-tt-red/40 bg-tt-red/10 px-3 py-2 text-xs text-tt-red">
                    Both items were picked and shipped on this order. Correcting it now would put a
                    unit back in stock that the customer already has. Dismiss it instead.
                  </div>
                )}
                <div className="flex flex-col gap-2">
                  {unitsOf(r).map(({ line: l, unit_key, ordinal, of }) => {
                    const pending = confirmKeep?.order_id === r.order_id && confirmKeep?.unit_key === unit_key;
                    return (
                      <div
                        key={unit_key}
                        className={`flex items-center gap-3 rounded-xl border-2 p-2 ${pending ? 'border-tt-cyan bg-tt-cyan/10' : 'border-tt-border bg-tt-bg'}`}
                      >
                        {l.thumbnail_url ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={l.thumbnail_url} alt="" className="h-12 w-12 rounded-lg object-cover border border-tt-border" onError={(e) => { e.currentTarget.style.display = 'none'; }} />
                        ) : (
                          <span className="h-12 w-12 rounded-lg border border-tt-border flex items-center justify-center font-mono text-xs text-tt-muted">#{l.sku_number ?? '?'}</span>
                        )}
                        <div className="min-w-0 flex-1">
                          <div className="font-mono font-bold text-tt-text text-sm">
                            #{l.sku_number ?? '?'}
                            {/* Two cards for the same SKU are indistinguishable without this — the
                                member needs to see they are looking at unit 1 and unit 2 of one
                                double-scan, not at two different items. */}
                            {of > 1 ? <span className="ml-2 font-sans text-xs text-tt-red">scan {ordinal} of {of}</span> : null}
                          </div>
                          <div className="text-xs text-tt-muted truncate">{l.title ?? '—'}</div>
                        </div>
                        {pending ? (
                          <div className="shrink-0 flex items-center gap-1">
                            <button
                              onClick={() => doKeep(r, l.sku_id)}
                              disabled={busy}
                              className="rounded-lg bg-tt-cyan px-3 py-2 text-xs font-bold text-black hover:opacity-90 disabled:opacity-40"
                            >
                              {busy ? 'Fixing…' : 'Confirm — keep this'}
                            </button>
                            <button
                              onClick={() => setConfirmKeep(null)}
                              disabled={busy}
                              className="rounded-lg border border-tt-border px-3 py-2 text-xs text-tt-muted hover:text-tt-text disabled:opacity-40"
                            >
                              Cancel
                            </button>
                          </div>
                        ) : !r.unpacked ? null : (
                          <button
                            onClick={() => { setConfirmKeep({ order_id: r.order_id, unit_key, sku_id: l.sku_id }); setRowErr((e) => ({ ...e, [r.order_id]: '' })); }}
                            disabled={busy}
                            className="shrink-0 rounded-lg border-2 border-tt-border px-3 py-2 text-xs font-semibold text-tt-text hover:bg-tt-card-hover disabled:opacity-40"
                          >
                            Keep this one
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>

                {/* The confirm step exists because this write moves stock: it restocks every bound
                    line and re-binds the kept one. Never a one-click stock move. */}
                {confirmKeep?.order_id === r.order_id && (
                  <div className="rounded-lg border border-tt-cyan/40 bg-tt-cyan/5 px-3 py-2 text-xs text-tt-muted">
                    Confirming returns all {r.units} items to stock, then re-binds just the one you picked.
                  </div>
                )}

                {rerr && (
                  <div className="rounded-lg border-2 border-tt-red/50 bg-tt-red/10 px-3 py-2 text-sm text-tt-red">{rerr}</div>
                )}

                <div className="flex justify-end pt-1">
                  <button
                    onClick={() => doDismiss(r)}
                    disabled={busy}
                    className="text-xs text-tt-muted underline hover:text-tt-text disabled:opacity-40"
                  >
                    {r.line_count === 1 ? `Not a mistake — they really bought ${r.units}` : 'Not a mistake — they really won both'}
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {!err && total > PAGE_SIZE && (
        <div className="mt-5 flex items-center justify-between">
          <button
            onClick={() => load(page - 1, days, selectedShop, unpackedOnly)}
            disabled={page === 0 || loading}
            className="rounded-lg border border-tt-border px-4 py-2 text-sm text-tt-text hover:bg-tt-card-hover disabled:opacity-40"
          >
            ‹ Prev
          </button>
          <span className="text-sm text-tt-muted">Page {page + 1} of {pageCount}</span>
          <button
            onClick={() => load(page + 1, days, selectedShop, unpackedOnly)}
            disabled={page + 1 >= pageCount || loading}
            className="rounded-lg border border-tt-border px-4 py-2 text-sm text-tt-text hover:bg-tt-card-hover disabled:opacity-40"
          >
            Next ›
          </button>
        </div>
      )}
    </main>
  );
}
