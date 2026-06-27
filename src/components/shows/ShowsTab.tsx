'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLiveSessions, type LiveSession, type SessionStatus } from '@/hooks/useLiveSessions';
import { useAuctionBoard, type AuctionItem } from '@/hooks/useLiveAuctions';
import { useInventorySkus, useCreateSku, type InventorySku } from '@/hooks/useInventorySkus';
import { useUser } from '@/hooks/useUser';

interface UnboundOrder {
  order_id: string;
  buyer: string;
  won_price_cents: number | null;
  seller_sku: string;
  quantity: number;
  status: string;
}

// ── Read-only "Shows" tab ──────────────────────────────────────────────
// Surfaces the user's live sessions and the sales captured in each, built
// entirely from existing read hooks (useLiveSessions + useAuctionBoard).
// No writes, no edits, no deletes.

const money = (c: number | null | undefined) => (c == null ? '—' : `$${(c / 100).toFixed(2)}`);

function fmtDate(iso: string | null): string {
  if (!iso) return 'Unknown date';
  try {
    return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return iso;
  }
}

// Real winning bid for a sold item (the actual outcome), joined from
// capture_events. not_sold items have no won price; a sold item logged without
// a captured sale (e.g. manual) may also be null.
function wonCents(it: AuctionItem): number | null {
  if (it.status !== 'sold') return null;
  return it.won_price_cents;
}

interface ShowSummary {
  itemsSold: number;
  unitsSold: number;
  saleCents: number;
  costCents: number;
  profitCents: number;
}

// P&L summary over SOLD items only, using the REAL won price (not the ASP goal):
// sale value = Σ won price, cost from inventory_skus, gross profit = sale − cost.
// itemsSold = sold auction-item ROWS; unitsSold = Σ units (qty across SKU lines)
// so a bundled win counts each unit (added alongside the existing row count).
function summarize(items: AuctionItem[]): ShowSummary {
  let itemsSold = 0;
  let unitsSold = 0;
  let sale = 0;
  let cost = 0;
  for (const it of items) {
    if (it.status === 'sold') {
      itemsSold += 1;
      unitsSold += it.units ?? 0;
      sale += wonCents(it) ?? 0;
      cost += it.total_cost_cents ?? 0;
    }
  }
  return { itemsSold, unitsSold, saleCents: sale, costCents: cost, profitCents: sale - cost };
}

// ASP per UNIT = realized sale value ÷ units sold (not per-auction). 0 when no units.
function aspPerUnitCents(s: ShowSummary): number {
  return s.unitsSold > 0 ? Math.round(s.saleCents / s.unitsSold) : 0;
}

function StatusBadge({ status }: { status: SessionStatus }) {
  const live = status === 'live';
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-xs font-medium ${
        live ? 'text-tt-green' : 'text-tt-muted'
      }`}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${live ? 'bg-tt-green' : 'bg-tt-muted'}`} />
      {live ? 'Live' : status === 'ended' ? 'Ended' : status === 'reconciled' ? 'Reconciled' : 'Draft'}
    </span>
  );
}

function profitClass(cents: number) {
  return cents > 0 ? 'text-tt-green' : cents < 0 ? 'text-tt-red' : 'text-tt-text';
}

