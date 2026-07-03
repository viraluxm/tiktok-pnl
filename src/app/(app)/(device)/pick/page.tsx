'use client';

/**
 * /pick — mobile picker, driven by the "Orders to Complete" queue (org-shared).
 *
 * The queue (GET /api/fulfillment/queue) lists every active box across BOTH stores,
 * most-urgent first (soonest rts_sla_time dispatch deadline). Tap a row → load the box
 * (org-scoped load-box) → checklist:
 *   scan SECTION barcode → scan-section (validates SKU; qty stepper for required_qty>1)
 *   all picked → scan CUBICLE → assign-cubicle (free=lock, taken=red)
 * No packing-slip scan anymore.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useScanInput } from '@/hooks/useScanInput';
import { useFulfillmentShift } from '@/lib/fulfillment/shiftContext';

interface Line {
  inventory_sku_id: string; sku_number: number | null; title: string; thumbnail_url: string | null;
  required_qty: number; picked: boolean; picked_qty: number;
  expected_section_label: string | null; has_section: boolean;
}
interface Box {
  fulfillment_order_id: string; group_key: string; order_ids: string[]; status: string;
  lines: Line[]; missing_order_ids: string[];
}
interface QueueRow {
  fulfillment_order_id: string; group_key: string; order_ids: string[]; status: string;
  store: string; ship_by: string | null; ordered_at: string | null; tier: string; hours_left: number | null;
  cubicle_number: number | null; unbound_count: number;
  lines: Array<{ sku_number: number | null; title: string; required_qty: number; picked: boolean }>;
}
type Msg = { kind: 'ok' | 'error' | 'info'; text: string } | null;

const TIER_CLASS: Record<string, string> = {
  OVERDUE: 'bg-tt-red text-black animate-pulse',
  CRITICAL: 'bg-tt-red text-black',
  URGENT: 'bg-orange-500 text-black',
  SOON: 'bg-amber-400 text-black',
  OK: 'bg-tt-green/20 text-tt-green',
  UNKNOWN: 'bg-tt-card-hover text-tt-muted',
};
function leftLabel(tier: string, hours: number | null) {
  if (tier === 'OVERDUE') return 'OVERDUE';
  if (hours == null) return 'no SLA';
  if (hours < 24) return `${Math.max(0, Math.round(hours))}h left`;
  return `${Math.round(hours / 24)}d left`;
}

export default function PickPage() {
  const [box, setBox] = useState<Box | null>(null);
  const [queue, setQueue] = useState<QueueRow[]>([]);
  const [msg, setMsg] = useState<Msg>(null);
  const [busy, setBusy] = useState(false);
  const [stepper, setStepper] = useState<{ title: string; qty: number; max: number } | null>(null);
  const [lastSection, setLastSection] = useState('');
  const [pendingOverride, setPendingOverride] = useState<string | null>(null); // cubicle barcode awaiting unbound override

  const allPicked = !!box && box.lines.length > 0 && box.lines.every((l) => l.picked);

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

  // Shift ended mid-action → server rejected it (INVALID_ACTOR), nothing stamped/applied.
  // Make it unmistakable the action did NOT register, then send back to re-select.
  function shiftEnded(json: { error?: string }): boolean {
    if (json?.error !== 'INVALID_ACTOR') return false;
    alert('Your shift ended — that action did NOT register. Re-select your name, then redo it.');
    router.replace('/fulfillment');
    return true;
  }

  const loadQueue = useCallback(async () => {
    const { res, json } = await api('queue');
    if (res.ok) setQueue((json.queue as QueueRow[]) ?? []);
  }, []);
  useEffect(() => { loadQueue(); }, [loadQueue]);

  async function openBox(fulfillmentOrderId: string) {
    setBusy(true); setMsg(null); setPendingOverride(null);
    const { res, json } = await api('load-box', { fulfillmentOrderId });
    setBusy(false);
    if (!res.ok) { setMsg({ kind: 'error', text: json.error || 'Failed to load box' }); return; }
    setBox(json as Box);
    setMsg(json.lines?.length ? { kind: 'info', text: `Box loaded — ${json.lines.length} item(s). Scan each section.` } : { kind: 'error', text: 'No items on this box.' });
  }

  async function refreshBox() {
    if (!box) return;
    const { res, json } = await api('load-box', { fulfillmentOrderId: box.fulfillment_order_id });
    if (res.ok) setBox(json as Box);
  }

  async function scanSection(barcode: string, qty = 1) {
    if (!box) return;
    setBusy(true);
    const { res, json } = await api('scan-section', { fulfillmentOrderId: box.fulfillment_order_id, sectionBarcode: barcode, qty, workerId: shift?.workerId, shiftId: shift?.shiftId });
    setBusy(false);
    if (!res.ok) {
      if (shiftEnded(json)) return;
      setMsg({ kind: 'error', text: json.error === 'WRONG_SECTION' ? `✗ Wrong section — ${json.message}` : json.error === 'UNKNOWN_SECTION' ? '✗ Section barcode not recognized' : (json.message || json.error || 'Scan failed') });
      return;
    }
    await refreshBox();
    const line = json.line as { inventory_sku_id: string; required_qty: number; picked_qty: number; picked: boolean };
    if (line && line.required_qty > 1 && !line.picked) {
      const remaining = line.required_qty - line.picked_qty;
      const title = box.lines.find((l) => l.inventory_sku_id === line.inventory_sku_id)?.title ?? 'item';
      setLastSection(barcode);
      setStepper({ title, qty: remaining, max: remaining });
      setMsg({ kind: 'info', text: `Confirm quantity for ${title}` });
      return;
    }
    setMsg({ kind: 'ok', text: json.all_picked ? '✓ All items picked — scan a cubicle to assign.' : '✓ Item picked.' });
  }

  async function confirmStepper() {
    const s = stepper; if (!s) return;
    setStepper(null);
    if (s.qty > 0) await scanSection(lastSection, s.qty); else await refreshBox();
    focus();
  }

  async function assignCubicle(barcode: string, override = false) {
    if (!box) return;
    setBusy(true);
    const { res, json } = await api('assign-cubicle', { fulfillmentOrderId: box.fulfillment_order_id, cubicleBarcode: barcode, override, workerId: shift?.workerId, shiftId: shift?.shiftId });
    setBusy(false);
    if (!res.ok) {
      if (shiftEnded(json)) return;
      if (json.error === 'CUBICLE_TAKEN') setMsg({ kind: 'error', text: `✗ Cubicle ${json.cubicle_number} is taken — scan a free cubicle.` });
      else if (json.error === 'UNKNOWN_CUBICLE') setMsg({ kind: 'error', text: '✗ Cubicle barcode not recognized.' });
      else if (json.error === 'NOT_FULLY_PICKED') setMsg({ kind: 'error', text: 'Scan all items before assigning a cubicle.' });
      else if (json.error === 'UNBOUND_PRESENT') { setMsg({ kind: 'error', text: `⚠ ${json.message}` }); setPendingOverride(barcode); }
      else setMsg({ kind: 'error', text: json.error || 'Failed to assign' });
      return;
    }
    setPendingOverride(null);
    setMsg({ kind: 'ok', text: `✓ Assigned to cubicle ${json.cubicle_number}. Roll it to the rack.` });
    setBox(null); loadQueue();
  }

  const onScan = useCallback((code: string) => {
    if (busy || !box) return;
    if (allPicked) assignCubicle(code, false); else scanSection(code, 1);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [box, allPicked, busy]);

  const { inputProps, focus } = useScanInput(onScan, { enabled: !!box && !stepper });

  async function flagException() {
    if (!box) return;
    const reason = prompt('Flag this box as a problem (missing/damaged). Reason:');
    if (reason === null) return;
    await api('exception', { fulfillmentOrderId: box.fulfillment_order_id, action: 'flag', reason });
    setMsg({ kind: 'info', text: 'Box flagged and pulled from the queue.' });
    setBox(null); loadQueue();
  }

  const msgClass = msg?.kind === 'ok' ? 'text-tt-green border-tt-green/50 bg-tt-green/10'
    : msg?.kind === 'error' ? 'text-tt-red border-tt-red/50 bg-tt-red/10'
    : 'text-tt-cyan border-tt-border bg-tt-card-hover';

  return (
    <div className="min-h-screen bg-tt-bg text-tt-text p-4 max-w-xl mx-auto" onClick={focus}>
      <input {...inputProps} />

      {stepper && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-6" onClick={(e) => e.stopPropagation()}>
          <div className="w-full max-w-sm rounded-2xl border border-tt-border bg-tt-card p-6 text-center">
            <div className="text-lg font-semibold mb-1">{stepper.title}</div>
            <div className="text-sm text-tt-muted mb-5">How many did you pick?</div>
            <div className="flex items-center justify-center gap-6 mb-6">
              <button onClick={() => setStepper((s) => s && { ...s, qty: Math.max(0, s.qty - 1) })} className="w-16 h-16 rounded-full border-2 border-tt-border text-3xl">−</button>
              <span className="text-6xl font-bold font-mono w-20">{stepper.qty}</span>
              <button onClick={() => setStepper((s) => s && { ...s, qty: Math.min(s.max, s.qty + 1) })} className="w-16 h-16 rounded-full border-2 border-tt-border text-3xl">+</button>
            </div>
            <button onClick={confirmStepper} className="w-full py-4 rounded-xl bg-tt-green text-black text-lg font-semibold">Confirm</button>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-bold">Orders to Complete</h1>
        {box ? <button onClick={() => { setBox(null); setMsg(null); loadQueue(); }} className="px-4 py-2 rounded-lg border border-tt-border text-tt-muted">Queue</button>
             : <Link href="/pickpack" className="text-sm text-tt-cyan underline">Buy labels</Link>}
      </div>

      {msg && <div className={`mb-4 rounded-xl border-2 px-4 py-4 text-lg font-semibold ${msgClass}`}>{msg.text}</div>}

      {!box ? (
        <div className="space-y-3">
          {queue.length === 0 && <div className="text-tt-muted text-sm">Nothing to pick. Buy labels for a live session to populate the queue.</div>}
          {queue.map((q) => (
            <button key={q.fulfillment_order_id} onClick={() => openBox(q.fulfillment_order_id)}
              className="w-full text-left rounded-2xl border border-tt-border bg-tt-card p-4 active:bg-tt-card-hover">
              <div className="flex items-center justify-between gap-3 mb-2">
                <span className={`px-3 py-1 rounded-full text-sm font-bold ${TIER_CLASS[q.tier] ?? TIER_CLASS.UNKNOWN}`}>{leftLabel(q.tier, q.hours_left)}</span>
                <div className="flex items-center gap-2">
                  {q.unbound_count > 0 && <span className="text-xs px-2 py-1 rounded-full bg-tt-red text-black font-bold">⚠ {q.unbound_count} need binding</span>}
                  <span className="text-xs px-2 py-1 rounded-full bg-tt-card-hover text-tt-muted">{q.store}</span>
                  {q.cubicle_number != null && <span className="text-xs px-2 py-1 rounded-full bg-tt-cyan/20 text-tt-cyan">cubicle {q.cubicle_number}</span>}
                  <span className="text-xs text-tt-muted">{q.status}</span>
                </div>
              </div>
              <div className="text-sm">
                {q.lines.map((l, i) => (
                  <span key={i} className={l.picked ? 'text-tt-green' : 'text-tt-text'}>
                    {l.picked ? '✓ ' : ''}#{l.sku_number ?? '—'} {l.title}{l.required_qty > 1 ? ` ×${l.required_qty}` : ''}{i < q.lines.length - 1 ? ' · ' : ''}
                  </span>
                ))}
              </div>
              <div className="text-xs text-tt-muted mt-1 font-mono">{q.group_key} · {q.order_ids.length} order(s){q.ship_by ? ` · due ${new Date(q.ship_by).toLocaleString()}` : ''}</div>
            </button>
          ))}
        </div>
      ) : (
        <>
          <div className="text-xs text-tt-muted mb-3 font-mono">{box.group_key} · {box.order_ids.length} order(s)</div>
          {box.missing_order_ids.length > 0 && (
            <div className="mb-4 rounded-xl border-2 border-tt-red bg-tt-red/15 px-4 py-3 text-tt-red font-semibold">
              ⚠ {box.missing_order_ids.length} order(s) in this box have NO scanned SKUs — not pickable here (under-ship risk). Bind them at the live, or override below to assign anyway.
              <div className="text-xs font-mono mt-1 break-words">{box.missing_order_ids.join(', ')}</div>
            </div>
          )}
          <div className="space-y-3 mb-5">
            {box.lines.map((l) => (
              <div key={l.inventory_sku_id} className={`rounded-2xl border-2 p-5 flex items-center gap-4 ${l.picked ? 'border-tt-green/50 bg-tt-green/10' : 'border-tt-red/40 bg-tt-red/10'}`}>
                <div className="w-20 h-20 shrink-0 rounded-xl border border-tt-border bg-tt-input-bg overflow-hidden flex items-center justify-center">
                  {l.thumbnail_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={l.thumbnail_url} alt="" className="w-full h-full object-cover" onError={(e) => { e.currentTarget.style.display = 'none'; }} />
                  ) : <span className="text-tt-muted text-xs">no img</span>}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-4xl font-bold">#{l.sku_number ?? '—'}</span>
                    <span className={`text-xl font-bold ${l.picked ? 'text-tt-green' : 'text-tt-red'}`}>{l.picked ? '✓ ' : ''}{l.picked_qty}/{l.required_qty}</span>
                  </div>
                  <div className="text-lg font-semibold mt-1 break-words">{l.title}</div>
                  <div className="text-sm text-tt-muted mt-1">
                    {l.has_section ? <>Section <span className="text-tt-text font-semibold">{l.expected_section_label}</span></> : <span className="text-tt-red">⚠ no section mapped (Settings)</span>}
                  </div>
                </div>
              </div>
            ))}
          </div>
          <div className="rounded-2xl border border-tt-border bg-tt-card p-4 mb-4 text-center">
            <div className="text-lg font-semibold">{allPicked ? '📦 Scan a CUBICLE to assign' : '🏷️ Scan the SECTION barcode for each item'}</div>
            {busy && <div className="text-sm text-tt-muted mt-1">Working…</div>}
          </div>
          {pendingOverride && (
            <button onClick={() => assignCubicle(pendingOverride, true)} className="w-full mb-3 py-4 rounded-xl bg-tt-red text-black font-bold">
              ⚠ Override — assign to that cubicle anyway (unbound order will NOT be in the box)
            </button>
          )}
          <button onClick={flagException} className="w-full py-3 rounded-xl border border-tt-red/40 text-tt-red text-sm">Can&apos;t complete this pick (flag &amp; remove)</button>
        </>
      )}
    </div>
  );
}
