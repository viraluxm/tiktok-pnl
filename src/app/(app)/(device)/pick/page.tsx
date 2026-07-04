'use client';

/**
 * /pick — slip-scan picker (Pure A: runs inside the device shell with an active shift).
 *
 * Flow: "Scan packing slip" → scan TikTok's slip barcode (= order_id) → scan-slip resolves the
 * order's bound items (server-side owner-lookup, org-scoped) → picker pulls the items and stages
 * them on the rack with the slip + label already attached → "Done / Staged" → complete-pick
 * bulk-stamps attribution (picked_by / picked_via_shift) and sets status 'fully_picked' (terminal
 * — no cubicle, no pack; the shipper grabs the staged rack). Then back to the scan prompt.
 *
 * Done-primary (visual verification via the slip). Optional "Verify each item" toggle re-uses
 * scan-section to check items off by scanning their SKU barcode. No queue, no cubicle here.
 */

import { useCallback, useState } from 'react';
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
  lines: Line[]; missing_order_ids: string[]; scanned_order_id?: string;
}
type Msg = { kind: 'ok' | 'error' | 'info'; text: string } | null;

export default function PickPage() {
  const [box, setBox] = useState<Box | null>(null);
  const [msg, setMsg] = useState<Msg>(null);
  const [busy, setBusy] = useState(false);
  const [verify, setVerify] = useState(false); // optional per-item scan verification
  const [stepper, setStepper] = useState<{ title: string; qty: number; max: number } | null>(null);
  const [lastSection, setLastSection] = useState('');

  const router = useRouter();
  const shift = useFulfillmentShift(); // { workerId, shiftId, ... } — present (shell gates on active shift)
  const allPicked = !!box && box.lines.length > 0 && box.lines.every((l) => l.picked);

  async function api(path: string, body?: unknown) {
    const res = await fetch(`/api/fulfillment/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { res, json: await res.json().catch(() => ({})) };
  }

  // Shift ended mid-action → server rejected (INVALID_ACTOR), nothing stamped. Make it unmistakable.
  function shiftEnded(json: { error?: string }): boolean {
    if (json?.error !== 'INVALID_ACTOR') return false;
    alert('Your shift ended — that action did NOT register. Re-select your name, then redo it.');
    router.replace('/fulfillment');
    return true;
  }

  // ---- scan a slip (order_id) → load the order's items ----
  async function scanSlip(code: string) {
    setBusy(true); setMsg(null);
    const { res, json } = await api('scan-slip', { scanned: code, workerId: shift?.workerId, shiftId: shift?.shiftId });
    setBusy(false);
    if (json?.recognized === false) {
      // Resilient self-test: show exactly what the barcode emitted (is it the order_id or not?).
      setMsg({ kind: 'error', text: `✗ ${json.message}` });
      return;
    }
    if (!res.ok) {
      setMsg({ kind: 'error', text: json.error === 'OUT_OF_ORG' ? `✗ ${json.message}` : (json.message || json.error || 'Scan failed') });
      return;
    }
    setBox(json as Box);
    const n = (json.lines as Line[])?.length ?? 0;
    setMsg(n ? { kind: 'info', text: `Order loaded — ${n} item(s). Pull them, attach slip + label, stage on the rack.` }
             : { kind: 'error', text: 'No bound items on this order (not pickable here — bind at the live).' });
  }

  // ---- optional: per-item scan verification (re-uses scan-section) ----
  async function refreshBox() {
    if (!box) return;
    const { res, json } = await api('load-box', { fulfillmentOrderId: box.fulfillment_order_id });
    if (res.ok) setBox({ ...(json as Box), scanned_order_id: box.scanned_order_id });
  }
  async function scanItem(barcode: string, qty = 1) {
    if (!box) return;
    setBusy(true);
    const { res, json } = await api('scan-section', { fulfillmentOrderId: box.fulfillment_order_id, sectionBarcode: barcode, qty, workerId: shift?.workerId, shiftId: shift?.shiftId });
    setBusy(false);
    if (!res.ok) {
      if (shiftEnded(json)) return;
      setMsg({ kind: 'error', text: json.error === 'WRONG_SECTION' ? `✗ ${json.message}` : json.error === 'UNKNOWN_SECTION' ? '✗ Barcode not recognized' : (json.message || json.error || 'Scan failed') });
      return;
    }
    await refreshBox();
    const line = json.line as { inventory_sku_id: string; required_qty: number; picked_qty: number; picked: boolean };
    if (line && line.required_qty > 1 && !line.picked) {
      const remaining = line.required_qty - line.picked_qty;
      const title = box.lines.find((l) => l.inventory_sku_id === line.inventory_sku_id)?.title ?? 'item';
      setLastSection(barcode);
      setStepper({ title, qty: remaining, max: remaining });
      return;
    }
    setMsg({ kind: 'ok', text: json.all_picked ? '✓ All items verified — tap Done.' : '✓ Item verified.' });
  }
  async function confirmStepper() {
    const s = stepper; if (!s) return;
    setStepper(null);
    if (s.qty > 0) await scanItem(lastSection, s.qty); else await refreshBox();
    focus();
  }

  // ---- Done / Staged → bulk-stamp attribution + terminal fully_picked ----
  async function completePick() {
    if (!box || busy) return;
    setBusy(true);
    const { res, json } = await api('complete-pick', { fulfillmentOrderId: box.fulfillment_order_id, workerId: shift?.workerId, shiftId: shift?.shiftId });
    setBusy(false);
    if (!res.ok) { if (shiftEnded(json)) return; setMsg({ kind: 'error', text: json.message || json.error || 'Failed to complete' }); return; }
    setBox(null);
    setMsg({ kind: 'ok', text: '✓ Staged & ready to ship. Scan the next slip.' });
    focus();
  }

  async function flagException() {
    if (!box) return;
    const reason = prompt('Flag this order as a problem (missing/damaged). Reason:');
    if (reason === null) return;
    await api('exception', { fulfillmentOrderId: box.fulfillment_order_id, action: 'flag', reason });
    setBox(null);
    setMsg({ kind: 'info', text: 'Order flagged.' });
  }

  const onScan = useCallback((code: string) => {
    if (busy) return;
    if (!box) scanSlip(code);
    else if (verify) scanItem(code, 1);
    // box open + not verifying → Done is the action; ignore stray scans.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [box, verify, busy, shift?.workerId, shift?.shiftId]);

  // Scanner is live when awaiting a slip, or when verifying items on an open box.
  const { inputProps, focus } = useScanInput(onScan, { enabled: (!box || verify) && !stepper });

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
        <h1 className="text-2xl font-bold">Pick — scan slip</h1>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-xs text-tt-muted">
            <input type="checkbox" checked={verify} onChange={(e) => setVerify(e.target.checked)} className="accent-tt-cyan" />
            Verify each item
          </label>
          {box && <button onClick={() => { setBox(null); setMsg(null); focus(); }} className="px-4 py-2 rounded-lg border border-tt-border text-tt-muted">Cancel</button>}
        </div>
      </div>

      {msg && <div className={`mb-4 rounded-xl border-2 px-4 py-4 text-lg font-semibold ${msgClass}`}>{msg.text}</div>}

      {!box ? (
        <div className="rounded-2xl border-2 border-dashed border-tt-border bg-tt-card p-10 text-center">
          <div className="text-2xl font-bold mb-2">📦 Scan a packing slip</div>
          <div className="text-tt-muted">Scan the barcode on TikTok&apos;s packing slip to load the order&apos;s items.</div>
          {busy && <div className="text-sm text-tt-cyan mt-3">Loading…</div>}
        </div>
      ) : (
        <>
          <div className="text-xs text-tt-muted mb-3 font-mono">
            {box.scanned_order_id ? `slip ${box.scanned_order_id}` : box.group_key} · {box.order_ids.length} order(s)
          </div>
          {box.missing_order_ids.length > 0 && (
            <div className="mb-4 rounded-xl border-2 border-tt-red bg-tt-red/15 px-4 py-3 text-tt-red font-semibold">
              ⚠ {box.missing_order_ids.length} order(s) here have NO scanned SKUs (not pickable — bind at the live).
              <div className="text-xs font-mono mt-1 break-words">{box.missing_order_ids.join(', ')}</div>
            </div>
          )}
          <div className="space-y-3 mb-5">
            {box.lines.map((l) => (
              <div key={l.inventory_sku_id} className={`rounded-2xl border-2 p-5 flex items-center gap-4 ${verify ? (l.picked ? 'border-tt-green/50 bg-tt-green/10' : 'border-tt-red/40 bg-tt-red/10') : 'border-tt-border bg-tt-card'}`}>
                <div className="w-20 h-20 shrink-0 rounded-xl border border-tt-border bg-tt-input-bg overflow-hidden flex items-center justify-center">
                  {l.thumbnail_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={l.thumbnail_url} alt="" className="w-full h-full object-cover" onError={(e) => { e.currentTarget.style.display = 'none'; }} />
                  ) : <span className="text-tt-muted text-xs">no img</span>}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-4xl font-bold">#{l.sku_number ?? '—'}</span>
                    <span className={`text-xl font-bold ${verify ? (l.picked ? 'text-tt-green' : 'text-tt-red') : 'text-tt-text'}`}>
                      {verify && l.picked ? '✓ ' : ''}×{l.required_qty}{verify ? ` (${l.picked_qty}/${l.required_qty})` : ''}
                    </span>
                  </div>
                  <div className="text-lg font-semibold mt-1 break-words">{l.title}</div>
                  {verify && <div className="text-sm text-tt-muted mt-1">{l.has_section ? <>Section <span className="text-tt-text font-semibold">{l.expected_section_label}</span></> : <span className="text-tt-red">⚠ no section mapped</span>}</div>}
                </div>
              </div>
            ))}
          </div>
          {verify && (
            <div className="rounded-2xl border border-tt-border bg-tt-card p-4 mb-4 text-center">
              <div className="text-lg font-semibold">{allPicked ? '✓ All items verified' : '🏷️ Scan each item&apos;s barcode to verify'}</div>
              {busy && <div className="text-sm text-tt-muted mt-1">Working…</div>}
            </div>
          )}
          <button onClick={completePick} disabled={busy}
            className="w-full py-5 rounded-2xl bg-tt-green text-black text-xl font-bold disabled:opacity-50 mb-3">
            {busy ? 'Staging…' : 'Done / Staged — next slip'}
          </button>
          <button onClick={flagException} className="w-full py-3 rounded-xl border border-tt-red/40 text-tt-red text-sm">Can&apos;t complete — flag &amp; remove</button>
        </>
      )}
      <div className="mt-6 text-center">
        <Link href="/pickpack" className="text-xs text-tt-muted underline">Owner tools</Link>
      </div>
    </div>
  );
}