// "2h 14m" / "47m" from a duration in ms (null when unknown).
function fmtDuration(ms: number | null | undefined): string | null {
  if (ms == null || ms < 0) return null;
  const mins = Math.round(ms / 60000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

// Out-of-stock / oversell bind wording (shared by the in-app confirm modal).
// Two cases per SKU: a true total shortfall (cur < qty), or Option-X — enough
// total stock but no single batch (cost layer) is large enough, so the newest
// layer goes negative. Both end with the going-negative warning.
function shortLine(s: { n: number; cur: number; qty: number; largest: number }): string {
  if (s.cur < s.qty) {
    return `#${s.n} has ${s.cur} in stock — binding ${s.qty} takes it to ${s.cur - s.qty}`;
  }
  return `#${s.n} has ${s.cur} in stock but no single cost layer covers ${s.qty} (largest layer is ${s.largest}) — binding oversells the newest layer into the negative`;
}
function shortConfirmMessage(short: { n: number; cur: number; qty: number; largest: number }[]): string {
  const tail = ' This usually means the count was off, stock is split across layers, or you oversold. Bind anyway?';
  return short.length === 1
    ? `${shortLine(short[0])}.${tail}`
    : `These SKUs will go negative:\n${short.map((s) => `  ${shortLine(s)}`).join('\n')}\n\n${tail.trim()}`;
}

export default function ShowsTab() {
  const { data: sessions = [], isLoading } = useLiveSessions();
  const { user } = useUser();
  const isAdmin = user?.app_metadata?.role === 'admin';
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const selected = useMemo(
    () => sessions.find((s) => s.id === selectedId) ?? null,
    [sessions, selectedId],
  );

  // Drill-in detail view has its own layout — no Practice Mode card here.
  if (selected) {
    return <ShowDetail session={selected} onBack={() => setSelectedId(null)} />;
  }

  return (
    <div className="space-y-4">
      {isAdmin && <PracticeModeCard />}

      {isLoading ? (
        <div className="flex items-center justify-center py-16 text-tt-muted">
          <div className="w-5 h-5 border-2 border-tt-muted border-t-transparent rounded-full animate-spin mr-3" />
          Loading shows…
        </div>
      ) : sessions.length === 0 ? (
        <div className="rounded-2xl border border-tt-border bg-tt-card py-16 text-center">
          <div className="text-tt-text font-medium">No shows yet</div>
          <p className="text-sm text-tt-muted mt-2 max-w-sm mx-auto">
            When you run a live auction, each session and the sales captured in it will appear here.
          </p>
        </div>
      ) : (
        <div className="rounded-2xl border border-tt-border bg-tt-card overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-tt-border text-tt-muted text-xs uppercase tracking-wide">
                <th className="text-left font-medium px-4 py-3">Show</th>
                <th className="text-left font-medium px-4 py-3">Status</th>
                <th className="text-right font-medium px-4 py-3">Auctions won</th>
                <th className="text-right font-medium px-4 py-3">Units sold</th>
                <th className="text-right font-medium px-4 py-3">Sale value</th>
                <th className="text-right font-medium px-4 py-3">Cost</th>
                <th className="text-right font-medium px-4 py-3">Gross profit</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => (
                <ShowRow key={s.id} session={s} onOpen={setSelectedId} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// Admin-only entry into the internal training simulator.
function PracticeModeCard() {
  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-tt-border bg-tt-card p-4 backdrop-blur-xl sm:flex-row sm:items-center sm:justify-between">
      <div>
        <div className="text-sm font-semibold text-tt-text">Practice Mode</div>
        <p className="text-[13px] text-tt-muted">Train live auction hosts before a real live.</p>
      </div>
      <Link
        href="/admin/training/practice-mode"
        className="inline-flex min-h-[40px] shrink-0 items-center justify-center rounded-lg bg-gradient-to-r from-tt-cyan to-[#4db8c0] px-5 text-sm font-semibold text-black transition-opacity hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-tt-cyan/50"
      >
        Open Practice Mode
      </Link>
    </div>
  );
}

// One list row; fetches its own board (cached, reused by the detail view) to
// compute the show's summary totals.
function ShowRow({ session, onOpen }: { session: LiveSession; onOpen: (id: string) => void }) {
  const { data: items = [], isLoading } = useAuctionBoard(session.id);
  const sum = useMemo(() => summarize(items), [items]);

  return (
    <tr
      onClick={() => onOpen(session.id)}
      className="border-b border-tt-border last:border-0 cursor-pointer hover:bg-tt-card-hover transition-colors"
    >
      <td className="px-4 py-3">
        <div className="font-medium text-tt-text">{session.title || 'Untitled show'}</div>
        <div className="text-xs text-tt-muted mt-0.5">{fmtDate(session.started_at)}</div>
      </td>
      <td className="px-4 py-3">
        <StatusBadge status={session.status} />
      </td>
      <td className="px-4 py-3 text-right tabular-nums">{isLoading ? '…' : sum.itemsSold}</td>
      <td className="px-4 py-3 text-right tabular-nums">{isLoading ? '…' : sum.unitsSold}</td>
      <td className="px-4 py-3 text-right tabular-nums">{isLoading ? '…' : money(sum.saleCents)}</td>
      <td className="px-4 py-3 text-right tabular-nums">{isLoading ? '…' : money(sum.costCents)}</td>
      <td className={`px-4 py-3 text-right tabular-nums font-medium ${isLoading ? '' : profitClass(sum.profitCents)}`}>
        {isLoading ? '…' : money(sum.profitCents)}
      </td>
    </tr>
  );
}

function ShowDetail({ session, onBack }: { session: LiveSession; onBack: () => void }) {
  const { data: items = [], isLoading } = useAuctionBoard(session.id);
  const sum = useMemo(() => summarize(items), [items]);
  // Net profit (so far) + its cost base, over costed sold items that HAVE a
  // payout figure (orders without a payout are excluded, not zeroed). The same
  // restricted set drives ROI so numerator and denominator stay aligned.
  const { netProfitTotal, netCostBase } = useMemo(() => {
    let netProfitTotal = 0, netCostBase = 0;
    for (const it of items) {
      if (it.status === 'sold' && it.net_payout_cents != null && it.total_cost_cents != null) {
        netProfitTotal += it.net_payout_cents - it.total_cost_cents;
        netCostBase += it.total_cost_cents;
      }
    }
    return { netProfitTotal, netCostBase };
  }, [items]);
  // ROI (net) = net profit ÷ cost × 100, over costed-with-payout orders only.
  // Blank until there's a cost base (i.e. payout data exists for costed orders).
  const roiNet = netCostBase > 0 ? (netProfitTotal / netCostBase) * 100 : null;

  // Active-selling duration (last capture − start, or a sane ended_at). Header only.
  const { data: duration } = useQuery<{ duration_ms: number | null; source: string } | null>({
    queryKey: ['show-duration', session.id],
    queryFn: async () => {
      const r = await fetch(`/api/live/sessions/${session.id}/duration`);
      return r.ok ? r.json() : null;
    },
    staleTime: 60_000,
  });
  const durationLabel = fmtDuration(duration?.duration_ms);
  // Units / hr = units sold ÷ active-selling hours. Null when duration unknown.
  const unitsPerHr = duration?.duration_ms && duration.duration_ms > 0
    ? sum.unitsSold / (duration.duration_ms / 3_600_000)
    : null;
  // Whether any sold row has a payout figure → the Profit column/card upgrades
  // from provisional (won−cost) to net (payout−cost, after fees). Works on a
  // fresh reload too (board-derived), not only right after a refresh click.
  const anyPayout = useMemo(() => items.some((it) => it.net_payout_cents != null), [items]);

  const qc = useQueryClient();
  const { data: invSkus = [] } = useInventorySkus();
  const createSku = useCreateSku();
  // SKUs created inline via "+ New SKU" — merged in immediately so they're
  // selectable before the inventory list refetch lands (deduped once it does).
  const [newSkus, setNewSkus] = useState<InventorySku[]>([]);
  const allSkus = useMemo(() => {
    const have = new Set(invSkus.map((s) => s.id));
    return [...invSkus, ...newSkus.filter((n) => !have.has(n.id))];
  }, [invSkus, newSkus]);
  // Inline quick-add form: which (order, line) it's attached to + its inputs.
  const [quickAdd, setQuickAdd] = useState<{ orderId: string; idx: number } | null>(null);
  const [qaName, setQaName] = useState('');
  const [qaCost, setQaCost] = useState('');
  const [qaSaving, setQaSaving] = useState(false);
  const [qaError, setQaError] = useState<string | null>(null);
  // One visible outcome for every bind attempt (success or the route's error) —
  // never a dead button.
  const [bindNotice, setBindNotice] = useState<{ type: 'success' | 'error'; msg: string } | null>(null);
  const [reconciling, setReconciling] = useState(false);
  const [recon, setRecon] = useState<{ flipped_count: number; revenue_cents: number; revenue_count: number; costed_count: number; unbound: UnboundOrder[] } | null>(null);
  // Payouts are a separate, slower action (pages the shop's unsettled list) —
  // this holds the most recent "Refresh payouts" response (authoritative totals
  // across ALL session orders, incl. unbound). Gates the payout summary display.
  const [refreshingPayouts, setRefreshingPayouts] = useState(false);
  const [payout, setPayout] = useState<{ net_payout_cents_total: number; payout_count: number; settled_count: number; estimate_count: number } | null>(null);
  // order_id -> SKU lines the host is assigning (multi-SKU / multi-qty bundles)
  const [lines, setLines] = useState<Record<string, { sku_id: string; qty: number }[]>>({});
  const [bindingId, setBindingId] = useState<string | null>(null);
  // In-app (themed) out-of-stock confirm — replaces window.confirm. Holds the
  // pending bind until the user confirms (→ allow_negative) or cancels (→ abort).
  const [bindConfirm, setBindConfirm] = useState<{ u: UnboundOrder; orderLines: { sku_id: string; qty: number }[]; short: { n: number; cur: number; qty: number; largest: number }[] } | null>(null);

  function setLinesFor(orderId: string, next: { sku_id: string; qty: number }[]) {
    setLines((l) => ({ ...l, [orderId]: next }));
  }
  function updateLine(orderId: string, idx: number, patch: Partial<{ sku_id: string; qty: number }>) {
    setLines((l) => ({ ...l, [orderId]: (l[orderId] ?? []).map((ln, i) => (i === idx ? { ...ln, ...patch } : ln)) }));
  }
  function addLine(orderId: string) {
    setLines((l) => ({ ...l, [orderId]: [...(l[orderId] ?? []), { sku_id: '', qty: 1 }] }));
  }
  function removeLine(orderId: string, idx: number) {
    setLines((l) => ({ ...l, [orderId]: (l[orderId] ?? []).filter((_, i) => i !== idx) }));
  }

  // Post-show reconcile: flip stuck paid orders + compute revenue + detect unbound orders.
  async function reconcile() {
    setReconciling(true);
    try {
      const res = await fetch(`/api/live/sessions/${session.id}/reconcile`, { method: 'POST' });
      if (!res.ok) return;
      const json = await res.json();
      setRecon({
        flipped_count: json.flipped_count, revenue_cents: json.revenue_cents,
        revenue_count: json.revenue_count, costed_count: json.costed_count, unbound: json.unbound,
      });
      // Seed one SKU line per order, pre-picked when seller_sku matches an inventory sku_number (hint only).
      const pre: Record<string, { sku_id: string; qty: number }[]> = {};
      for (const u of json.unbound as UnboundOrder[]) {
        const m = invSkus.find((s) => String(s.sku_number) === u.seller_sku);
        pre[u.order_id] = [{ sku_id: m?.id ?? '', qty: u.quantity || 1 }];
      }
      setLines((l) => ({ ...pre, ...l }));
      if (json.flipped_count > 0) qc.invalidateQueries({ queryKey: ['auction-board', session.id] });
    } finally {
      setReconciling(false);
    }
  }

  // Refresh per-order true payouts (TikTok Finance). Independent of Reconcile —
  // slow, because it pages the shop's unsettled list. On completion, invalidate
  // the board so the ACTUAL PAYOUT / NET PROFIT columns repopulate from the join.
  async function refreshPayouts() {
    setRefreshingPayouts(true);
    try {
      const res = await fetch(`/api/live/sessions/${session.id}/payouts`, { method: 'POST' });
      if (!res.ok) return;
      const json = await res.json();
      setPayout({
        net_payout_cents_total: json.net_payout_cents_total ?? 0,
        payout_count: json.payout_count ?? 0,
        settled_count: json.settled_count ?? 0,
        estimate_count: json.estimate_count ?? 0,
      });
      qc.invalidateQueries({ queryKey: ['auction-board', session.id] });
    } finally {
      setRefreshingPayouts(false);
    }
  }

  // Create a brand-new SKU inline (NAME + COST only, 0 starting stock) and select
  // it into the line the host is working in. sku_number is app-assigned, so we
  // auto-pick the next number (retrying on the rare race). Binding a sale against
  // its 0 stock goes negative via the same confirm path — no special-casing.
  async function submitQuickAdd() {
    if (!quickAdd) return;
    const name = qaName.trim();
    if (!name) { setQaError('Name is required'); return; }
    const costStr = qaCost.trim();
    const costCents = costStr === '' ? null : Math.round(Number(costStr) * 100);
    if (costCents != null && !Number.isFinite(costCents)) { setQaError('Cost must be a number'); return; }
    setQaSaving(true); setQaError(null);
    try {
      let n = allSkus.reduce((m, s) => Math.max(m, s.sku_number), 0) + 1;
      let created: InventorySku | null = null;
      for (let attempt = 0; attempt < 3 && !created; attempt++) {
        try {
          const json = await createSku.mutateAsync({ fields: { sku_number: n, title: name, unit_cost_cents: costCents, qty_on_hand: 0 } });
          created = json.sku as InventorySku;
        } catch (e) {
          const msg = e instanceof Error ? e.message : '';
          if (/already exists/i.test(msg)) { n += 1; continue; } // sku_number race → bump + retry
          throw e;
        }
      }
      if (!created) { setQaError('Could not assign a SKU number — try again'); return; }
      setNewSkus((arr) => [...arr, created!]);
      updateLine(quickAdd.orderId, quickAdd.idx, { sku_id: created.id });
      setQuickAdd(null); setQaName(''); setQaCost('');
    } catch (e) {
      setQaError(e instanceof Error ? e.message : 'Failed to create SKU');
    } finally {
      setQaSaving(false);
    }
  }

  // Retroactive manual bind of one unbound order to its chosen SKU line(s).
  // A bind is a real sale that already happened, so insufficient stock is a
  // miscount, not a blocker: confirm, then allow inventory to go negative.
  async function bindOne(u: UnboundOrder) {
    const orderLines = (lines[u.order_id] ?? []).filter((x) => x.sku_id);
    if (orderLines.length === 0) return;
    setBindNotice(null);

    // Collapse by SKU (mirrors the server) and check stock for the confirm prompt.
    // Option X: an oversell is when NO SINGLE batch covers the whole qty — which
    // can happen even with enough TOTAL stock (split across layers). We must use
    // batch-level data to fire the confirm, not total qty_on_hand.
    const collapsed = new Map<string, number>();
    for (const l of orderLines) collapsed.set(l.sku_id, (collapsed.get(l.sku_id) ?? 0) + Math.max(1, l.qty || 1));
    const short: { n: number; cur: number; qty: number; largest: number }[] = [];
    for (const [sku_id, qty] of collapsed) {
      const s = allSkus.find((x) => x.id === sku_id);
      const cur = s?.qty_on_hand ?? 0;
      const largest = (s?.batches ?? []).reduce((m, b) => Math.max(m, b.qty_remaining), 0);
      if (largest < qty) short.push({ n: s?.sku_number ?? 0, cur, qty, largest });
    }
    if (short.length > 0) {
      // Defer to the in-app confirm modal; it calls executeBind on confirm.
      setBindConfirm({ u, orderLines, short });
      return;
    }
    await executeBind(u, orderLines, false);
  }

  // The actual bind request + outcome handling. allowNegative is true only when
  // the user confirmed an out-of-stock bind via the modal.
  async function executeBind(u: UnboundOrder, orderLines: { sku_id: string; qty: number }[], allowNegative: boolean) {
    setBindingId(u.order_id);
    try {
      const res = await fetch(`/api/live/sessions/${session.id}/bind`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order_id: u.order_id, lines: orderLines, allow_negative: allowNegative }),
      });
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (res.ok) {
        setRecon((r) => (r ? { ...r, unbound: r.unbound.filter((x) => x.order_id !== u.order_id) } : r));
        qc.invalidateQueries({ queryKey: ['auction-board', session.id] });
        qc.invalidateQueries({ queryKey: ['inventory-skus'] });
        setBindNotice({ type: 'success', msg: `Bound order ${u.order_id} to inventory${allowNegative ? ' — stock went negative (recount flagged).' : '.'}` });
      } else {
        setBindNotice({ type: 'error', msg: `Bind failed for order ${u.order_id}: ${json.error || 'Unknown error'}` });
      }
    } catch {
      setBindNotice({ type: 'error', msg: `Bind failed for order ${u.order_id}: network error` });
    } finally {
      setBindingId(null);
    }
  }

  // Download a CSV of this show's auction items (server builds it; filename =
  // show title + local start date, e.g. tiktok-live_2026-06-22.csv).
  async function exportCsv() {
    try {
      const res = await fetch(`/api/live/sessions/${session.id}/export`);
      if (!res.ok) return;
      const { title, started_at, csv } = await res.json();
      const slug = (title || 'show').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const d = started_at ? new Date(started_at) : new Date();
      const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const blob = new Blob([csv], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${slug}_${date}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      /* ignore */
    }
  }

  return (
    <div>
      {/* Header */}
      <div className="flex items-start justify-between gap-4 mb-5">
        <div>
          <button
            onClick={onBack}
            className="text-xs text-tt-cyan cursor-pointer hover:underline mb-2"
          >
            ← All shows
          </button>
          <div className="text-xl font-bold">{session.title || 'Untitled show'}</div>
          <div className="text-sm text-tt-muted mt-1 flex items-center gap-3">
            <span>{fmtDate(session.started_at)}</span>
            <StatusBadge status={session.status} />
            {durationLabel && (
              <span title={`Active selling time (source: ${duration?.source === 'ended_at' ? 'session end' : 'last sale'})`}>
                Duration {durationLabel}
              </span>
            )}
          </div>
        </div>
        <div className="shrink-0 flex items-center gap-2">
          <button
            onClick={reconcile}
            disabled={reconciling}
            className="px-4 py-2 rounded-lg border border-tt-border text-sm font-medium text-tt-text cursor-pointer hover:bg-tt-card-hover transition-colors disabled:opacity-50"
          >
            {reconciling ? 'Reconciling…' : 'Reconcile orders'}
          </button>
          <button
            onClick={refreshPayouts}
            disabled={refreshingPayouts}
            className="px-4 py-2 rounded-lg border border-tt-border text-sm font-medium text-tt-text cursor-pointer hover:bg-tt-card-hover transition-colors disabled:opacity-50"
          >
            {refreshingPayouts ? 'Refreshing payouts…' : 'Refresh payouts'}
          </button>
          <button
            onClick={exportCsv}
            className="px-4 py-2 rounded-lg border border-tt-border text-sm font-medium text-tt-text cursor-pointer hover:bg-tt-card-hover transition-colors"
          >
            Export CSV
          </button>
        </div>
      </div>

      {/* Reconciliation results */}
      {recon && (
        <div className="mb-5 space-y-3">
          {bindNotice && (
            <div className={`rounded-lg px-4 py-2.5 text-sm ${bindNotice.type === 'success' ? 'border border-tt-green/40 bg-tt-green/10 text-tt-green' : 'border border-tt-red/40 bg-tt-red/10 text-tt-red'}`}>
              {bindNotice.msg}
            </div>
          )}
          {recon.flipped_count > 0 && (
            <div className="rounded-lg border border-tt-green/40 bg-tt-green/10 px-4 py-2.5 text-sm text-tt-green">
              Flipped {recon.flipped_count} order{recon.flipped_count === 1 ? '' : 's'} to sold (paid after capture).
            </div>
          )}
          {recon.unbound.length > 0 && (
            <div className="rounded-2xl border border-tt-red/40 bg-tt-red/10 p-4">
              <div className="text-sm font-semibold text-tt-red mb-3">
                {recon.unbound.length} order{recon.unbound.length === 1 ? '' : 's'} need inventory (P&amp;L incomplete)
              </div>
              <div className="space-y-3">
                {recon.unbound.map((u) => (
                  <div key={u.order_id} className="flex flex-wrap items-start gap-3 text-sm border-t border-tt-red/20 pt-3 first:border-0 first:pt-0">
                    <div className="min-w-[12rem]">
                      <div><span className="font-mono text-tt-muted">{u.order_id}</span> <span className="text-tt-text">@{u.buyer || '—'}</span></div>
                      <div className="text-xs text-tt-muted">
                        {u.won_price_cents == null ? '—' : `$${(u.won_price_cents / 100).toFixed(2)}`} · seller_sku hint: <span className="font-mono text-tt-text">{u.seller_sku || '—'}</span>
                      </div>
                    </div>
                    <div className="flex-1 space-y-1.5">
                      {(lines[u.order_id] ?? []).map((ln, idx) => (
                        <div key={idx}>
                          <div className="flex items-center gap-2">
                            <select
                              value={ln.sku_id}
                              onChange={(e) => updateLine(u.order_id, idx, { sku_id: e.target.value })}
                              className="rounded-lg border border-tt-border bg-tt-input-bg px-2 py-1 text-xs text-tt-text outline-none"
                            >
                              <option value="">Pick SKU…</option>
                              {allSkus.map((s) => (
                                <option key={s.id} value={s.id}>#{s.sku_number} {s.title}</option>
                              ))}
                            </select>
                            <input
                              type="number" min={1} value={ln.qty}
                              onChange={(e) => updateLine(u.order_id, idx, { qty: Math.max(1, Math.trunc(Number(e.target.value) || 1)) })}
                              className="w-16 rounded-lg border border-tt-border bg-tt-input-bg px-2 py-1 text-xs text-tt-text outline-none tabular-nums"
                              aria-label="Quantity"
                            />
                            <button
                              onClick={() => { setQuickAdd({ orderId: u.order_id, idx }); setQaName(''); setQaCost(''); setQaError(null); }}
                              className="text-xs text-tt-cyan cursor-pointer hover:underline px-1"
                              title="Create a new inventory SKU"
                            >+ New SKU</button>
                            {(lines[u.order_id]?.length ?? 0) > 1 && (
                              <button onClick={() => removeLine(u.order_id, idx)} className="text-tt-muted hover:text-tt-red text-xs px-1" aria-label="Remove line">✕</button>
                            )}
                          </div>
                          {quickAdd?.orderId === u.order_id && quickAdd?.idx === idx && (
                            <div className="mt-1.5 flex flex-wrap items-center gap-2 rounded-lg border border-tt-border bg-tt-input-bg/40 p-2">
                              <input
                                autoFocus placeholder="New SKU name" value={qaName}
                                onChange={(e) => setQaName(e.target.value)}
                                onKeyDown={(e) => { if (e.key === 'Enter') submitQuickAdd(); if (e.key === 'Escape') setQuickAdd(null); }}
                                className="flex-1 min-w-[10rem] rounded-lg border border-tt-border bg-tt-input-bg px-2 py-1 text-xs text-tt-text outline-none"
                              />
                              <input
                                placeholder="Cost $" inputMode="decimal" value={qaCost}
                                onChange={(e) => setQaCost(e.target.value)}
                                onKeyDown={(e) => { if (e.key === 'Enter') submitQuickAdd(); if (e.key === 'Escape') setQuickAdd(null); }}
                                className="w-24 rounded-lg border border-tt-border bg-tt-input-bg px-2 py-1 text-xs text-tt-text outline-none tabular-nums"
                              />
                              <button
                                onClick={submitQuickAdd}
                                disabled={qaSaving || !qaName.trim()}
                                className="px-2.5 py-1 rounded-lg bg-tt-cyan text-black text-xs font-semibold cursor-pointer hover:opacity-90 disabled:opacity-40"
                              >{qaSaving ? 'Creating…' : 'Create & select'}</button>
                              <button onClick={() => setQuickAdd(null)} className="text-tt-muted hover:text-tt-text text-xs px-1">Cancel</button>
                              {qaError && <span className="text-tt-red text-xs w-full">{qaError}</span>}
                              <span className="text-[10px] text-tt-muted w-full">Creates at 0 stock — add a picture later in Inventory. Binding a sale will take it negative (you&apos;ll confirm).</span>
                            </div>
                          )}
                        </div>
                      ))}
                      <button onClick={() => addLine(u.order_id)} className="text-xs text-tt-cyan cursor-pointer hover:underline">+ add SKU</button>
                    </div>
                    <button
                      onClick={() => bindOne(u)}
                      disabled={!(lines[u.order_id] ?? []).some((x) => x.sku_id) || bindingId === u.order_id}
                      className="px-3 py-1 rounded-lg bg-tt-cyan text-black text-xs font-semibold cursor-pointer hover:opacity-90 disabled:opacity-40"
                    >
                      {bindingId === u.order_id ? 'Binding…' : 'Bind'}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Summary cards. Before reconcile: normal board figures. After reconcile:
          "Sale value" becomes capture-based Revenue (all paid wins) + a completeness caption. */}
      <div className={`grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 ${recon || payout ? 'mb-2' : 'mb-6'}`}>
        <SummaryCard label="Auctions won" value={isLoading ? '…' : String(sum.itemsSold)} />
        <SummaryCard label="Units sold" value={isLoading ? '…' : String(sum.unitsSold)} />
        <SummaryCard
          label="Units / hr"
          value={isLoading ? '…' : unitsPerHr == null ? '—' : unitsPerHr >= 10 ? String(Math.round(unitsPerHr)) : unitsPerHr.toFixed(1)}
        />
        {recon ? (
          <SummaryCard label="Revenue (all wins)" value={money(recon.revenue_cents)} />
        ) : (
          <SummaryCard label="Sale value" value={isLoading ? '…' : money(sum.saleCents)} />
        )}
        <SummaryCard label="ASP / unit" value={isLoading ? '…' : money(aspPerUnitCents(sum))} />
        <SummaryCard label="Cost" value={isLoading ? '…' : money(sum.costCents)} />
        {/* ONE adaptive Profit card: provisional won−cost total until payout data
            exists, then the true net (payout−cost) total — label tracks the state. */}
        {anyPayout ? (
          <SummaryCard label="Profit (net, after fees)" value={isLoading ? '…' : money(netProfitTotal)} valueClass={isLoading ? '' : profitClass(netProfitTotal)} />
        ) : (
          <SummaryCard
            label={recon ? 'Profit (won−cost), so far' : 'Profit (won−cost)'}
            value={isLoading ? '…' : money(sum.profitCents)}
            valueClass={isLoading ? '' : profitClass(sum.profitCents)}
          />
        )}
        {/* Payout-only extras (after a "Refresh payouts" run): authoritative net
            payout across ALL orders incl. unbound, and ROI. Net profit itself is
            folded into the adaptive Profit card above. */}
        {payout && (
          <>
            <SummaryCard label="Net payout (so far)" value={money(payout.net_payout_cents_total)} />
            <SummaryCard
              label="ROI (net)"
              value={roiNet == null ? '—' : `${roiNet.toFixed(0)}%`}
              valueClass={roiNet == null ? '' : profitClass(roiNet)}
            />
          </>
        )}
      </div>
      {recon && (
        <div className={`text-xs text-tt-muted ${payout ? 'mb-2' : 'mb-6'}`}>
          Revenue {money(recon.revenue_cents)} is final (all {recon.revenue_count} paid wins).
          {' '}P&amp;L complete for {recon.costed_count} of {recon.revenue_count} orders
          {recon.unbound.length > 0 ? ` — ${recon.unbound.length} still need inventory` : ''}. Gross profit covers costed orders only.
        </div>
      )}
      {payout && (
        <div className="text-xs text-tt-muted mb-6">
          Payouts in for {payout.payout_count}{recon ? ` of ${recon.revenue_count}` : ''} orders
          ({payout.settled_count} actual, {payout.estimate_count} est).
          Net payout/profit reflect TikTok fees; estimates until settled.
        </div>
      )}

      {/* Items table */}
      {isLoading ? (
        <div className="flex items-center justify-center py-16 text-tt-muted">
          <div className="w-5 h-5 border-2 border-tt-muted border-t-transparent rounded-full animate-spin mr-3" />
          Loading items…
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-2xl border border-tt-border bg-tt-card py-12 text-center text-tt-muted text-sm">
          No auction items captured for this show.
        </div>
      ) : (
        <div className="rounded-2xl border border-tt-border bg-tt-card overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-tt-border text-tt-muted text-xs uppercase tracking-wide">
                <th className="text-left font-medium px-4 py-3">#</th>
                <th className="text-left font-medium px-4 py-3">SKU(s)</th>
                <th className="text-right font-medium px-4 py-3">Qty</th>
                <th className="text-center font-medium px-4 py-3">Result</th>
                <th className="text-right font-medium px-4 py-3">ASP Goal</th>
                <th className="text-right font-medium px-4 py-3">Won price</th>
                <th className="text-right font-medium px-4 py-3">Cost</th>
                <th className="text-right font-medium px-4 py-3">
                  Profit<span className="normal-case text-tt-muted"> {anyPayout ? '(net, after fees)' : '(won−cost)'}</span>
                </th>
                <th className="text-right font-medium px-4 py-3">Actual payout</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it) => {
                const sold = it.status === 'sold';
                const won = wonCents(it); // real winning bid (sold items only)
                const cost = it.total_cost_cents;
                // ONE adaptive profit figure (always the best available), blank-not-zero:
                //   payout present → payout − cost (true, after fees)
                //   else won present → won − cost (provisional)
                //   no cost → '—'.
                let profit: number | null = null;
                if (sold && cost != null) {
                  if (it.net_payout_cents != null) profit = it.net_payout_cents - cost;
                  else if (won != null) profit = won - cost;
                }
                return (
                  <tr key={it.id} className="border-b border-tt-border last:border-0">
                    <td className="px-4 py-3 text-tt-muted tabular-nums">{it.auction_number}</td>
                    <td className="px-4 py-3">
                      <div className="flex flex-col gap-0.5">
                        {it.tiktok_title ? (
                          <span className="min-w-0 truncate text-tt-text">{it.tiktok_title}</span>
                        ) : null}
                        {it.skus.length === 0 ? (
                          !it.tiktok_title ? <span className="text-tt-muted">—</span> : null
                        ) : (
                          it.skus.map((sk) => (
                            <span key={sk.inventory_sku_id} className="min-w-0 truncate text-xs text-tt-muted">
                              <span className="font-mono text-tt-cyan">#{sk.sku_number}</span>{' '}
                              <span>{sk.title || 'Untitled'}</span>
                              {sk.qty > 1 ? <span> ×{sk.qty}</span> : null}
                            </span>
                          ))
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">{it.units}</td>
                    <td className="px-4 py-3 text-center">
                      <span
                        className={`text-xs font-medium ${
                          sold ? 'text-tt-green' : it.payment_failed ? 'text-tt-red' : 'text-tt-muted'
                        }`}
                      >
                        {sold ? 'Sold' : it.payment_failed ? 'Payment failed' : 'Not sold'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-tt-muted">{money(it.expected_price_cents)}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{money(sold ? won : null)}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{money(cost)}</td>
                    <td className={`px-4 py-3 text-right tabular-nums ${profit == null ? 'text-tt-muted' : profitClass(profit)}`}>
                      {profit == null ? '—' : money(profit)}
                    </td>
                    {/* ACTUAL PAYOUT — net (estimate or settled); "est" tag until settled; blank if none. */}
                    <td className="px-4 py-3 text-right tabular-nums">
                      {it.net_payout_cents == null ? (
                        <span className="text-tt-muted">—</span>
                      ) : (
                        <>
                          {money(it.net_payout_cents)}
                          {!it.payout_settled && (
                            <span
                              className="ml-1 text-[10px] uppercase text-tt-muted cursor-help"
                              title="TikTok's estimate until the order settles."
                            >est</span>
                          )}
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* In-app (themed) out-of-stock bind confirm — replaces window.confirm.
          Same wording + behavior: Cancel aborts, "Bind anyway" sends allow_negative. */}
      {bindConfirm && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={() => setBindConfirm(null)}
          role="dialog"
          aria-modal="true"
        >
          <div
            className="w-full max-w-md rounded-2xl border border-tt-border bg-tt-card p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-sm font-semibold text-tt-text mb-2">Not enough stock</div>
            <div className="text-sm text-tt-muted whitespace-pre-line mb-4">{shortConfirmMessage(bindConfirm.short)}</div>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setBindConfirm(null)}
                className="px-4 py-2 rounded-lg border border-tt-border text-sm font-medium text-tt-text cursor-pointer hover:bg-tt-card-hover transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => { const c = bindConfirm; setBindConfirm(null); void executeBind(c.u, c.orderLines, true); }}
                className="px-4 py-2 rounded-lg bg-tt-cyan text-black text-sm font-semibold cursor-pointer hover:opacity-90 transition-opacity"
              >
                Bind anyway
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function SummaryCard({ label, value, valueClass = '' }: { label: string; value: string; valueClass?: string }) {
  return (
    <div className="rounded-xl border border-tt-border bg-tt-card px-4 py-3">
      <div className="text-xs text-tt-muted">{label}</div>
      <div className={`text-lg font-bold tabular-nums mt-0.5 ${valueClass}`}>{value}</div>
    </div>
  );
}
