'use client';

/**
 * ShippingTab — pick & verify packing station.
 *
 * Two barcode types, one input:
 *  1) Scan a packing-slip order_id → loads the "box" (all orders sharing the
 *     order's auto_combine_group_id) and its aggregated bound SKUs.
 *  2) Then scans are inventory item barcodes (inventory_skus.barcode); each match
 *     turns its SKU block from red → green. Confirm enables once all are green.
 *
 * Reads our own DB only (via /api/shipping/pick-list); the single write is the
 * verification on confirm (/api/shipping/confirm). Matching is by order_id and
 * auto_combine_group_id — never by product title.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

interface BoxSku {
  inventory_sku_id: string;
  sku_number: number;
  title: string;
  barcode: string;
  thumbnail_url: string | null;
  required_qty: number;
}

interface Box {
  scanned_value?: string;
  resolved_via?: 'tracking' | 'order_id';
  tracking_number?: string | null;
  scanned_order_id: string;
  group_key: string;
  group_id: string | null;
  order_ids: string[];
  order_count: number;
  skus: BoxSku[];
  missing_order_ids: string[];
  already_verified_at: string | null;
}

type Msg = { kind: 'ok' | 'error' | 'info'; text: string } | null;

export default function ShippingTab() {
  const [box, setBox] = useState<Box | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [value, setValue] = useState('');
  const [msg, setMsg] = useState<Msg>(null);
  const [loading, setLoading] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [verified, setVerified] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const focusInput = useCallback(() => {
    // Keep the scanner aimed at the input at all times.
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  useEffect(() => { focusInput(); }, [focusInput, box, verified]);

  const allGreen = useMemo(
    () => !!box && box.skus.length > 0 && box.skus.every((s) => (counts[s.inventory_sku_id] ?? 0) >= s.required_qty),
    [box, counts],
  );

  function reset() {
    setBox(null);
    setCounts({});
    setValue('');
    setMsg(null);
    setVerified(false);
    focusInput();
  }

  async function loadSlip(scan: string) {
    setLoading(true);
    setMsg(null);
    try {
      const res = await fetch('/api/shipping/pick-list', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scan }),
      });
      const json = await res.json();
      if (!res.ok) {
        // Echo exactly what was scanned (+ parsed tracking) so the picker can flag a
        // mis-scan / unknown label rather than see a generic failure.
        const t = json.parsed_tracking ? ` (tracking ${json.parsed_tracking})` : '';
        setMsg({ kind: 'error', text: `No matching order for “${json.scanned_value ?? scan}”${t}` });
        return;
      }
      const loaded = json as Box;
      setBox(loaded);
      setCounts({});
      setVerified(false);
      if (loaded.skus.length === 0) {
        // Resolved to a real order, but nothing bound (~23% of wins). Picker must flag it.
        setMsg({ kind: 'error', text: `Order ${loaded.scanned_order_id} resolved but NOT bound — no internal SKUs recorded. Flag it (do not guess).` });
      } else {
        const via = loaded.resolved_via === 'tracking' ? 'shipping label' : 'order id';
        setMsg({ kind: 'info', text: `Box loaded via ${via}: ${loaded.skus.length} SKU${loaded.skus.length === 1 ? '' : 's'} across ${loaded.order_count} order${loaded.order_count === 1 ? '' : 's'}. Scan items.` });
      }
    } catch {
      setMsg({ kind: 'error', text: 'Network error loading order' });
    } finally {
      setLoading(false);
      focusInput();
    }
  }

  function scanItem(barcode: string) {
    if (!box) return;
    const sku = box.skus.find((s) => s.barcode === barcode);
    if (!sku) {
      setMsg({ kind: 'error', text: 'Item not in this order' });
      return;
    }
    const have = counts[sku.inventory_sku_id] ?? 0;
    if (have >= sku.required_qty) {
      setMsg({ kind: 'info', text: `#${sku.sku_number} already complete (${sku.required_qty} of ${sku.required_qty})` });
      return;
    }
    const next = have + 1;
    setCounts((c) => ({ ...c, [sku.inventory_sku_id]: next }));
    setMsg({ kind: 'ok', text: `✓ #${sku.sku_number} ${sku.title} — ${next} of ${sku.required_qty}` });
  }

  function onSubmit() {
    const v = value.trim();
    setValue('');
    focusInput();
    if (!v) return;
    if (verified) return; // require explicit reset after a completed box
    if (!box) loadSlip(v);
    else scanItem(v);
  }

  async function confirm() {
    if (!box || !allGreen) return;
    setConfirming(true);
    try {
      const res = await fetch('/api/shipping/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ group_key: box.group_key, order_ids: box.order_ids }),
      });
      const json = await res.json();
      if (!res.ok) { setMsg({ kind: 'error', text: json.error || 'Failed to confirm' }); return; }
      setVerified(true);
      setMsg({ kind: 'ok', text: 'Box verified ✓ — ready to ship. Scan the next slip to continue.' });
    } catch {
      setMsg({ kind: 'error', text: 'Network error confirming' });
    } finally {
      setConfirming(false);
    }
  }

  const msgClass =
    msg?.kind === 'ok' ? 'text-tt-green border-tt-green/40 bg-tt-green/10'
    : msg?.kind === 'error' ? 'text-tt-red border-tt-red/40 bg-tt-red/10'
    : 'text-tt-cyan border-tt-border bg-tt-card-hover';

  return (
    <div>
      {/* Header */}
      <div className="flex items-end justify-between gap-4 mb-5">
        <div>
          <div className="text-xl font-bold">Packing station</div>
          <div className="text-sm text-tt-muted mt-1">
            Scan a shipping label to load the box, then scan each item to verify before shipping.
          </div>
        </div>
        {box && (
          <button
            onClick={reset}
            className="px-4 py-2 rounded-lg border border-tt-border text-sm text-tt-muted cursor-pointer hover:bg-tt-card-hover transition-colors"
          >
            New slip
          </button>
        )}
      </div>

      {/* Scan input */}
      <div className="rounded-2xl border border-tt-border bg-tt-card p-4 mb-4">
        <label className="block text-xs uppercase tracking-wide text-tt-muted mb-2">
          {box ? 'Scan item barcode' : 'Scan shipping label'}
        </label>
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onSubmit(); } }}
          placeholder={box ? 'Scan an item label…' : 'Scan shipping label…'}
          className="w-full bg-tt-input-bg border border-tt-input-border rounded-xl px-4 py-4 text-lg font-mono text-tt-text outline-none focus:border-tt-input-focus"
        />
        {loading && <div className="text-sm text-tt-muted mt-2">Loading box…</div>}
      </div>

      {/* Transient message */}
      {msg && (
        <div className={`mb-4 rounded-lg border px-4 py-3 text-sm font-medium ${msgClass}`}>{msg.text}</div>
      )}

      {/* Box detail */}
      {box && (
        <>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-xs text-tt-muted mb-3">
            <span>Order <span className="font-mono text-tt-text">{box.scanned_order_id}</span></span>
            {box.resolved_via === 'tracking' && box.tracking_number && (
              <span>label <span className="font-mono text-tt-text">{box.tracking_number}</span></span>
            )}
            <span>{box.order_count} order{box.order_count === 1 ? '' : 's'} in box</span>
            <span>group <span className="font-mono">{box.group_id ?? '— (single order)'}</span></span>
            {box.already_verified_at && !verified && (
              <span className="text-tt-cyan">already verified earlier</span>
            )}
          </div>

          {/* Missing wins flag */}
          {box.missing_order_ids.length > 0 && (
            <div className="mb-4 rounded-lg border border-tt-red/40 bg-tt-red/10 px-4 py-3 text-sm text-tt-red">
              ⚠ {box.missing_order_ids.length} order{box.missing_order_ids.length === 1 ? '' : 's'} in this box {box.missing_order_ids.length === 1 ? 'has' : 'have'} no recorded items
              (won but never bound during the live): <span className="font-mono">{box.missing_order_ids.join(', ')}</span>. Check these manually.
            </div>
          )}

          {/* SKU blocks */}
          {box.skus.length > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-5 auto-rows-fr mb-6">
              {box.skus.map((s) => {
                const have = counts[s.inventory_sku_id] ?? 0;
                const done = have >= s.required_qty;
                return (
                  <div
                    key={s.inventory_sku_id}
                    className={`rounded-2xl border-2 p-6 flex flex-wrap items-center gap-6 transition-colors ${
                      done ? 'border-tt-green/50 bg-tt-green/10' : 'border-tt-red/50 bg-tt-red/10'
                    }`}
                  >
                    <div className="w-60 h-60 shrink-0 rounded-xl border border-tt-border bg-tt-input-bg overflow-hidden flex items-center justify-center">
                      {s.thumbnail_url ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={s.thumbnail_url} alt="" className="w-full h-full object-cover" onError={(e) => { e.currentTarget.style.display = 'none'; }} />
                      ) : (
                        <span className="text-tt-muted text-sm">no img</span>
                      )}
                    </div>
                    <div className="flex-1 min-w-[14rem]">
                      <div className="flex items-baseline gap-3 flex-wrap">
                        <span className="font-mono text-8xl font-bold text-tt-text">#{s.sku_number}</span>
                        <span className={`text-2xl font-bold ${done ? 'text-tt-green' : 'text-tt-red'}`}>{done ? '✓ ' : ''}{have} of {s.required_qty}</span>
                      </div>
                      <div className="mt-2 text-2xl font-semibold leading-tight text-tt-text break-words">{s.title}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Confirm */}
          <div className="flex items-center gap-3">
            <button
              onClick={confirm}
              disabled={!allGreen || confirming || verified}
              className={`px-6 py-3 rounded-xl text-sm font-semibold transition-opacity ${
                allGreen && !verified
                  ? 'bg-tt-green text-black cursor-pointer hover:opacity-90'
                  : 'bg-tt-card-hover text-tt-muted cursor-not-allowed'
              }`}
            >
              {verified ? 'Verified ✓' : confirming ? 'Confirming…' : allGreen ? 'Confirm & verify box' : 'Scan all items to confirm'}
            </button>
            {verified && (
              <button onClick={reset} className="px-5 py-3 rounded-xl bg-tt-cyan text-black text-sm font-semibold cursor-pointer hover:opacity-90">
                Next slip
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
