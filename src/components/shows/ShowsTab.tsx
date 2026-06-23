'use client';

import { useMemo, useState } from 'react';
import { useLiveSessions, type LiveSession, type SessionStatus } from '@/hooks/useLiveSessions';
import { useAuctionBoard, type AuctionItem } from '@/hooks/useLiveAuctions';

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
  saleCents: number;
  costCents: number;
  profitCents: number;
}

// P&L summary over SOLD items only, using the REAL won price (not the ASP goal):
// sale value = Σ won price, cost from inventory_skus, gross profit = sale − cost.
function summarize(items: AuctionItem[]): ShowSummary {
  let itemsSold = 0;
  let sale = 0;
  let cost = 0;
  for (const it of items) {
    if (it.status === 'sold') {
      itemsSold += 1;
      sale += wonCents(it) ?? 0;
      cost += it.total_cost_cents ?? 0;
    }
  }
  return { itemsSold, saleCents: sale, costCents: cost, profitCents: sale - cost };
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

export default function ShowsTab() {
  const { data: sessions = [], isLoading } = useLiveSessions();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const selected = useMemo(
    () => sessions.find((s) => s.id === selectedId) ?? null,
    [sessions, selectedId],
  );

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16 text-tt-muted">
        <div className="w-5 h-5 border-2 border-tt-muted border-t-transparent rounded-full animate-spin mr-3" />
        Loading shows…
      </div>
    );
  }

  if (selected) {
    return <ShowDetail session={selected} onBack={() => setSelectedId(null)} />;
  }

  if (sessions.length === 0) {
    return (
      <div className="rounded-2xl border border-tt-border bg-tt-card py-16 text-center">
        <div className="text-tt-text font-medium">No shows yet</div>
        <p className="text-sm text-tt-muted mt-2 max-w-sm mx-auto">
          When you run a live auction, each session and the sales captured in it will appear here.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-tt-border bg-tt-card overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-tt-border text-tt-muted text-xs uppercase tracking-wide">
            <th className="text-left font-medium px-4 py-3">Show</th>
            <th className="text-left font-medium px-4 py-3">Status</th>
            <th className="text-right font-medium px-4 py-3">Items sold</th>
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
          </div>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <SummaryCard label="Items sold" value={isLoading ? '…' : String(sum.itemsSold)} />
        <SummaryCard label="Sale value" value={isLoading ? '…' : money(sum.saleCents)} />
        <SummaryCard label="Cost" value={isLoading ? '…' : money(sum.costCents)} />
        <SummaryCard
          label="Gross profit"
          value={isLoading ? '…' : money(sum.profitCents)}
          valueClass={isLoading ? '' : profitClass(sum.profitCents)}
        />
      </div>

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
                <th className="text-right font-medium px-4 py-3">Profit</th>
                <th className="text-right font-medium px-4 py-3">Actual payout</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it) => {
                const sold = it.status === 'sold';
                const won = wonCents(it); // real winning bid (sold items only)
                const cost = it.total_cost_cents;
                // Profit is the REAL outcome: won price − cost (never ASP goal).
                const profit = sold && won != null ? won - (cost ?? 0) : null;
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
                      <span className={`text-xs font-medium ${sold ? 'text-tt-green' : 'text-tt-muted'}`}>
                        {sold ? 'Sold' : 'Not sold'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-tt-muted">{money(it.expected_price_cents)}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{money(sold ? won : null)}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{money(cost)}</td>
                    <td className={`px-4 py-3 text-right tabular-nums ${profit == null ? 'text-tt-muted' : profitClass(profit)}`}>
                      {profit == null ? '—' : money(profit)}
                    </td>
                    {/* Placeholder: TikTok Finance payouts not wired in yet. */}
                    <td className="px-4 py-3 text-right text-tt-muted">—</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
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
