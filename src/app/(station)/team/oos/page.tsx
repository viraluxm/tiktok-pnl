'use client';

import { useCallback, useState } from 'react';
import MemberNav from '@/components/member/MemberNav';

// Out-of-stock lookup — "which item in this box do I cancel in Seller Center?"
//
// The picker scans a label, the device flags an item OUT OF STOCK, and the box goes on the pile.
// Whoever then opens Seller Center sees 2+ items and no way to tell which one was short. This is
// that answer, read back from the same stored flag the picking device drew its band from.
//
// Designed to be used with a scanner: the field is autofocused and submits on Enter, so a hardware
// scanner (which types the digits and presses Enter) works with no clicks at all.

interface Sku {
  inventory_sku_id: string;
  sku_number: number | null;
  title: string;
  barcode: string | null;
  thumbnail_url: string | null;
  required_qty: number;
  shelf_out: boolean;
  location_label: string | null;
}
interface Result {
  scanned_value: string;
  resolved_via: string;
  tracking_number: string | null;
  scanned_order_id: string;
  order_ids: string[];
  order_count: number;
  verdict: 'one' | 'several' | 'none';
  item_count: number;
  skus: Sku[];
  missing_order_ids: string[];
  excluded: { order_id: string; reason: string }[];
}

export default function MemberOosPage() {
  const [scan, setScan] = useState('');
  const [res, setRes] = useState<Result | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const lookup = useCallback(async (value: string) => {
    const v = value.trim();
    if (!v) return;
    setLoading(true); setErr(null); setRes(null);
    try {
      const r = await fetch(`/api/member/oos?scan=${encodeURIComponent(v)}`);
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        // A miss is the common, expected outcome for a mistyped label — say what we tried to read
        // out of it, because a silent "not found" sends people hunting for the wrong problem.
        setErr(j.parsed_tracking
          ? `${j.error ?? 'Not found'} — read as tracking ${j.parsed_tracking}`
          : String(j.error ?? `Lookup failed (${r.status})`));
        return;
      }
      setRes(j as Result);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  return (
    <main className="min-h-screen bg-tt-bg text-tt-text p-6 max-w-3xl mx-auto">
      <MemberNav active="oos" />
      <div className="mb-5">
        <h1 className="text-2xl font-bold">Out of stock</h1>
        <p className="mt-1 text-sm text-tt-muted">
          Scan or paste a tracking number (or order ID) from the out-of-stock pile. This shows which
          item in that box was short, so you cancel the right line in Seller Center.
        </p>
      </div>

      <form
        onSubmit={(e) => { e.preventDefault(); lookup(scan); }}
        className="flex gap-2"
      >
        <input
          value={scan}
          onChange={(e) => setScan(e.target.value)}
          autoFocus
          placeholder="Scan label or paste tracking / order ID…"
          className="flex-1 rounded-xl border-2 border-tt-border bg-white/5 px-4 py-3 font-mono text-sm outline-none focus:border-tt-cyan/60"
        />
        <button
          type="submit"
          disabled={loading || !scan.trim()}
          className="rounded-xl bg-tt-cyan px-5 py-3 text-sm font-bold text-black hover:opacity-90 disabled:opacity-40"
        >
          {loading ? 'Looking…' : 'Look up'}
        </button>
      </form>

      {err && (
        <div className="mt-4 rounded-xl border-2 border-tt-red/50 bg-tt-red/10 px-4 py-3 text-tt-red font-semibold break-all">{err}</div>
      )}

      {res && (
        <div className="mt-5 space-y-4">
          {/* ── The verdict, first and largest: it is the reason this page exists. ── */}
          {res.verdict === 'one' && (
            <div className="rounded-2xl border-2 border-tt-red/60 bg-tt-red/10 px-4 py-3">
              <div className="text-xs font-bold uppercase tracking-wide text-tt-red">Cancel this item in Seller Center</div>
              <div className="mt-1 text-sm text-tt-muted">The other {Math.max(0, res.item_count - 1)} item(s) in this box still ship — buy a new label after cancelling.</div>
            </div>
          )}
          {res.verdict === 'several' && (
            <div className="rounded-2xl border-2 border-tt-red/60 bg-tt-red/10 px-4 py-3">
              <div className="text-xs font-bold uppercase tracking-wide text-tt-red">{res.skus.filter((s) => s.shelf_out).length} items are short</div>
              {/* Never guess one when several are flagged — cancelling a good line is worse. */}
              <div className="mt-1 text-sm text-tt-muted">Every item marked below was short. Cancel them all, not just one.</div>
            </div>
          )}
          {res.verdict === 'none' && (
            <div className="rounded-2xl border-2 border-tt-yellow/50 bg-tt-yellow/10 px-4 py-3">
              <div className="text-xs font-bold uppercase tracking-wide text-tt-yellow">Nothing flagged as out of stock</div>
              {/* Deliberately offers no stock guess: on-hand counts run negative on fast movers,
                  so a fallback here would be wrong often enough to cancel good lines. */}
              <div className="mt-1 text-sm text-tt-muted">
                No item in this box was recorded short when it was bound. If the picker still cannot
                find one, the count is off rather than the system knowing — check the shelf, and do
                not cancel a line on a guess.
              </div>
            </div>
          )}

          {/* ── Box identity, so they can confirm they are looking at the right label. ── */}
          <div className="rounded-xl border border-tt-border bg-tt-card px-4 py-3 text-xs text-tt-muted break-all">
            <div>Tracking <span className="font-mono text-tt-text">{res.tracking_number ?? '—'}</span> · matched by {res.resolved_via.replace('_', ' ')}</div>
            <div className="mt-1">
              {res.order_count} order{res.order_count === 1 ? '' : 's'} in this box:{' '}
              <span className="font-mono text-tt-text">{res.order_ids.join(', ')}</span>
            </div>
          </div>

          {/* ── The items. Flagged ones first and unmistakable. ── */}
          <div className="flex flex-col gap-2">
            {[...res.skus].sort((a, b) => Number(b.shelf_out) - Number(a.shelf_out)).map((s) => (
              <div
                key={s.inventory_sku_id}
                className={`flex items-center gap-3 rounded-xl border-2 p-3 ${s.shelf_out ? 'border-tt-red bg-tt-red/10' : 'border-tt-border bg-tt-bg opacity-70'}`}
              >
                {s.thumbnail_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={s.thumbnail_url} alt="" className="h-14 w-14 rounded-lg object-cover border border-tt-border" onError={(e) => { e.currentTarget.style.display = 'none'; }} />
                ) : (
                  <span className="h-14 w-14 rounded-lg border border-tt-border flex items-center justify-center font-mono text-xs text-tt-muted">#{s.sku_number ?? '?'}</span>
                )}
                <div className="min-w-0 flex-1">
                  <div className="font-mono font-bold text-sm">
                    #{s.sku_number ?? '?'}{s.required_qty > 1 ? <span className="ml-2 text-tt-muted">×{s.required_qty}</span> : null}
                  </div>
                  <div className="text-xs text-tt-muted truncate">{s.title}</div>
                  {s.location_label && <div className="mt-0.5 text-xs text-tt-muted">{s.location_label}</div>}
                </div>
                {s.shelf_out ? (
                  <span className="shrink-0 rounded-lg bg-tt-red px-3 py-2 text-xs font-extrabold tracking-wide text-white">OUT OF STOCK</span>
                ) : (
                  <span className="shrink-0 text-xs text-tt-muted">in stock</span>
                )}
              </div>
            ))}
          </div>

          {/* Unbound orders in the box have no internal SKU, so they cannot carry a flag. Say it
              rather than showing a short list that looks complete. */}
          {res.missing_order_ids.length > 0 && (
            <div className="rounded-xl border border-tt-yellow/40 bg-tt-yellow/5 px-4 py-3 text-xs text-tt-yellow break-all">
              {res.missing_order_ids.length} order(s) in this box have no SKU bound, so nothing can be
              flagged for them: <span className="font-mono">{res.missing_order_ids.join(', ')}</span>.
              Bind them on the Binding tab first.
            </div>
          )}

          {res.excluded.length > 0 && (
            <div className="rounded-xl border border-tt-border bg-tt-card px-4 py-3 text-xs text-tt-muted break-all">
              Not packable, so excluded from the item list above:{' '}
              {res.excluded.map((e) => `${e.order_id} (${e.reason})`).join(', ')}
            </div>
          )}
        </div>
      )}
    </main>
  );
}
