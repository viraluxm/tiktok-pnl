'use client';

import { Fragment, useMemo, useState, type KeyboardEvent } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLiveSessions, useShowCoverage, type LiveSession, type SessionStatus } from '@/hooks/useLiveSessions';
import { useAuctionBoard, useUnbind, type AuctionItem, type SessionSku } from '@/hooks/useLiveAuctions';
import { notSoldBadge, paidNeedsFlip } from '@/lib/paymentStatus';
import { ASP_GOAL_MULTIPLIER, aspGoalCents } from '@/lib/asp';
import { useInventorySkus, useCreateSku, type InventorySku } from '@/hooks/useInventorySkus';
import { useUser } from '@/hooks/useUser';
import { useStores } from '@/hooks/useStores';
import MobileDataCard from '@/components/ui/MobileDataCard';

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

// Per-show ASP-hit / below-break-even rates, same definitions as the roster badges but
// scoped to this session. break_even = Σ cost snapshots; asp_goal = break_even × 4 (unified, see @/lib/asp);
// final_price = captured won price. CRITICAL: only auctions with status='sold' AND a
// realized won price AND a known break-even count — payment-failed / unsold / uncosted
// rows are excluded from BOTH numerator and denominator (a failed payment is NOT a loss).
interface ShowRates { soldCount: number; aspHitPct: number | null; belowBePct: number | null }
function showRates(items: AuctionItem[]): ShowRates {
  let n = 0, hits = 0, below = 0;
  for (const it of items) {
    if (it.status !== 'sold') continue;
    const finalPrice = it.won_price_cents;
    const breakEven = it.total_cost_cents;
    if (finalPrice == null || breakEven == null) continue; // exclude non-sales / uncosted
    n += 1;
    if (finalPrice >= breakEven * ASP_GOAL_MULTIPLIER) hits += 1;
    if (finalPrice < breakEven) below += 1;
  }
  return {
    soldCount: n,
    aspHitPct: n > 0 ? (hits / n) * 100 : null,
    belowBePct: n > 0 ? (below / n) * 100 : null,
  };
}

// ASP-hit tone: green at/above the 35% bonus bar, neutral otherwise.
function aspHitClass(pct: number | null): string {
  return pct != null && pct >= 35 ? 'text-tt-green' : 'text-tt-text';
}
// Below-break-even tone (placeholder GLOBAL thresholds — same as the roster badges;
// may become store-relative later): red ≥20%, amber 12–20%, green <12%.
function belowBeClass(pct: number | null): string {
  if (pct == null) return 'text-tt-text';
  if (pct >= 20) return 'text-tt-red';
  if (pct >= 12) return 'text-tt-yellow';
  return 'text-tt-green';
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

// Bound sales nearest IN TIME to a captured-but-unbound row → the SKUs most likely to be the
// same item. Unbound rows have no sequence, so we rank by capture-time proximity (their
// ordered_at vs bound rows' closed_at). Returns sku_ids closest-first (deduped). Empty when the
// show has no bound sales yet — the caller then degrades to "no context available".
function nearbySkuIdsForTime(targetIso: string | null | undefined, items: AuctionItem[]): string[] {
  if (!targetIso) return [];
  const t = new Date(targetIso).getTime();
  if (!Number.isFinite(t)) return [];
  const bound = items
    .filter((i) => !i.unbound && i.skus.length > 0 && i.logged_at)
    .map((i) => ({ dt: Math.abs(new Date(i.logged_at).getTime() - t), ids: i.skus.map((s) => String(s.inventory_sku_id)) }))
    .filter((x) => Number.isFinite(x.dt))
    .sort((a, b) => a.dt - b.dt);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const b of bound) {
    for (const id of b.ids) if (!seen.has(id)) { seen.add(id); out.push(id); }
    if (out.length >= 6) break;
  }
  return out;
}

// The TikTok live LOT number for a row (per-show sequence 1,2,3…), or null when the ref isn't a
// pure number. Catalog stores have text variation names ("1 Black"), not lots — those return null
// so the lot column/ordering simply don't apply. NEVER an inventory key: the lot is NOT sku_number
// (confirmed: it matched the bound sku_number only 0.2% of the time — pure coincidence).
function lotOf(it: AuctionItem): number | null {
  const raw = it.seller_sku_hint;
  if (raw == null) return null;
  const s = String(raw).trim();
  return /^[0-9]+$/.test(s) ? Number(s) : null;
}

interface LotNeighbour { lot: number; sku_number: number; title: string; inventory_sku_id: string }

// Bound sales nearest to an unbound row BY LOT NUMBER — the strongest available hint, since hosts
// auction in runs so a neighbouring lot is usually the same or a related item (measured: the true
// SKU is within ±3 lots 26% of the time and the true CATEGORY 99% of the time). Returns the nearest
// bound lot below and above (flanking context — NOT strictly ±1, since consecutive lots are often
// both unbound), a ranked list of their sku_ids closest-first (picker's top tier), and a reason per
// sku_id ("lot 3 was #212 Blue Gummy") so the host is reminded, not just handed a list. Empty when
// the row has no numeric lot or the show has no bound sales yet.
function lotNeighbours(target: AuctionItem, items: AuctionItem[]): {
  below: LotNeighbour | null;
  above: LotNeighbour | null;
  rankedSkuIds: string[];
  reasonById: Map<string, string>;
} {
  const tl = lotOf(target);
  if (tl == null) return { below: null, above: null, rankedSkuIds: [], reasonById: new Map() };
  // Bound rows (real SKU lines) carrying a numeric lot, sorted by absolute lot distance.
  const bound = items
    .filter((i) => !i.unbound && i.skus.length > 0)
    .map((i) => ({ it: i, lot: lotOf(i) }))
    .filter((x): x is { it: AuctionItem; lot: number } => x.lot != null && x.lot !== tl)
    .map((x) => ({ ...x, dist: Math.abs(x.lot - tl) }))
    .sort((a, b) => a.dist - b.dist || a.lot - b.lot);

  const firstSku = (it: AuctionItem | undefined): LotNeighbour | null => {
    if (!it) return null;
    const s = it.skus[0];
    return s ? { lot: lotOf(it)!, sku_number: s.sku_number, title: s.title, inventory_sku_id: String(s.inventory_sku_id) } : null;
  };
  const below = firstSku(bound.filter((b) => b.lot < tl).sort((a, b) => b.lot - a.lot)[0]?.it);
  const above = firstSku(bound.filter((b) => b.lot > tl).sort((a, b) => a.lot - b.lot)[0]?.it);

  const rankedSkuIds: string[] = [];
  const reasonById = new Map<string, string>();
  const seen = new Set<string>();
  for (const b of bound) {
    for (const sk of b.it.skus) {
      const id = String(sk.inventory_sku_id);
      if (seen.has(id)) continue;
      seen.add(id);
      rankedSkuIds.push(id);
      reasonById.set(id, `lot ${b.lot} was #${sk.sku_number}${sk.title ? ` ${sk.title}` : ''}`);
    }
    if (rankedSkuIds.length >= 8) break;
  }
  return { below, above, rankedSkuIds, reasonById };
}

