'use client';

/**
 * /pack — packing station.
 *
 * "Orders Ready to Pack" FIFO guide (GET /api/fulfillment/pack-queue): cubicles holding
 * an assigned/packing box across BOTH stores, oldest-first (ship_by asc), NO color tiers.
 * The list is a GUIDE — the packer must physically SCAN the cubicle barcode to start
 * (the scan verifies the bin in hand matches the order; not tap-to-start).
 *
 * On cubicle scan (pack-load): the label prints (STUB — pre-bought at Buy labels) AND the
 * item cards display simultaneously (visual backstop). Confirm & hand-off → shipped (stub),
 * cubicle freed, row drops off the list.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useScanInput } from '@/hooks/useScanInput';
import { useFulfillmentShift } from '@/lib/fulfillment/shiftContext';

interface PackLine { id: string; inventory_sku_id: string; required_qty: number; picked_qty: number; sku_number?: number; title?: string; thumbnail_url?: string | null }
interface LabelResult { mode: string; message: string; labelUrl: string | null }
interface Loaded {
  state: 'loaded'; cubicle_number: number; fulfillment_order_id: string; group_key: string;
  order_ids: string[]; label: LabelResult; lines: PackLine[];
}
interface ReadyRow {
  fulfillment_order_id: string; group_key: string; order_ids: string[]; status: string;
  store: string; ship_by: string | null; ordered_at: string | null; cubicle_number: number | null; unbound_count: number;
  lines: Array<{ sku_number: number | null; title: string; required_qty: number }>;
}
type Msg = { kind: 'ok' | 'error' | 'info'; text: string } | null;

function ageLabel(iso: string | null) {
  if (!iso) return '';
  const h = (Date.now() - new Date(iso).getTime()) / 3_600_000;
  return h < 24 ? `${Math.max(0, Math.round(h))}h old` : `${Math.round(h / 24)}d old`;
}

export default function PackPage() {
  const [ready, setReady] = useState<ReadyRow[]>([]);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [label, setLabel] = useState<LabelResult | null>(null);
  const [msg, setMsg] = useState<Msg>(null);
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  const shift = useFulfillmentShift(); // { workerId, shiftId, ... } — present since the shell gates on an active shift

  async function api(path: string, body?: unknown) {
    const res = await fetch(`/api/fulfillment/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { res, json: await res.json().catch(() => ({})) };
  }

  const loadQueue = useCallback(async () => {
    const { res, json } = await api('pack-queue');
    if (res.ok) setReady((json.queue as ReadyRow[]) ?? []);
  }, []);
  useEffect(() => { loadQueue(); }, [loadQueue]);

  async function onScan(code: string) {
    if (busy || loaded) return; // one box at a time
    setBusy(true); setMsg(null);
    const { res, json } = await api('pack-load', { cubicleBarcode: code });
    setBusy(false);
    if (!res.ok) { setMsg({ kind: 'error', text: json.error === 'UNKNOWN_CUBICLE' ? '✗ Cubicle barcode not recognized' : (json.error || 'Failed') }); return; }
    if (json.state === 'empty') { setMsg({ kind: 'error', text: `Cubicle ${json.cubicle_number} is empty` }); return; }
    setLoaded(json as Loaded);
    setLabel((json as Loaded).label ?? null); // printed at scan
    setMsg({ kind: 'ok', text: `Cubicle ${json.cubicle_number} — label printing. Visually check ${json.lines.length} item(s), then hand off.` });
  }

  const { inputProps, focus } = useScanInput(useCallback(onScan, [busy, loaded]), { enabled: !loaded });

  function clear() { setLoaded(null); setMsg(null); setLabel(null); loadQueue(); focus(); }

  async function confirmShip() {
    if (!loaded) return;
    setBusy(true);
    const { res, json } = await api('confirm-ship', { fulfillmentOrderId: loaded.fulfillment_order_id, workerId: shift?.workerId, shiftId: shift?.shiftId });
    setBusy(false);
    if (!res.ok) {
      if (json.error === 'INVALID_ACTOR') { alert('Your shift ended — this box was NOT shipped. Re-select your name, then redo it.'); router.replace('/fulfillment'); return; }
      setMsg({ kind: 'error', text: json.error || 'Failed to ship' }); return;
    }
    setMsg({ kind: 'ok', text: `Shipped ✓ — cubicle ${loaded.cubicle_number} freed.` });
    setLoaded(null); setLabel(null); loadQueue();
  }

  const msgClass = msg?.kind === 'ok' ? 'text-tt-green border-tt-green/50 bg-tt-green/10'
    : msg?.kind === 'error' ? 'text-tt-red border-tt-red/50 bg-tt-red/10'
    : 'text-tt-cyan border-tt-border bg-tt-card-hover';

  return (
    <div className="min-h-screen bg-tt-bg text-tt-text p-6" onClick={focus}>
      <input {...inputProps} />
      <div className="max-w-5xl mx-auto">
        <div className="flex items-center justify-between mb-5">
          <h1 className="text-3xl font-bold">Pack station</h1>
          <div className="flex items-center gap-3">
            <Link href="/pick" className="text-sm text-tt-cyan underline">Pick</Link>
            {(loaded || label) && <button onClick={clear} className="px-5 py-2 rounded-lg border border-tt-border text-tt-muted">Next cubicle</button>}
          </div>
        </div>

        {msg && <div className={`mb-5 rounded-xl border-2 px-5 py-4 text-xl font-semibold ${msgClass}`}>{msg.text}</div>}

        {label && (
          <div className="mb-5 rounded-xl border border-tt-border bg-tt-card-hover px-5 py-4 text-sm">
            <div className="text-tt-text font-medium">🏷️ Label {label.mode === 'stub' ? '(stub — pipeline not wired)' : label.mode}</div>
            <div className="text-tt-muted mt-1">{label.message}</div>
            {label.labelUrl ? <a href={label.labelUrl} target="_blank" rel="noreferrer" className="text-tt-cyan underline">Open label PDF</a>
              : <span className="text-tt-muted italic">Manual fallback — open the label from your TikTok Shop dashboard.</span>}
          </div>
        )}

        {/* loaded box: items + hand-off */}
        {loaded ? (
          <>
            <div className="text-sm text-tt-muted mb-4 font-mono">cubicle {loaded.cubicle_number} · {loaded.group_key} · {loaded.order_ids.length} order(s)</div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5 mb-6">
              {loaded.lines.map((l) => (
                <div key={l.id} className="rounded-2xl border border-tt-border bg-tt-card p-5">
                  <div className="w-full aspect-square rounded-xl border border-tt-border bg-tt-input-bg overflow-hidden flex items-center justify-center mb-3">
                    {l.thumbnail_url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={l.thumbnail_url} alt="" className="w-full h-full object-cover" onError={(e) => { e.currentTarget.style.display = 'none'; }} />
                    ) : <span className="text-tt-muted">no img</span>}
                  </div>
                  <div className="flex items-baseline justify-between">
                    <span className="font-mono text-3xl font-bold">#{l.sku_number ?? '—'}</span>
                    <span className="text-xl font-semibold text-tt-cyan">×{l.required_qty}</span>
                  </div>
                  <div className="text-base mt-1 break-words">{l.title}</div>
                </div>
              ))}
            </div>
            <button onClick={confirmShip} disabled={busy} className="w-full py-5 rounded-2xl bg-tt-green text-black text-2xl font-bold disabled:opacity-60">
              {busy ? 'Working…' : 'Confirm & hand off'}
            </button>
          </>
        ) : (
          <>
            {/* scan action */}
            <div className="rounded-2xl border-2 border-tt-cyan/40 bg-tt-card p-8 text-center mb-6">
              <div className="text-2xl font-semibold">Scan a cubicle to begin</div>
              <div className="text-sm text-tt-muted mt-1">The list below is a guide — scan the bin you physically grabbed.</div>
              {busy && <div className="text-tt-muted mt-2">Loading…</div>}
            </div>

            {/* FIFO guide list (NOT tappable-to-start) */}
            <h2 className="text-lg font-semibold mb-3">Orders Ready to Pack · oldest first ({ready.length})</h2>
            <div className="space-y-2">
              {ready.length === 0 && <div className="text-tt-muted text-sm">No cubicles ready. Assign boxes to cubicles in /pick.</div>}
              {ready.map((r, i) => (
                <div key={r.fulfillment_order_id} className={`rounded-xl border p-4 flex items-center gap-4 ${i === 0 ? 'border-tt-cyan/50 bg-tt-card' : 'border-tt-border bg-tt-card'}`}>
                  <div className="text-center shrink-0">
                    <div className="text-3xl font-bold font-mono">{r.cubicle_number ?? '—'}</div>
                    <div className="text-[10px] uppercase tracking-wide text-tt-muted">cubicle</div>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      {r.unbound_count > 0 && <span className="text-xs px-2 py-1 rounded-full bg-tt-red text-black font-bold">⚠ {r.unbound_count} unbound</span>}
                      <span className="text-xs px-2 py-1 rounded-full bg-tt-card-hover text-tt-muted">{r.store}</span>
                      <span className="text-xs text-tt-muted">{ageLabel(r.ordered_at)}</span>
                      {i === 0 && <span className="text-xs px-2 py-1 rounded-full bg-tt-cyan/20 text-tt-cyan">next ↓ scan it</span>}
                    </div>
                    <div className="text-sm truncate">
                      {r.lines.map((l, j) => <span key={j}>#{l.sku_number ?? '—'} {l.title}{l.required_qty > 1 ? ` ×${l.required_qty}` : ''}{j < r.lines.length - 1 ? ' · ' : ''}</span>)}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
