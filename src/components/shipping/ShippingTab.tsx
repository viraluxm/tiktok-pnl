'use client';

/**
 * ShippingTab — full-screen focus-mode picker (ported from picker-ui-v4 prototype).
 *
 * Flow: Start scanning → FOCUS MODE (no tab nav; exit via tap-and-hold on the corner ✕).
 *   Ready → scan a shipping label → EXISTING /api/shipping/pick-list resolution (unchanged).
 *   • Box has any UNBOUND order → up-front ALERT (listing name + seller-SKU) → "set aside".
 *   • Clean box → PICK FLOW: one SKU per screen, photo-first, tap to count up; a SKU that
 *     hits its qty flashes ✓ then auto-advances. Free nav; FINISH only when all complete.
 *   • Finish → records verified (/api/shipping/confirm) → "Scan next label".
 *
 * Box RESOLUTION (which orders/SKUs/quantities, exclusions, live status) is owned entirely
 * by the route and is NOT touched here — this component is presentation + scan routing.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

interface BoxSku {
  inventory_sku_id: string;
  sku_number: number | null;
  title: string;
  barcode: string | null;
  thumbnail_url: string | null;
  required_qty: number;
}
interface MissingOrder { order_id: string; listing_name: string | null; seller_sku: string | null; }
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
  missing_orders?: MissingOrder[];
  excluded?: { order_id: string; reason: string; skus: string[] }[];
  excluded_count?: number;
  status_unverified?: boolean;
  already_verified_at: string | null;
}

type Screen = 'ready' | 'alert' | 'pick' | 'finish' | 'empty';

const firstUnpicked = (b: Box, c: Record<string, number>) => {
  const i = b.skus.findIndex((s) => (c[s.inventory_sku_id] ?? 0) < s.required_qty);
  return i === -1 ? 0 : i;
};

export default function ShippingTab() {
  const [focus, setFocus] = useState(false);
  const [screen, setScreen] = useState<Screen>('ready');
  const [box, setBox] = useState<Box | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [activeIdx, setActiveIdx] = useState(0);
  const [pickedToday, setPickedToday] = useState(0);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [justDone, setJustDone] = useState(false);
  const [abandon, setAbandon] = useState<null | { scan: string | null }>(null);
  const [holding, setHolding] = useState(false);
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const confirmedRef = useRef(false); // fire /confirm + count once per box

  const focusInput = useCallback(() => { requestAnimationFrame(() => inputRef.current?.focus()); }, []);
  useEffect(() => { if (focus) focusInput(); }, [focus, screen, box, focusInput]);

  const anyPicked = useMemo(() => Object.values(counts).some((v) => v > 0), [counts]);
  const pickedUnits = useMemo(() => Object.values(counts).reduce((a, b) => a + b, 0), [counts]);
  const totalUnits = useMemo(() => (box ? box.skus.reduce((a, s) => a + s.required_qty, 0) : 0), [box]);
  const allComplete = useMemo(
    () => !!box && box.skus.length > 0 && box.skus.every((s) => (counts[s.inventory_sku_id] ?? 0) >= s.required_qty),
    [box, counts],
  );

  // ── scan → box resolution (EXISTING route, unchanged) ──
  async function loadBox(scan: string) {
    setLoading(true); setErr(null);
    try {
      const res = await fetch('/api/shipping/pick-list', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scan }),
      });
      const json = await res.json();
      if (!res.ok) {
        const t = json.parsed_tracking ? ` (tracking ${json.parsed_tracking})` : '';
        setErr(`No matching order for “${json.scanned_value ?? scan}”${t}`);
        setScreen('ready');
        return;
      }
      const b = json as Box;
      setBox(b); setCounts({}); setActiveIdx(0); confirmedRef.current = false; setErr(null);
      const unbound = (b.missing_orders?.length ?? 0) > 0 || b.missing_order_ids.length > 0;
      if (unbound) setScreen('alert');            // ANY unbound → alert, never pick
      else if (b.skus.length === 0) setScreen('empty'); // all do-not-pack / nothing to pick
      else { setScreen('pick'); setActiveIdx(firstUnpicked(b, {})); }
    } catch {
      setErr('Network error loading the box'); setScreen('ready');
    } finally {
      setLoading(false); focusInput();
    }
  }

  function onScan() {
    const v = value.trim(); setValue(''); focusInput();
    if (!v || loading) return;
    if (screen === 'pick' && anyPicked) { setAbandon({ scan: v }); return; } // guard mid-pick
    loadBox(v);
  }

  // ── pick actions ──
  function grab(sku: BoxSku) {
    if (!box) return;
    const have = counts[sku.inventory_sku_id] ?? 0;
    if (have >= sku.required_qty) return;
    const next = have + 1;
    const nc = { ...counts, [sku.inventory_sku_id]: next };
    setCounts(nc);
    if (next >= sku.required_qty) {
      setJustDone(true);
      window.setTimeout(() => {
        setJustDone(false);
        const complete = box.skus.every((s) => (nc[s.inventory_sku_id] ?? 0) >= s.required_qty);
        if (complete) enterFinish(box);
        else setActiveIdx(firstUnpicked(box, nc));
      }, 550);
    }
  }

  function enterFinish(b: Box) {
    setScreen('finish');
    if (!confirmedRef.current) {
      confirmedRef.current = true;
      setPickedToday((n) => n + 1);
      // Preserve the existing verify write — the box records as verified on finish.
      fetch('/api/shipping/confirm', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ group_key: b.group_key, order_ids: b.order_ids }),
      }).catch(() => {});
    }
  }

  const backToReady = () => { setBox(null); setCounts({}); setErr(null); setScreen('ready'); focusInput(); };

  // ── focus enter / hold-to-exit ──
  const startScanning = () => { setFocus(true); setBox(null); setCounts({}); setErr(null); setScreen('ready'); focusInput(); };
  const beginHold = () => { setHolding(true); holdTimer.current = setTimeout(() => { setHolding(false); setFocus(false); backToReady(); }, 900); };
  const cancelHold = () => { setHolding(false); if (holdTimer.current) clearTimeout(holdTimer.current); };

  // ── idle (tab) view ──
  if (!focus) {
    return (
      <div>
        <div className="text-xl font-bold">Packing station</div>
        <div className="text-sm text-tt-muted mt-1 mb-8">Full-screen, scanner-driven picking. Scan a shipping label, pick each item, put the box on the rack.</div>
        <button
          onClick={startScanning}
          className="px-8 py-5 rounded-2xl bg-tt-green text-black text-lg font-extrabold cursor-pointer hover:opacity-90 transition-opacity"
        >
          ▶ Start scanning
        </button>
        {pickedToday > 0 && <div className="mt-6 text-sm text-tt-muted">{pickedToday} {pickedToday === 1 ? 'box' : 'boxes'} picked this session</div>}
      </div>
    );
  }

  const unbound: MissingOrder[] = box
    ? (box.missing_orders?.length ? box.missing_orders : box.missing_order_ids.map((id) => ({ order_id: id, listing_name: null, seller_sku: null })))
    : [];
  const sku = box && screen === 'pick' ? box.skus[activeIdx] : null;
  const have = sku ? counts[sku.inventory_sku_id] ?? 0 : 0;
  const skuDone = sku ? have >= sku.required_qty : false;

  // ── focus-mode overlay (covers the tab nav) ──
  return (
    <div className="fixed inset-0 z-50 w-screen max-w-full bg-tt-bg text-tt-text flex flex-col select-none overflow-x-hidden">
      {/* hidden scanner sink — reuses the always-focused input + Enter mechanism.
          inputMode="none" keeps the input FOCUSED (so the hardware scanner's characters +
          Enter still land here) while telling the browser NOT to raise the on-screen keyboard.
          The picker never types by hand. autoComplete/correct/capitalize off avoid any
          suggestion bar. (If a device still raises the keyboard, the fallback is a
          document-level keydown capture with no focused field — not needed unless this fails.) */}
      <input
        ref={inputRef} value={value} onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onScan(); } }}
        inputMode="none"
        autoComplete="off" autoCorrect="off" autoCapitalize="none" spellCheck={false}
        className="absolute w-px h-px opacity-0 pointer-events-none" aria-hidden
      />

      {/* Hold-to-exit ✕ (tap-and-hold ~0.9s, not a single tap) */}
      <button
        onPointerDown={beginHold} onPointerUp={cancelHold} onPointerLeave={cancelHold} onPointerCancel={cancelHold}
        title="Hold to exit"
        className="absolute top-4 right-4 z-20 w-14 h-14 rounded-full border border-tt-border bg-tt-card flex items-center justify-center text-tt-muted overflow-hidden"
      >
        <span
          className="absolute inset-0 rounded-full bg-tt-red/30"
          style={{ transform: holding ? 'scale(1)' : 'scale(0)', transition: holding ? 'transform 0.9s linear' : 'transform 0s' }}
        />
        <span className="relative text-xl">✕</span>
      </button>

      <div className={`flex-1 min-h-0 w-full flex flex-col items-center p-4 overflow-x-hidden overflow-y-auto ${screen === 'pick' ? '' : 'justify-center'}`}>

        {/* READY */}
        {screen === 'ready' && (
          <div className="w-full max-w-sm mx-auto px-5 text-center">
            <div className="mx-auto w-40 h-40 max-w-[70vw] max-h-[70vw] rounded-3xl border-4 border-tt-cyan/40 flex items-center justify-center animate-pulse">
              <span className="text-tt-cyan text-6xl">⤢</span>
            </div>
            <div className="mt-8 text-2xl font-bold break-words">Ready to scan</div>
            <div className="mt-1 text-tt-muted break-words">Scan a shipping label to load the box</div>
            {loading && <div className="mt-4 text-tt-cyan font-medium break-words">Loading box…</div>}
            {err && <div className="mt-4 text-tt-red font-semibold break-words">{err}</div>}
            <div className="mt-10 text-sm text-tt-muted break-words">{pickedToday} {pickedToday === 1 ? 'box' : 'boxes'} picked today</div>
          </div>
        )}

        {/* ALERT — unbound orders (do NOT pick) */}
        {screen === 'alert' && box && (
          <div className="w-full max-w-md mx-auto px-4 text-center">
            <div className="text-tt-red text-6xl mb-3">⚠</div>
            <div className="text-2xl font-extrabold text-tt-red break-words">Heads up — {unbound.length} unrecorded order{unbound.length === 1 ? '' : 's'}</div>
            <div className="mt-2 text-tt-muted break-words">This box has order{unbound.length === 1 ? '' : 's'} with no recorded items. Do NOT pick from the screen — set the label aside and flag it.</div>
            <div className="mt-6 flex flex-col gap-3 text-left">
              {unbound.map((o) => (
                <div key={o.order_id} className="rounded-xl border-2 border-tt-red/50 bg-tt-red/10 p-4">
                  <div className="text-lg font-bold text-tt-text break-words">{o.listing_name || 'Unknown listing'}</div>
                  <div className="text-sm text-tt-muted mt-1 break-words">
                    Seller-SKU <span className="font-mono text-tt-text break-all">{o.seller_sku || '—'}</span> · order <span className="font-mono break-all">{o.order_id}</span>
                  </div>
                </div>
              ))}
            </div>
            <button onClick={backToReady} className="mt-8 w-full py-5 rounded-2xl bg-tt-red text-white text-xl font-extrabold cursor-pointer hover:opacity-90">
              Set aside &amp; scan next
            </button>
          </div>
        )}

        {/* EMPTY — nothing to pack (all excluded) */}
        {screen === 'empty' && box && (
          <div className="w-full max-w-sm mx-auto px-5 text-center">
            <div className="text-tt-red text-6xl mb-3">🚫</div>
            <div className="text-2xl font-extrabold break-words">Nothing to pack</div>
            <div className="mt-2 text-tt-muted break-words">Every order in this box is do-not-pack (cancelled / on-hold / already shipped). Set the label aside.</div>
            <button onClick={backToReady} className="mt-8 w-full py-5 rounded-2xl bg-tt-red text-white text-xl font-extrabold cursor-pointer hover:opacity-90">
              Set aside &amp; scan next
            </button>
          </div>
        )}

        {/* PICK — one SKU per screen; hero fills the viewport, controls pinned at the bottom */}
        {screen === 'pick' && box && sku && (
          <div className="flex-1 min-h-0 w-full max-w-2xl flex flex-col">
            {/* progress dots (tappable) — compact, top */}
            <div className="shrink-0 flex flex-wrap justify-center gap-2 pb-3">
              {box.skus.map((s, i) => {
                const c = (counts[s.inventory_sku_id] ?? 0) >= s.required_qty;
                return (
                  <button
                    key={s.inventory_sku_id} onClick={() => setActiveIdx(i)}
                    className={`w-3.5 h-3.5 rounded-full transition-colors ${i === activeIdx ? 'ring-2 ring-offset-2 ring-offset-tt-bg ring-tt-cyan' : ''} ${c ? 'bg-tt-green' : 'bg-tt-border'}`}
                    aria-label={`SKU ${i + 1}`}
                  />
                );
              })}
            </div>

            {/* HERO — grows to fill all remaining height. Photo fills it, or (no photo) the
                big SKU number fills the SAME space, scaling with the viewport. Tap = grab one. */}
            <button onClick={() => grab(sku)} disabled={skuDone}
              className="relative flex-1 min-h-0 w-full rounded-3xl border-2 border-tt-border bg-tt-card overflow-hidden flex flex-col items-center justify-center cursor-pointer disabled:cursor-default">
              {sku.thumbnail_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={sku.thumbnail_url} alt="" className="absolute inset-0 w-full h-full object-cover" onError={(e) => { e.currentTarget.style.display = 'none'; }} />
              ) : (
                <div className="flex flex-col items-center justify-center px-4 text-center">
                  <div className="font-mono font-bold text-tt-text leading-none" style={{ fontSize: 'clamp(4rem, 26vw, 10rem)' }}>#{sku.sku_number ?? '?'}</div>
                  <div className="mt-4 font-semibold text-tt-text break-words leading-tight" style={{ fontSize: 'clamp(1.1rem, 4.5vw, 2rem)' }}>{sku.title}</div>
                </div>
              )}
              {justDone && skuDone && (
                <div className="absolute inset-0 bg-tt-green/90 flex items-center justify-center text-black font-bold" style={{ fontSize: 'clamp(5rem, 30vw, 12rem)' }}>✓</div>
              )}
            </button>

            {/* photo caption: number + title (only when the PHOTO is the hero) */}
            {sku.thumbnail_url && (
              <div className="shrink-0 text-center pt-2">
                <span className="font-mono text-4xl font-extrabold text-tt-text align-middle">#{sku.sku_number ?? '?'}</span>
                <span className="ml-3 text-lg font-semibold text-tt-text break-words align-middle">{sku.title}</span>
              </div>
            )}

            {/* controls — compact, pinned bottom */}
            <div className="shrink-0 pt-3">
              <div className={`text-center text-2xl font-extrabold ${skuDone ? 'text-tt-green' : 'text-tt-text'}`}>{have} / {sku.required_qty} grabbed</div>
              <button onClick={() => grab(sku)} disabled={skuDone}
                className={`mt-2 w-full py-4 rounded-2xl text-xl font-extrabold transition-opacity ${skuDone ? 'bg-tt-card-hover text-tt-muted cursor-default' : 'bg-tt-green text-black cursor-pointer hover:opacity-90'}`}>
                {skuDone ? '✓ Complete' : 'Grab one'}
              </button>
              <div className="mt-3 flex items-center justify-between gap-2">
                <button onClick={() => setActiveIdx((i) => Math.max(0, i - 1))} disabled={activeIdx === 0}
                  className="shrink-0 px-4 py-3 rounded-xl border border-tt-border text-tt-text disabled:opacity-40 cursor-pointer">‹ Back</button>
                <span className="flex-1 min-w-0 truncate text-center text-xs text-tt-muted">SKU {activeIdx + 1} of {box.skus.length} · {pickedUnits}/{totalUnits} units</span>
                <button onClick={() => setActiveIdx((i) => Math.min(box.skus.length - 1, i + 1))} disabled={activeIdx === box.skus.length - 1}
                  className="shrink-0 px-4 py-3 rounded-xl border border-tt-border text-tt-text disabled:opacity-40 cursor-pointer">Next ›</button>
              </div>
              <div className="mt-3 flex items-center justify-between gap-3">
                <button onClick={() => (anyPicked ? setAbandon({ scan: null }) : backToReady())} className="text-sm text-tt-muted underline cursor-pointer">New label</button>
                {allComplete && (
                  <button onClick={() => enterFinish(box)} className="px-6 py-3 rounded-xl bg-tt-cyan text-black font-bold cursor-pointer hover:opacity-90">Finish box ›</button>
                )}
              </div>
            </div>
          </div>
        )}

        {/* FINISH */}
        {screen === 'finish' && (
          <div className="w-full max-w-sm mx-auto px-5 text-center">
            <div className="text-tt-green text-7xl mb-3">✓</div>
            <div className="text-3xl font-extrabold break-words">Box picked</div>
            <div className="mt-2 text-lg text-tt-muted break-words">Put all items on the rack with the shipping label.</div>
            <button onClick={backToReady} className="mt-8 w-full py-5 rounded-2xl bg-tt-green text-black text-xl font-extrabold cursor-pointer hover:opacity-90">
              Scan next label
            </button>
          </div>
        )}
      </div>

      {/* abandon-confirm (mid-pick new label / scan) */}
      {abandon && (
        <div className="absolute inset-0 bg-black/60 flex items-center justify-center p-6 z-30">
          <div className="bg-tt-card border border-tt-border rounded-2xl p-6 max-w-sm w-full text-center">
            <div className="text-lg font-bold text-tt-text">Abandon this box?</div>
            <div className="mt-2 text-sm text-tt-muted">{pickedUnits} item{pickedUnits === 1 ? '' : 's'} already grabbed — starting a new label discards this progress.</div>
            <div className="mt-5 flex gap-3">
              <button onClick={() => setAbandon(null)} className="flex-1 py-3 rounded-xl border border-tt-border text-tt-text cursor-pointer">Keep picking</button>
              <button
                onClick={() => { const s = abandon.scan; setAbandon(null); if (s) loadBox(s); else backToReady(); }}
                className="flex-1 py-3 rounded-xl bg-tt-red text-white font-bold cursor-pointer"
              >Discard &amp; continue</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