// Ranked, scannable SKU picker for one bind line. NEVER a flat catalogue. Tiers, in order:
// nearby LOTS in this show (with a why-reason), then everything sold in THIS show, then SKUs in
// the same CATEGORY as those neighbour lots, and the full catalogue only once the operator
// searches (fallback). Scanning a barcode (or typing it + Enter) selects the exact SKU.
function RankedSkuPicker({
  value, onChange, allSkus, primaryIds, nearbyIds, reasonById, categoryIds, disabled,
}: {
  value: string;
  onChange: (id: string) => void;
  allSkus: InventorySku[];
  primaryIds: Set<string>;
  nearbyIds: string[];
  reasonById?: Map<string, string>;
  categoryIds?: Set<string>;
  disabled?: boolean;
}) {
  const [q, setQ] = useState('');
  const [scanMsg, setScanMsg] = useState<string | null>(null);
  const byId = useMemo(() => new Map(allSkus.map((s) => [s.id, s])), [allSkus]);
  const selected = value ? byId.get(value) ?? null : null;

  const query = q.trim().toLowerCase();
  const match = (s: InventorySku) =>
    !query || `#${s.sku_number} ${s.title} ${s.category ?? ''} ${s.barcode ?? ''}`.toLowerCase().includes(query);
  const nearby = nearbyIds.map((id) => byId.get(id)).filter((s): s is InventorySku => !!s);
  const nearbySet = new Set(nearby.map((s) => s.id));
  const primary = allSkus.filter((s) => primaryIds.has(s.id) && !nearbySet.has(s.id) && match(s));
  const primarySet = new Set(primary.map((s) => s.id));
  // Same category as the neighbour lots — surfaces the right family when the exact SKU isn't a
  // neighbour (the true category is a neighbour's category 99% of the time).
  const catSet = categoryIds ?? new Set<string>();
  const category = allSkus.filter((s) => catSet.has(s.id) && !nearbySet.has(s.id) && !primarySet.has(s.id) && match(s));
  const categoryShown = new Set(category.map((s) => s.id));
  // Fallback: the rest of the catalogue, ONLY while searching (never the flat 217 by default).
  const fallback = query
    ? allSkus.filter((s) => !primaryIds.has(s.id) && !nearbySet.has(s.id) && !categoryShown.has(s.id) && match(s)).slice(0, 25)
    : [];
  const groups = [
    { key: 'nearby', label: 'Nearby lots in this show', skus: nearby.filter(match) },
    { key: 'primary', label: 'Sold in this show', skus: primary },
    { key: 'category', label: 'Same category as nearby lots', skus: category },
    { key: 'all', label: 'All SKUs (search)', skus: fallback },
  ].filter((g) => g.skus.length > 0);

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const code = q.trim();
    if (!code) return;
    const hit = allSkus.find((s) => s.barcode && s.barcode === code); // exact barcode = scan
    if (hit) { onChange(hit.id); setQ(''); setScanMsg(null); }
    else setScanMsg(`No SKU with barcode "${code}"`);
  }

  return (
    <div className="min-w-[15rem]">
      {selected && (
        <div className="flex items-center gap-2 mb-1 text-xs">
          <span><span className="font-mono text-tt-cyan">#{selected.sku_number}</span> {selected.title || 'Untitled'}</span>
          <button onClick={() => onChange('')} disabled={disabled} className="text-tt-muted hover:text-tt-red cursor-pointer">change</button>
        </div>
      )}
      <input
        value={q}
        onChange={(e) => { setQ(e.target.value); setScanMsg(null); }}
        onKeyDown={onKeyDown}
        disabled={disabled}
        placeholder="Search or scan barcode…"
        className="w-full rounded-md border border-tt-border bg-tt-input-bg px-2 py-1 text-xs text-tt-text outline-none"
      />
      {scanMsg && <div className="text-[10px] text-tt-red mt-0.5">{scanMsg}</div>}
      {groups.length > 0 && (
        <div className="mt-1 max-h-44 overflow-y-auto rounded-md border border-tt-border divide-y divide-tt-border/50">
          {groups.map((g) => (
            <div key={g.key}>
              <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-tt-muted bg-tt-card sticky top-0">{g.label}</div>
              {g.skus.map((s) => {
                const reason = g.key === 'nearby' ? reasonById?.get(s.id) : undefined;
                return (
                  <button
                    key={s.id}
                    onClick={() => { onChange(s.id); setQ(''); }}
                    disabled={disabled}
                    className={`flex w-full items-center justify-between gap-2 px-2 py-1 text-left text-xs cursor-pointer hover:bg-tt-card-hover ${s.id === value ? 'bg-tt-card-hover' : ''}`}
                  >
                    <span className="min-w-0 truncate">
                      <span className="truncate"><span className="font-mono text-tt-cyan">#{s.sku_number}</span> {s.title || 'Untitled'}</span>
                      {/* Why this SKU is suggested — reminds the host of the neighbouring lot. */}
                      {reason ? <span className="block text-[10px] text-tt-muted truncate">{reason}</span> : null}
                    </span>
                    <span className="shrink-0 text-tt-muted">{s.category ? `${s.category} · ` : ''}{s.qty_on_hand}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// The order ID is the ground-truth bridge to TikTok Seller Center's order search. We surface a
// copy button so an operator can paste it there directly. (The generic "Seller Center" link was
// removed — it only opened the orders list, which wasn't worth the width; copy is the useful part.)
function OrderIdWithCopy({ orderId }: { orderId: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="font-mono text-tt-text">{orderId}</span>
      <button
        onClick={async () => {
          try { await navigator.clipboard.writeText(orderId); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard blocked */ }
        }}
        className="text-tt-cyan hover:underline cursor-pointer"
        title="Copy the order ID to paste into Seller Center's order search"
      >{copied ? 'copied!' : 'copy'}</button>
    </span>
  );
}

export default function ShowsTab() {
  const { data: sessions = [], isLoading } = useLiveSessions();
  const { user } = useUser();
  const { data: storesData } = useStores();
  const isAdmin = user?.app_metadata?.role === 'admin';
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Respect the active-store filter (previously only metrics did; the Shows list showed
  // all). Unmapped sessions (store_id null) ALWAYS show, under every filter — an
  // unattributed stream must never hide behind a store selection (Part D flag).
  const activeStore = storesData?.activeStore ?? 'all';
  const visibleSessions = useMemo(
    () => sessions.filter((s) => activeStore === 'all' || s.store_id === activeStore || !s.store_id),
    [sessions, activeStore],
  );

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
      ) : visibleSessions.length === 0 ? (
        <div className="rounded-2xl border border-tt-border bg-tt-card py-16 text-center">
          <div className="text-tt-text font-medium">No shows yet</div>
          <p className="text-sm text-tt-muted mt-2 max-w-sm mx-auto">
            When you run a live auction, each session and the sales captured in it will appear here.
          </p>
        </div>
      ) : (
        <>
          {/* Desktop table (md+) — unchanged layout, scrolls horizontally on tablet if needed. */}
          <div className="hidden md:block rounded-2xl border border-tt-border bg-tt-card overflow-x-auto">
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
                {visibleSessions.map((s) => (
                  <ShowRow key={s.id} session={s} onOpen={setSelectedId} />
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile card list (<md) — same sessions, same open handler. */}
          <div className="md:hidden space-y-3">
            {visibleSessions.map((s) => (
              <ShowCardMobile key={s.id} session={s} onOpen={setSelectedId} />
            ))}
          </div>
        </>
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
        className="inline-flex min-h-[44px] w-full shrink-0 items-center justify-center rounded-lg bg-gradient-to-r from-tt-cyan to-[#4db8c0] px-5 text-sm font-semibold text-black transition-opacity hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-tt-cyan/50 sm:min-h-[40px] sm:w-auto"
      >
        Open Practice Mode
      </Link>
    </div>
  );
}

// One list row; fetches its own board (cached, reused by the detail view) to
// compute the show's summary totals.
function ShowRow({ session, onOpen }: { session: LiveSession; onOpen: (id: string) => void }) {
  const { data: boardData, isLoading } = useAuctionBoard(session.id);
  const items = boardData?.items ?? [];
  const sum = useMemo(() => summarize(items), [items]);

  return (
    <tr
      onClick={() => onOpen(session.id)}
      className="border-b border-tt-border last:border-0 cursor-pointer hover:bg-tt-card-hover transition-colors"
    >
      <td className="px-4 py-3">
        {/* Channel handle IS the identity now (large). Falls back to "TikTok Live" when the
            channel hasn't been attributed yet, so the row is never blank. */}
        <div className="font-medium text-tt-text">
          {session.channel_handle || 'TikTok Live'}
        </div>
        {/* host · store · date. Host omitted when none selected; store shows red "Unmapped
            store" when null (the Part-D flag, now inline); date always present. */}
        <div className="text-xs text-tt-muted mt-0.5">
          {[
            session.host_name ? <span key="h" className="text-tt-text/70">{session.host_name}</span> : null,
            session.store_name
              ? <span key="s" className="text-tt-text/70">{session.store_name}</span>
              : <span key="s" className="font-semibold text-tt-red">Unmapped store</span>,
            <span key="d">{fmtDate(session.started_at)}</span>,
          ].filter(Boolean).flatMap((node, i) => (i === 0 ? [node] : [<span key={`sep${i}`}> · </span>, node]))}
        </div>
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

// Mobile counterpart of ShowRow — same board hook, same summary, same open
// handler, rendered as a stacked card (shown only <md via the parent wrapper).
function ShowCardMobile({ session, onOpen }: { session: LiveSession; onOpen: (id: string) => void }) {
  const { data: boardData, isLoading } = useAuctionBoard(session.id);
  const items = boardData?.items ?? [];
  const sum = useMemo(() => summarize(items), [items]);

  // host · store · date — identical wording/tone to the desktop row.
  const subtitle = [
    session.host_name ? <span key="h" className="text-tt-text/70">{session.host_name}</span> : null,
    session.store_name
      ? <span key="s" className="text-tt-text/70">{session.store_name}</span>
      : <span key="s" className="font-semibold text-tt-red">Unmapped store</span>,
    <span key="d">{fmtDate(session.started_at)}</span>,
  ].filter(Boolean).flatMap((node, i) => (i === 0 ? [node] : [<span key={`sep${i}`}> · </span>, node]));

  return (
    <MobileDataCard
      onClick={() => onOpen(session.id)}
      title={session.channel_handle || 'TikTok Live'}
      subtitle={subtitle}
      badge={<StatusBadge status={session.status} />}
      stats={[
        { label: 'Auctions won', value: isLoading ? '…' : sum.itemsSold },
        { label: 'Units sold', value: isLoading ? '…' : sum.unitsSold },
        { label: 'Sale value', value: isLoading ? '…' : money(sum.saleCents) },
        { label: 'Cost', value: isLoading ? '…' : money(sum.costCents) },
        {
          label: 'Gross profit',
          wide: true,
          value: (
            <span className={isLoading ? '' : profitClass(sum.profitCents)}>
              {isLoading ? '…' : money(sum.profitCents)}
            </span>
          ),
        },
      ]}
    />
  );
}

function ShowDetail({ session, onBack }: { session: LiveSession; onBack: () => void }) {
  const { data: boardData, isLoading } = useAuctionBoard(session.id);
  const items = useMemo(() => boardData?.items ?? [], [boardData]);
  const sessionSkus = useMemo(() => boardData?.session_skus ?? [], [boardData]);
  const sum = useMemo(() => summarize(items), [items]);
  const rates = useMemo(() => showRates(items), [items]);
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
  // ── Bind-from-table (the primary surface): captured-but-unbound rows are unioned into the
  //    board `items` (unbound=true). Expand one to bind it; unbind a bound row to correct it.
  const unbind = useUnbind(session.id);
  const [expandedOrder, setExpandedOrder] = useState<string | null>(null);
  const [unbindConfirm, setUnbindConfirm] = useState<{ order_id: string; label: string } | null>(null);
  const [unbindingId, setUnbindingId] = useState<string | null>(null);
  // Bound THIS session → drives the "N unbound · M remaining" progress (total = remaining + bound).
  const [boundThisSession, setBoundThisSession] = useState(0);
  // Discoverability: on a 100+ row show, unbound rows are unfindable interleaved. This filters
  // the table to just the actionable (unbound) rows. Toggled from the progress banner.
  const [onlyUnbound, setOnlyUnbound] = useState(false);
  // Lot-based show = an auction with numeric TikTok lot numbers (catalog stores have none). Gates
  // the lot column + lot ordering so they simply don't appear where lots are meaningless.
  const lotBased = useMemo(() => items.some((i) => lotOf(i) != null), [items]);
  const displayItems = useMemo(() => {
    const base = onlyUnbound ? items.filter((i) => i.unbound) : items;
    if (!lotBased) return base;
    // Replay the show in lot order (bound + unbound interleaved). Rows without a lot sink last.
    return [...base].sort((a, b) => {
      const la = lotOf(a), lb = lotOf(b);
      if (la == null && lb == null) return 0;
      if (la == null) return 1;
      if (lb == null) return -1;
      return la - lb;
    });
  }, [onlyUnbound, items, lotBased]);
  // PRIMARY narrowing set: SKUs sold in this show (from the board) — the picker's default list.
  const primaryIdSet = useMemo(() => new Set(sessionSkus.map((s) => s.id)), [sessionSkus]);

  // A board unbound row → the UnboundOrder shape the existing bind path expects (reuse, not rebuild).
  const asUnbound = (it: AuctionItem): UnboundOrder => ({
    order_id: it.order_id ?? '', buyer: it.buyer_handle ?? '',
    won_price_cents: it.won_price_cents, seller_sku: it.seller_sku_hint ?? '',
    quantity: 1, status: 'sold',
  });
  // Expand/collapse a table row's bind editor; seed one EMPTY line. We deliberately do NOT
  // pre-pick from the lot number — the lot is a per-show sequence, not the inventory sku_number
  // (matching sku_number to it was wrong 99.5% of the time). The picker ranks the likely SKUs by
  // lot adjacency instead, so the host confirms rather than inherits a bad guess.
  function toggleExpand(it: AuctionItem) {
    const oid = it.order_id ?? '';
    console.log('[edit-debug] toggleExpand', { oid, unbound: it.unbound, skusLen: it.skus?.length, alreadyOpen: expandedOrder === oid, existingLines: lines[oid] }); // TEMP DEBUG
    if (!oid) return;
    if (expandedOrder === oid) { setExpandedOrder(null); return; }
    // Seed the editor: a BOUND row opens pre-populated with its current SKUs/qtys (edit =
    // unbind→rebind under the hood); an UNBOUND row opens with one blank line (fresh bind).
    if (!lines[oid]) {
      const seed = (!it.unbound && it.skus.length > 0)
        ? it.skus.map((s) => ({ sku_id: String(s.inventory_sku_id), qty: Math.max(1, s.qty || 1) }))
        : [{ sku_id: '', qty: 1 }];
      setLinesFor(oid, seed);
    }
    setExpandedOrder(oid);
  }
  async function doUnbind(orderId: string) {
    setUnbindingId(orderId);
    try {
      const r = await unbind.mutateAsync(orderId);
      setBindNotice({ type: 'success', msg: `Unbound order ${orderId} — restocked ${r.restocked_units} unit${r.restocked_units === 1 ? '' : 's'}.` });
    } catch (e) {
      setBindNotice({ type: 'error', msg: `Unbind failed for order ${orderId}: ${e instanceof Error ? e.message : 'error'}` });
    } finally {
      setUnbindingId(null);
      setUnbindConfirm(null);
    }
  }

  // Collapse lines by SKU (sum qty), sorted — for the "did anything change?" no-op check.
  function collapseLines(arr: { sku_id: string; qty: number }[]) {
    const m = new Map<string, number>();
    for (const l of arr) if (l.sku_id) m.set(l.sku_id, (m.get(l.sku_id) ?? 0) + Math.max(1, l.qty || 1));
    return [...m.entries()].map(([sku_id, qty]) => ({ sku_id, qty })).sort((a, b) => a.sku_id.localeCompare(b.sku_id));
  }

  // Edit a BOUND row's SKUs. No partial-edit RPC exists, so this is unbind→rebind under one
  // action, which keeps FIFO exact (unbind restocks every current line; rebind draws the new
  // set). Guards: (3) unchanged → no-op; (4) zero lines → full unbind; (2) a rebind failure
  // leaves the row UNBOUND and says so — never a silent half-state.
  async function saveEdit(it: AuctionItem, editedLines: { sku_id: string; qty: number }[]) {
    const oid = it.order_id ?? '';
    console.log('[edit-debug] saveEdit CALLED', { oid, editedLines, itSkus: it.skus, linesState: lines[oid] }); // TEMP DEBUG
    if (!oid) return;
    const dropLines = (o: string) => setLines((l) => { const n = { ...l }; delete n[o]; return n; });
    setBindNotice(null);
    setBindingId(oid);
    try {
      // Use the lines passed straight from the OPEN editor's own render — never a stale closure of
      // `lines` (the #126 silent-no-op: the async guard could read pre-edit lines and wrongly
      // conclude "unchanged"). Compute inside try so ANY error surfaces instead of a dead click.
      const next = collapseLines(editedLines ?? []);
      const current = collapseLines((it.skus ?? []).map((s) => ({ sku_id: String(s.inventory_sku_id), qty: s.qty })));
      const unchanged = next.length === current.length && next.every((n, i) => n.sku_id === current[i].sku_id && n.qty === current[i].qty);
      console.log('[edit-debug] saveEdit compare', { next, current, unchanged }); // TEMP DEBUG
      if (unchanged) { // (3) no-op — but SAY so; never silently close
        setExpandedOrder(null);
        setBindNotice({ type: 'error', msg: `No changes to save for order ${oid} — the lines already match the current bind.` });
        return;
      }
      console.log('[edit-debug] calling unbind', { oid }); // TEMP DEBUG
      const unbindRes = await unbind.mutateAsync(oid); // restock ALL current lines first
      console.log('[edit-debug] unbind returned', unbindRes); // TEMP DEBUG
      if (next.length === 0) {
        // (4) zero lines = full unbind, not a rebind-with-nothing.
        qc.invalidateQueries({ queryKey: ['auction-board', session.id] });
        qc.invalidateQueries({ queryKey: ['inventory-skus'] });
        dropLines(oid); setExpandedOrder(null);
        setBindNotice({ type: 'success', msg: `Order ${oid} unbound — all SKUs restocked; row returned to unbound.` });
        return;
      }
      console.log('[edit-debug] calling rebind', { oid, lines: next }); // TEMP DEBUG
      const res = await fetch(`/api/live/sessions/${session.id}/bind`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order_id: oid, lines: next, allow_negative: false }),
      });
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      console.log('[edit-debug] rebind returned', { status: res.status, ok: res.ok, json }); // TEMP DEBUG
      qc.invalidateQueries({ queryKey: ['auction-board', session.id] });
      qc.invalidateQueries({ queryKey: ['inventory-skus'] });
      setExpandedOrder(null);
      if (res.ok) {
        const label = next.map((n) => { const s = allSkus.find((x) => x.id === n.sku_id); return s ? `#${s.sku_number}` : ''; }).filter(Boolean).join(', ');
        dropLines(oid); // clear so a reopen re-seeds from the fresh bind
        setBindNotice({ type: 'success', msg: `Order ${oid} updated — re-bound to ${label}.` });
      } else {
        // (2) half-state made explicit. Row is now UNBOUND; keep `lines` so the retry is pre-filled.
        setBindNotice({ type: 'error', msg: `Order ${oid} is now UNBOUND — rebind failed (${json.error || 'error'}). Retry the bind on the unbound row (your SKUs are still filled in).` });
      }
    } catch (e) {
      console.log('[edit-debug] saveEdit CAUGHT', e); // TEMP DEBUG
      qc.invalidateQueries({ queryKey: ['auction-board', session.id] });
      setExpandedOrder(null);
      setBindNotice({ type: 'error', msg: `Edit failed for order ${oid}: ${e instanceof Error ? e.message : 'error'} — check the row and retry.` });
    } finally {
      setBindingId(null);
    }
  }

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
    setLines((l) => {
      const before = l[orderId] ?? [];
      const after = before.filter((_, i) => i !== idx);
      console.log('[edit-debug] removeLine', { orderId, idx, before, after }); // TEMP DEBUG
      return { ...l, [orderId]: after };
    });
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
    console.log('[edit-debug] bindOne CALLED (unbound/bind path — NOT the edit path)', { order_id: u.order_id }); // TEMP DEBUG
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
      const json = (await res.json().catch(() => ({}))) as { error?: string; already_bound?: boolean };
      if (res.ok) {
        setRecon((r) => (r ? { ...r, unbound: r.unbound.filter((x) => x.order_id !== u.order_id) } : r));
        qc.invalidateQueries({ queryKey: ['auction-board', session.id] });
        qc.invalidateQueries({ queryKey: ['inventory-skus'] });
        if (!json.already_bound) setBoundThisSession((n) => n + 1); // progress: one fewer remaining
        setExpandedOrder(null); // collapse the table editor on success
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
      <div className="flex flex-col gap-4 mb-5 md:flex-row md:items-start md:justify-between">
        <div>
          <button
            onClick={onBack}
            className="inline-flex min-h-[44px] items-center text-xs text-tt-cyan cursor-pointer hover:underline mb-2 md:min-h-0"
          >
            ← All shows
          </button>
          {/* Channel handle is the identity (large); "TikTok Live" fallback when unattributed. */}
          <div className="text-xl font-bold">{session.channel_handle || 'TikTok Live'}</div>
          <div className="text-sm text-tt-muted mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
            {/* host · store · date. Host omitted when none; store → red "Unmapped store" when null. */}
            <span className="text-tt-text/70">
              {[
                session.host_name ? <span key="h">{session.host_name}</span> : null,
                session.store_name
                  ? <span key="s">{session.store_name}</span>
                  : <span key="s" className="font-semibold text-tt-red">Unmapped store</span>,
                <span key="d">{fmtDate(session.started_at)}</span>,
              ].filter(Boolean).flatMap((node, i) => (i === 0 ? [node] : [<span key={`sep${i}`}> · </span>, node]))}
            </span>
            <StatusBadge status={session.status} />
            {durationLabel && (
              <span title={`Active selling time (source: ${duration?.source === 'ended_at' ? 'session end' : 'last sale'})`}>
                Duration {durationLabel}
              </span>
            )}
          </div>
        </div>
        <div className="shrink-0 flex flex-wrap items-center gap-2">
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

      {/* Order coverage check — synced-but-never-captured. Deliberately styled
          amber (not the reconcile red/green) so the two are never confused. */}
      <CoveragePanel sessionId={session.id} />

      {/* Non-fatal board degrade (e.g. an enrichment join failed). The rows + sale value
          are real; cost/units may be incomplete. Shown so a degraded load is never mistaken
          for a genuine no-sales show. */}
      {boardData?.warning && (
        <div className="mb-5 rounded-lg border border-tt-yellow/40 bg-tt-yellow/10 px-4 py-2.5 text-sm text-tt-yellow" role="alert">
          {boardData.warning}
        </div>
      )}

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
                      <div className="flex flex-wrap items-center gap-x-2"><OrderIdWithCopy orderId={u.order_id} /> <span className="text-tt-text">@{u.buyer || '—'}</span></div>
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
        {/* Per-show performance rates over SOLD auctions only (payment-failed/unsold
            excluded). "—" when the show has no sold auctions (never "0%"). */}
        <SummaryCard
          label="ASP Hit Rate"
          value={isLoading ? '…' : rates.aspHitPct == null ? '—' : `${Math.round(rates.aspHitPct)}%`}
          valueClass={isLoading ? '' : aspHitClass(rates.aspHitPct)}
          sub={rates.soldCount > 0 ? `of ${rates.soldCount} sold` : undefined}
        />
        <SummaryCard
          label="Below Break-even"
          value={isLoading ? '…' : rates.belowBePct == null ? '—' : `${Math.round(rates.belowBePct)}%`}
          valueClass={isLoading ? '' : belowBeClass(rates.belowBePct)}
          sub={rates.soldCount > 0 ? `of ${rates.soldCount} sold` : undefined}
        />
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

      {/* PAID — needs flip: not_sold rows TikTok confirms as paid (real revenue sitting
          mislabeled). Surfaced as a count so it's visible without scanning the table. */}
      {(() => {
        const needsFlip = items.filter((it) => it.status === 'not_sold' && paidNeedsFlip(it.synced_status)).length;
        return needsFlip > 0 ? (
          <div className="mb-4 rounded-lg border border-tt-green/40 bg-tt-green/10 px-4 py-2.5 text-sm text-tt-green">
            <span className="font-semibold">{needsFlip}</span> paid order{needsFlip === 1 ? '' : 's'} still marked
            not sold (PAID — needs flip) — real revenue not yet counted.
          </div>
        ) : null;
      })()}

      {/* Bind progress + discoverability filter — captured-but-unbound rows are actionable inline. */}
      {(() => {
        const remaining = items.filter((i) => i.unbound).length;
        const total = remaining + boundThisSession;
        if (total === 0) return null;
        return (
          <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
            <span className="inline-flex items-center rounded-md bg-tt-yellow/15 px-2 py-0.5 text-xs font-semibold text-tt-yellow ring-1 ring-tt-yellow/30">
              {total} unbound · {remaining} remaining
            </span>
            {remaining > 0 && (
              <button
                onClick={() => setOnlyUnbound((v) => !v)}
                className={`text-xs rounded-md px-2 py-0.5 cursor-pointer transition-colors ${onlyUnbound ? 'bg-tt-cyan text-black font-semibold' : 'border border-tt-border text-tt-cyan hover:bg-tt-card-hover'}`}
              >{onlyUnbound ? 'Showing only unbound — show all' : `Show only unbound (${remaining})`}</button>
            )}
            <span className="text-xs text-tt-muted">Click a “Unbound — bind” row to attach its SKU(s).</span>
          </div>
        );
      })()}

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
      ) : displayItems.length === 0 ? (
        <div className="rounded-2xl border border-tt-border bg-tt-card py-12 text-center text-tt-muted text-sm">
          No unbound rows remaining.{' '}
          <button onClick={() => setOnlyUnbound(false)} className="text-tt-cyan cursor-pointer hover:underline">Show all rows</button>
        </div>
      ) : (
        <div className="hidden md:block rounded-2xl border border-tt-border bg-tt-card overflow-x-auto">
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
              {displayItems.map((it) => {
                const isUnbound = !!it.unbound;
                const sold = it.status === 'sold';
                const won = wonCents(it); // real winning bid (sold items only)
                const cost = it.total_cost_cents;
                // Bound sold rows carry an order_id + SKU lines → they can be unbound/corrected.
                const canUnbind = sold && !isUnbound && !!it.order_id && it.skus.length > 0;
                let profit: number | null = null;
                if (sold && cost != null) {
                  if (it.net_payout_cents != null) profit = it.net_payout_cents - cost;
                  else if (won != null) profit = won - cost;
                }
                // Editor opens for unbound rows (fresh bind) AND bound-editable rows (edit).
                const expanded = expandedOrder === it.order_id && (isUnbound || canUnbind);
                const isEditing = expanded && !isUnbound; // bound row → unbind→rebind on save
                const orderLines = it.order_id ? (lines[it.order_id] ?? []) : [];
                // Neighbour hints only matter for the expanded bind editor — compute lazily.
                // Rank by lot adjacency; fall back to time proximity when the row has no numeric
                // lot or there are no bound lots to borrow from.
                const nb = expanded ? lotNeighbours(it, items) : null;
                const nearby = nb
                  ? (nb.rankedSkuIds.length ? nb.rankedSkuIds : nearbySkuIdsForTime(it.logged_at, items))
                  : [];
                // SKUs sharing a category with the neighbour lots (picker's category tier).
                const categoryIds = new Set<string>();
                if (nb && nb.rankedSkuIds.length) {
                  const cats = new Set(
                    nb.rankedSkuIds.map((id) => allSkus.find((s) => s.id === id)?.category).filter((c): c is string => !!c),
                  );
                  if (cats.size) for (const s of allSkus) if (s.category && cats.has(s.category)) categoryIds.add(s.id);
                }
                // Lot number for the # column (both bound and unbound in lot-based shows); falls
                // back to the internal sequence for bound rows, or — for unbound rows without one.
                const lot = lotOf(it);
                const numCell = lotBased ? (lot ?? (isUnbound ? '—' : it.auction_number)) : (isUnbound ? '—' : it.auction_number);
                const pickedCount = orderLines.filter((x) => x.sku_id).length;
                return (
                  <Fragment key={it.id}>
                  <tr className={`border-b border-tt-border last:border-0 ${isUnbound ? 'bg-tt-yellow/[0.04]' : ''}`}>
                    <td className="px-4 py-3 text-tt-muted tabular-nums">{numCell}</td>
                    <td className="px-4 py-3">
                      <div className="flex flex-col gap-0.5">
                        {it.tiktok_title ? (
                          <span className="min-w-0 truncate text-tt-text">{it.tiktok_title}</span>
                        ) : null}
                        {isUnbound ? (
                          <>
                            <span className="text-xs text-tt-yellow">Captured · no SKU bound</span>
                            {/* Order ID for lookup (lot # in the # column is for sequence), with a
                                copy button — no view-switch to look one up. Kept text-xs so the
                                already-wide table doesn't wrap on the pack screen. */}
                            {it.order_id ? (
                              <span className="text-xs"><OrderIdWithCopy orderId={it.order_id} /></span>
                            ) : null}
                          </>
                        ) : it.skus.length === 0 ? (
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
                        {canUnbind && (
                          // Two intents, kept distinct: "Edit SKUs" opens the pre-populated editor
                          // (unbind→rebind on save); "Unbind" is the standalone full-unbind confirm.
                          <div className="mt-0.5 flex items-center gap-2 text-[11px]">
                            <button
                              onClick={() => toggleExpand(it)}
                              className="self-start text-tt-cyan hover:underline cursor-pointer"
                            >{expanded ? 'Close editor' : 'Edit SKUs'}</button>
                            <span className="text-tt-border">·</span>
                            <button
                              onClick={() => setUnbindConfirm({ order_id: it.order_id!, label: it.skus.map((s) => `#${s.sku_number}`).join(', ') })}
                              disabled={unbindingId === it.order_id}
                              className="self-start text-tt-muted hover:text-tt-red cursor-pointer disabled:opacity-50"
                            >{unbindingId === it.order_id ? 'Unbinding…' : 'Unbind'}</button>
                          </div>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">{isUnbound ? '—' : it.units}</td>
                    <td className="px-4 py-3 text-center">
                      {isUnbound ? (
                        <button
                          onClick={() => toggleExpand(it)}
                          className="text-xs font-semibold rounded-md bg-tt-yellow/20 text-tt-yellow ring-1 ring-tt-yellow/40 px-2 py-0.5 cursor-pointer hover:bg-tt-yellow/30"
                        >{expanded ? 'Close' : 'Unbound — bind'}</button>
                      ) : sold ? (
                        <span className="text-xs font-medium text-tt-green">Sold</span>
                      ) : (
                        (() => {
                          // not_sold → show the truthful payment state (synced status first,
                          // frozen order_status snapshot as fallback).
                          const b = notSoldBadge(it.synced_status, it.order_status, it.payment_failed);
                          return <span className={`text-xs font-medium ${b.cls}`}>{b.label}</span>;
                        })()
                      )}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-tt-muted">{money(aspGoalCents(it.total_cost_cents))}</td>
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
                  {expanded && it.order_id && (
                    <tr className="bg-tt-card/60">
                      <td colSpan={9} className="px-4 py-4">
                        {/* Inline context: sale time, price, buyer, order id, lot number. */}
                        <div className="text-xs text-tt-muted mb-2 flex flex-wrap gap-x-4 gap-y-1">
                          <span>Sale time: <span className="text-tt-text">{fmtDate(it.logged_at || null)}</span></span>
                          <span>Price: <span className="text-tt-text">{money(it.won_price_cents)}</span></span>
                          <span>Buyer: <span className="text-tt-text">@{it.buyer_handle || '—'}</span></span>
                          <span>Order: <OrderIdWithCopy orderId={it.order_id} /></span>
                          {lot != null ? <span>Lot: <span className="font-mono text-tt-text">{lot}</span></span> : null}
                        </div>
                        {/* Flanking bound lots — the strongest hint. Nearest bound lot each side (not
                            strictly ±1: consecutive lots are often both unbound). Degrade honestly. */}
                        <div className="text-[11px] text-tt-muted mb-3">
                          {nb && (nb.below || nb.above) ? (
                            <>Adjacent bound lots:{' '}
                              {nb.below ? <span>lot {nb.below.lot} was <span className="text-tt-text">#{nb.below.sku_number} {nb.below.title}</span></span> : null}
                              {nb.below && nb.above ? <span> · </span> : null}
                              {nb.above ? <span>lot {nb.above.lot} was <span className="text-tt-text">#{nb.above.sku_number} {nb.above.title}</span></span> : null}
                            </>
                          ) : nearby.length > 0 ? (
                            <>Nearest bound sales by time: {nearby.slice(0, 5).map((id) => { const s = allSkus.find((x) => x.id === id); return s ? `#${s.sku_number}` : null; }).filter(Boolean).join(', ')}</>
                          ) : (
                            <span className="italic">No context available — no bound sales in this show to compare.</span>
                          )}
                        </div>
                        {/* Multi-SKU lines: each its own qty, a ranked+scannable picker, one confirm. */}
                        <div className="space-y-2">
                          {orderLines.map((ln, idx) => (
                            <div key={idx} className="flex flex-wrap items-start gap-2">
                              <RankedSkuPicker
                                value={ln.sku_id}
                                onChange={(sid) => updateLine(it.order_id!, idx, { sku_id: sid })}
                                allSkus={allSkus}
                                primaryIds={primaryIdSet}
                                nearbyIds={nearby}
                                reasonById={nb?.reasonById}
                                categoryIds={categoryIds}
                              />
                              <input
                                type="number" min={1} value={ln.qty}
                                onChange={(e) => updateLine(it.order_id!, idx, { qty: Math.max(1, Math.trunc(Number(e.target.value) || 1)) })}
                                className="w-16 rounded-md border border-tt-border bg-tt-input-bg px-2 py-1 text-xs text-tt-text outline-none tabular-nums" aria-label="Quantity"
                              />
                              <button
                                onClick={() => { setQuickAdd({ orderId: it.order_id!, idx }); setQaName(''); setQaCost(''); setQaError(null); }}
                                className="text-xs text-tt-cyan cursor-pointer hover:underline px-1" title="Create a new inventory SKU"
                              >+ New SKU</button>
                              {orderLines.length > 1 && (
                                <button onClick={() => removeLine(it.order_id!, idx)} className="text-tt-muted hover:text-tt-red text-xs px-1" aria-label="Remove line">✕</button>
                              )}
                              {quickAdd?.orderId === it.order_id && quickAdd?.idx === idx && (
                                <div className="mt-1 flex flex-wrap items-center gap-2 rounded-lg border border-tt-border bg-tt-input-bg/40 p-2 w-full">
                                  <input autoFocus placeholder="New SKU name" value={qaName} onChange={(e) => setQaName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') submitQuickAdd(); if (e.key === 'Escape') setQuickAdd(null); }} className="flex-1 min-w-[10rem] rounded-lg border border-tt-border bg-tt-input-bg px-2 py-1 text-xs text-tt-text outline-none" />
                                  <input placeholder="Cost $" inputMode="decimal" value={qaCost} onChange={(e) => setQaCost(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') submitQuickAdd(); if (e.key === 'Escape') setQuickAdd(null); }} className="w-24 rounded-lg border border-tt-border bg-tt-input-bg px-2 py-1 text-xs text-tt-text outline-none tabular-nums" />
                                  <button onClick={submitQuickAdd} disabled={qaSaving || !qaName.trim()} className="px-2.5 py-1 rounded-lg bg-tt-cyan text-black text-xs font-semibold cursor-pointer hover:opacity-90 disabled:opacity-40">{qaSaving ? 'Creating…' : 'Create & select'}</button>
                                  <button onClick={() => setQuickAdd(null)} className="text-tt-muted hover:text-tt-text text-xs px-1">Cancel</button>
                                  {qaError && <span className="text-tt-red text-xs w-full">{qaError}</span>}
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                        <div className="mt-3 flex items-center gap-3">
                          <button onClick={() => addLine(it.order_id!)} className="text-xs text-tt-cyan cursor-pointer hover:underline">+ add SKU line</button>
                          {isEditing ? (
                            // Edit: save via unbind→rebind. Enabled even at 0 lines (0 = remove bind).
                            <button
                              onClick={() => saveEdit(it, orderLines)}
                              disabled={bindingId === it.order_id}
                              className="px-3 py-1.5 rounded-lg bg-tt-cyan text-black text-xs font-semibold cursor-pointer hover:opacity-90 disabled:opacity-40"
                            >{bindingId === it.order_id ? 'Saving…' : (pickedCount === 0 ? 'Save (removes bind)' : `Save ${pickedCount} SKU${pickedCount === 1 ? '' : 's'}`)}</button>
                          ) : (
                            <button
                              onClick={() => bindOne(asUnbound(it))}
                              disabled={pickedCount === 0 || bindingId === it.order_id}
                              className="px-3 py-1.5 rounded-lg bg-tt-cyan text-black text-xs font-semibold cursor-pointer hover:opacity-90 disabled:opacity-40"
                            >{bindingId === it.order_id ? 'Binding…' : `Bind ${pickedCount} SKU${pickedCount === 1 ? '' : 's'}`}</button>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Mobile item cards (<md) — same items, same derived figures as the table. */}
      {!isLoading && items.length > 0 && (
        <div className="md:hidden space-y-3">
          {items.map((it) => {
            const sold = it.status === 'sold';
            const won = wonCents(it);
            const cost = it.total_cost_cents;
            let profit: number | null = null;
            if (sold && cost != null) {
              if (it.net_payout_cents != null) profit = it.net_payout_cents - cost;
              else if (won != null) profit = won - cost;
            }
            const resultBadge = sold ? (
              <span className="text-xs font-medium text-tt-green">Sold</span>
            ) : (
              (() => {
                const b = notSoldBadge(it.synced_status, it.order_status, it.payment_failed);
                return <span className={`text-xs font-medium ${b.cls}`}>{b.label}</span>;
              })()
            );
            return (
              <MobileDataCard
                key={it.id}
                thumbnail={
                  <span className="inline-flex h-8 min-w-8 items-center justify-center rounded-lg border border-tt-border px-2 text-xs font-mono text-tt-muted tabular-nums">
                    {lotBased ? (lotOf(it) ?? it.auction_number) : it.auction_number}
                  </span>
                }
                badge={resultBadge}
                title={
                  <div className="flex flex-col gap-0.5">
                    {it.tiktok_title ? (
                      <span className="text-tt-text break-words">{it.tiktok_title}</span>
                    ) : null}
                    {it.skus.length === 0 ? (
                      !it.tiktok_title ? <span className="text-tt-muted font-normal">—</span> : null
                    ) : (
                      it.skus.map((sk) => (
                        <span key={sk.inventory_sku_id} className="text-xs font-normal text-tt-muted break-words">
                          <span className="font-mono text-tt-cyan">#{sk.sku_number}</span>{' '}
                          <span>{sk.title || 'Untitled'}</span>
                          {sk.qty > 1 ? <span> ×{sk.qty}</span> : null}
                        </span>
                      ))
                    )}
                  </div>
                }
                stats={[
                  { label: 'Qty', value: it.units },
                  { label: 'ASP Goal', value: money(aspGoalCents(it.total_cost_cents)) },
                  { label: 'Won price', value: money(sold ? won : null) },
                  { label: 'Cost', value: money(cost) },
                  {
                    label: `Profit ${anyPayout ? '(net)' : '(won−cost)'}`,
                    value: (
                      <span className={profit == null ? 'text-tt-muted' : profitClass(profit)}>
                        {profit == null ? '—' : money(profit)}
                      </span>
                    ),
                  },
                  {
                    label: 'Actual payout',
                    value:
                      it.net_payout_cents == null ? (
                        <span className="text-tt-muted">—</span>
                      ) : (
                        <>
                          {money(it.net_payout_cents)}
                          {!it.payout_settled && (
                            <span className="ml-1 text-[10px] uppercase text-tt-muted">est</span>
                          )}
                        </>
                      ),
                  },
                ]}
              />
            );
          })}
        </div>
      )}

      {/* In-app (themed) out-of-stock bind confirm — replaces window.confirm.
          Same wording + behavior: Cancel aborts, "Bind anyway" sends allow_negative. */}
      {bindConfirm && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-4 sm:items-center"
          onClick={() => setBindConfirm(null)}
          role="dialog"
          aria-modal="true"
        >
          <div
            className="w-full max-w-md max-h-[90dvh] overflow-y-auto rounded-2xl border border-tt-border bg-tt-card p-5 shadow-xl"
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

      {/* Unbind / change-SKU confirm — reverses a bind (restocks + deletes the item). */}
      {unbindConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => setUnbindConfirm(null)} role="dialog" aria-modal="true">
          <div className="w-full max-w-md rounded-2xl border border-tt-border bg-tt-card p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="text-sm font-semibold text-tt-text mb-2">Unbind this sale?</div>
            <div className="text-sm text-tt-muted mb-4">
              Order <span className="font-mono text-tt-text">{unbindConfirm.order_id}</span> is bound to <span className="text-tt-text">{unbindConfirm.label || 'its SKU(s)'}</span>.
              Unbinding restocks the quantity (a fresh cost layer at the snapshot cost) and returns the row to unbound so you can re-bind a different SKU.
            </div>
            <div className="flex justify-end gap-2">
              <button onClick={() => setUnbindConfirm(null)} className="px-4 py-2 rounded-lg border border-tt-border text-sm font-medium text-tt-text cursor-pointer hover:bg-tt-card-hover transition-colors">Cancel</button>
              <button onClick={() => { void doUnbind(unbindConfirm.order_id); }} disabled={unbindingId === unbindConfirm.order_id} className="px-4 py-2 rounded-lg bg-tt-red text-white text-sm font-semibold cursor-pointer hover:opacity-90 disabled:opacity-40">
                {unbindingId === unbindConfirm.order_id ? 'Unbinding…' : 'Unbind'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Post-live ORDER COVERAGE CHECK (read-only, list only). Auto-runs on open via
// useShowCoverage; also refreshed when a show is ended (useEndSession prefetch).
// Shows the count reconcile is structurally blind to: synced orders that were
// never captured (and so never bound). Distinct from captured-but-unbound, which
// reconcile handles — the two are shown as separate figures, never merged.
function CoveragePanel({ sessionId }: { sessionId: string }) {
  const { data, isLoading, isError } = useShowCoverage(sessionId);
  const [showCatalog, setShowCatalog] = useState(false);

  if (isLoading) {
    return (
      <div className="mb-5 rounded-xl border border-tt-border bg-tt-card px-4 py-3 text-sm text-tt-muted">
        Checking order coverage…
      </div>
    );
  }
  if (isError || !data) {
    return (
      <div className="mb-5 rounded-xl border border-tt-border bg-tt-card px-4 py-3 text-sm text-tt-muted">
        Order coverage check unavailable.
      </div>
    );
  }

  const missed = data.missed_capture_count;
  const catalog = data.catalog_count;
  const hasMissed = missed > 0;

  return (
    <div
      className={`mb-5 rounded-xl border px-4 py-3 ${
        hasMissed ? 'border-amber-400/40 bg-amber-400/10' : 'border-tt-border bg-tt-card'
      }`}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className={`text-xs font-semibold uppercase tracking-wide ${hasMissed ? 'text-amber-300' : 'text-tt-muted'}`}>
          Order coverage
        </span>
        <span className={`text-sm ${hasMissed ? 'text-amber-200' : 'text-tt-text'}`}>
          {data.total_synced} synced order{data.total_synced === 1 ? '' : 's'} ·{' '}
          {data.captured_but_unbound_count} captured but unbound ·{' '}
          {/* PRIMARY signal: genuinely-missed AUCTION captures only. */}
          <span className={hasMissed ? 'font-semibold text-amber-300' : 'text-tt-text'}>
            {missed} missed auction capture{missed === 1 ? '' : 's'}
          </span>
          {/* SECONDARY, de-emphasised but visible. */}
          {catalog > 0 && (
            <span className="text-tt-muted"> · {catalog} catalog sale{catalog === 1 ? '' : 's'} (pre-listed, not auctions)</span>
          )}
          {data.room_unknown_count > 0 && (
            <> · <span className="font-semibold text-tt-red">{data.room_unknown_count} room unknown</span></>
          )}
        </span>
      </div>

      {data.room_unknown_count > 0 && (
        <div className="mt-3 rounded-lg border border-tt-red/30 bg-tt-red/5 px-3 py-2">
          <div className="text-xs font-semibold text-tt-red mb-0.5">
            {data.room_unknown_count} captured, room unknown — cannot attribute to a show
          </div>
          <div className="text-[11px] text-tt-muted">
            These sales were captured under a live room that matches no tracked session (or none at all),
            so they can’t be attributed to a host and don’t appear on any show’s bind table. Surfaced here
            for visibility — resolve by tracking the missing session or binding from the correct show.
          </div>
        </div>
      )}

      {/* PRIMARY: genuinely-missed auction captures (the real capture-health signal). */}
      {hasMissed && (
        <div className="mt-3">
          <div className="text-xs text-amber-200/80 mb-2">
            <span className="font-semibold">{missed}</span> auction sale{missed === 1 ? '' : 's'} synced but {missed === 1 ? 'was' : 'were'} never captured during the live — genuinely missing from the auction log (their seller SKU is a real inventory SKU number). Catalog/pre-listed sales are counted separately below.
          </div>
          <div className="overflow-x-auto rounded-lg border border-amber-400/20">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-amber-400/20 text-amber-200/70 text-xs uppercase tracking-wide">
                  <th className="text-left font-medium px-3 py-2">Order ID</th>
                  <th className="text-left font-medium px-3 py-2">Date</th>
                  <th className="text-left font-medium px-3 py-2">Seller SKU</th>
                  <th className="text-right font-medium px-3 py-2">GMV</th>
                  <th className="text-left font-medium px-3 py-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {data.missed_capture.map((o) => (
                  <tr key={o.order_id} className="border-b border-amber-400/10 last:border-0">
                    <td className="px-3 py-2 font-mono text-xs text-tt-text">{o.order_id}</td>
                    <td className="px-3 py-2 text-tt-text/80">{o.order_date ?? '—'}</td>
                    <td className="px-3 py-2 font-mono text-tt-cyan">#{o.sku_name}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-tt-text/80">{o.gmv == null ? '—' : `$${o.gmv.toFixed(2)}`}</td>
                    <td className="px-3 py-2 text-tt-muted">{o.status ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* SECONDARY: catalog sales — de-emphasised, collapsed by default, but the count + list stay available. */}
      {catalog > 0 && (
        <div className="mt-3 rounded-lg border border-tt-border bg-tt-card/40 px-3 py-2">
          <button onClick={() => setShowCatalog((v) => !v)} className="flex w-full items-start justify-between gap-2 text-left cursor-pointer">
            <span className="text-xs text-tt-muted">
              <span className="font-semibold text-tt-text/80">{catalog}</span> catalog sale{catalog === 1 ? '' : 's'} in this window — pre-listed items (mouth tape, nasal strips…) sold via normal listings, <span className="text-tt-text/70">not auctions</span> and not pick/packed. Not a capture problem.
            </span>
            <span className="text-xs text-tt-cyan shrink-0">{showCatalog ? 'Hide' : 'Show'}</span>
          </button>
          {showCatalog && (
            <div className="mt-2 overflow-x-auto rounded-lg border border-tt-border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-tt-border text-tt-muted text-xs uppercase tracking-wide">
                    <th className="text-left font-medium px-3 py-2">Order ID</th>
                    <th className="text-left font-medium px-3 py-2">Date</th>
                    <th className="text-left font-medium px-3 py-2">Variant</th>
                    <th className="text-right font-medium px-3 py-2">GMV</th>
                    <th className="text-left font-medium px-3 py-2">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {data.catalog.map((o) => (
                    <tr key={o.order_id} className="border-b border-tt-border/60 last:border-0">
                      <td className="px-3 py-2 font-mono text-xs text-tt-text/80">{o.order_id}</td>
                      <td className="px-3 py-2 text-tt-muted">{o.order_date ?? '—'}</td>
                      <td className="px-3 py-2 text-tt-muted">{o.sku_name ?? '—'}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-tt-muted">{o.gmv == null ? '—' : `$${o.gmv.toFixed(2)}`}</td>
                      <td className="px-3 py-2 text-tt-muted">{o.status ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SummaryCard({ label, value, valueClass = '', sub }: { label: string; value: string; valueClass?: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-tt-border bg-tt-card px-4 py-3">
      <div className="text-xs text-tt-muted">{label}</div>
      <div className={`text-lg font-bold tabular-nums mt-0.5 ${valueClass}`}>{value}</div>
      {sub && <div className="text-[10px] text-tt-muted mt-0.5 tabular-nums">{sub}</div>}
    </div>
  );
}
