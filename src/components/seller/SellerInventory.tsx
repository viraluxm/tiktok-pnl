'use client';

import { useEffect, useMemo, useState } from 'react';

// The shared catalog, read-only, for an external seller.
//
// Cost is shown on purpose: a seller who cannot see cost cannot tell whether a price loses money.
// Everything here comes from /api/seller/inventory, which is org-scoped and has no write verbs —
// the seller reads the shelf, they never edit it.
interface SellerSku {
  id: string;
  sku_number: number | null;
  barcode: string | null;
  title: string | null;
  unit_cost_cents: number | null;
  qty_on_hand: number | null;
  category: string | null;
  live_seller_notes: string[] | null;
}

const money = (cents: number | null) =>
  cents == null ? '—' : `$${(cents / 100).toFixed(2)}`;

export default function SellerInventory() {
  const [skus, setSkus] = useState<SellerSku[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [inStockOnly, setInStockOnly] = useState(true);

  useEffect(() => {
    let alive = true;
    fetch('/api/seller/inventory')
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!alive) return;
        if (!res.ok) {
          setError(body?.error ?? 'Could not load inventory');
          return;
        }
        setSkus(Array.isArray(body.skus) ? body.skus : []);
      })
      .catch(() => { if (alive) setError('Could not load inventory'); });
    return () => { alive = false; };
  }, []);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (skus ?? []).filter((s) => {
      if (inStockOnly && (s.qty_on_hand ?? 0) <= 0) return false;
      if (!needle) return true;
      return (
        (s.title ?? '').toLowerCase().includes(needle) ||
        String(s.sku_number ?? '').includes(needle) ||
        (s.barcode ?? '').toLowerCase().includes(needle) ||
        (s.category ?? '').toLowerCase().includes(needle)
      );
    });
  }, [skus, q, inStockOnly]);

  if (error) return <div className="text-xs text-tt-red">{error}</div>;
  if (!skus) return <div className="text-xs text-tt-muted">Loading inventory…</div>;

  return (
    <div>
      <div className="mb-3 flex items-center gap-3 flex-wrap">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search title, SKU #, barcode, category"
          className="px-3 py-1.5 rounded-lg bg-tt-card border border-tt-border text-xs text-tt-text placeholder:text-tt-muted min-w-[260px]"
        />
        <label className="flex items-center gap-1.5 text-[11px] text-tt-muted">
          <input type="checkbox" checked={inStockOnly} onChange={(e) => setInStockOnly(e.target.checked)} />
          In stock only
        </label>
        <span className="text-[11px] text-tt-muted">{rows.length} of {skus.length}</span>
      </div>

      {/* Wide table scrolls in its own container so the page never scrolls sideways. */}
      <div className="overflow-x-auto rounded-xl border border-tt-border">
        <table className="w-full text-xs">
          <thead className="bg-tt-card">
            <tr className="text-left text-tt-muted">
              <th className="px-3 py-2 font-medium">SKU</th>
              <th className="px-3 py-2 font-medium">Title</th>
              <th className="px-3 py-2 font-medium">Category</th>
              <th className="px-3 py-2 font-medium text-right">On hand</th>
              <th className="px-3 py-2 font-medium text-right">Your cost</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.id} className="border-t border-tt-border/60">
                <td className="px-3 py-2 text-tt-muted whitespace-nowrap">{s.sku_number ?? '—'}</td>
                <td className="px-3 py-2 text-tt-text">
                  {s.title ?? 'Untitled'}
                  {s.live_seller_notes?.length ? (
                    <ul className="mt-1 text-[10px] text-tt-muted list-disc list-inside">
                      {s.live_seller_notes.slice(0, 3).map((n, i) => <li key={i}>{n}</li>)}
                    </ul>
                  ) : null}
                </td>
                <td className="px-3 py-2 text-tt-muted whitespace-nowrap">{s.category ?? '—'}</td>
                <td className={`px-3 py-2 text-right whitespace-nowrap ${(s.qty_on_hand ?? 0) > 0 ? 'text-tt-text' : 'text-tt-red'}`}>
                  {s.qty_on_hand ?? 0}
                </td>
                <td className="px-3 py-2 text-right text-tt-text whitespace-nowrap">{money(s.unit_cost_cents)}</td>
              </tr>
            ))}
            {!rows.length && (
              <tr><td colSpan={5} className="px-3 py-6 text-center text-tt-muted">Nothing matches.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
