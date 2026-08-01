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
import { createPortal } from 'react-dom';
import { useStores } from '@/hooks/useStores';
import { useEmployees } from '@/hooks/useEmployees';
import { printOrderTickets, type PickTicketGroup } from '@/lib/shipping/pickTickets';

interface BoxSku {
  inventory_sku_id: string;
  sku_number: number | null;
  title: string;
  barcode: string | null;
  thumbnail_url: string | null;
  required_qty: number;
}
interface MissingOrder { order_id: string; listing_name: string | null; seller_sku: string | null; }
interface CatalogOrder { order_id: string; listing_name: string | null; seller_sku: string | null; qty: number; }
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
  catalog_orders?: CatalogOrder[];                                   // pickable catalog lines (third state)
  order_types?: Record<string, 'bound' | 'unbound_auction' | 'catalog'>;
  missing_order_ids: string[];                                       // UNBOUND-AUCTION only
  missing_orders?: MissingOrder[];                                   // UNBOUND-AUCTION only → set-aside alert
  excluded?: { order_id: string; reason: string; skus: string[] }[];
  excluded_count?: number;
  status_unverified?: boolean;
  already_verified_at: string | null;
}

type Screen = 'ready' | 'alert' | 'pick' | 'finish' | 'empty';

// A pickable line is EITHER a bound-auction internal SKU or a CATALOG order. Both flow through
// the same one-per-screen pick UI; catalog lines are visibly tagged so a picker can tell them
// apart from internal-SKU auction items and never mistakes one for the other.
type PickLine =
  | { kind: 'sku'; key: string; sku_number: number | null; title: string; barcode: string | null; thumbnail_url: string | null; required_qty: number }
  | { kind: 'catalog'; key: string; order_id: string; listing_name: string; seller_sku: string; required_qty: number };

const buildPickLines = (b: Box): PickLine[] => [
  ...b.skus.map((s): PickLine => ({ kind: 'sku', key: s.inventory_sku_id, sku_number: s.sku_number, title: s.title, barcode: s.barcode, thumbnail_url: s.thumbnail_url, required_qty: s.required_qty })),
  ...(b.catalog_orders ?? []).map((c): PickLine => ({ kind: 'catalog', key: `cat:${c.order_id}`, order_id: c.order_id, listing_name: c.listing_name || 'Catalog item', seller_sku: c.seller_sku || '', required_qty: c.qty || 1 })),
];

const firstUnpickedIdx = (lines: PickLine[], c: Record<string, number>) => {
  const i = lines.findIndex((l) => (c[l.key] ?? 0) < l.required_qty);
  return i === -1 ? 0 : i;
};

// Small in-modal picker dropdown — replaces the native <select>, whose options menu on
// mobile opened detached toward the top-left of the screen. This opens in-flow directly
// below the field (so it stays inside the modal and viewport), scrolls internally when the
// list is long, highlights the selection, closes on pick / outside-tap / Escape, and is
// keyboard accessible (Arrow/Home/End/Enter/Escape via aria-activedescendant). Presentational
// only: same selected id in, same id out — no effect on filtering or the picker flow.
function PickerCombobox({
  options,
  value,
  onChange,
  placeholder,
}: {
  options: { id: string; name: string }[];
  value: string;
  onChange: (id: string) => void;
  placeholder: string;
}) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const selected = options.find((o) => o.id === value) ?? null;

  // Close when tapping/clicking anywhere outside the field + list.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [open]);

  // Keep the highlighted row visible while arrow-navigating a long, internally-scrolling list.
  useEffect(() => {
    if (!open) return;
    document.getElementById(`picker-opt-${options[highlight]?.id ?? ''}`)?.scrollIntoView({ block: 'nearest' });
  }, [open, highlight, options]);

  const choose = (id: string) => { onChange(id); setOpen(false); };

  // Open with the current selection (or first row) highlighted — set in the handler, not an
  // effect, so there's no cascading render.
  const openList = () => {
    const i = options.findIndex((o) => o.id === value);
    setHighlight(i >= 0 ? i : 0);
    setOpen(true);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openList(); }
      return;
    }
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); setHighlight((h) => Math.min(options.length - 1, h + 1)); break;
      case 'ArrowUp': e.preventDefault(); setHighlight((h) => Math.max(0, h - 1)); break;
      case 'Home': e.preventDefault(); setHighlight(0); break;
      case 'End': e.preventDefault(); setHighlight(options.length - 1); break;
      case 'Enter':
      case ' ': { e.preventDefault(); const o = options[highlight]; if (o) choose(o.id); break; }
      case 'Escape': e.preventDefault(); setOpen(false); break;
      case 'Tab': setOpen(false); break;
      default: break;
    }
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        id="picker-select"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls="picker-listbox"
        aria-activedescendant={open && options[highlight] ? `picker-opt-${options[highlight].id}` : undefined}
        onClick={() => (open ? setOpen(false) : openList())}
        onKeyDown={onKeyDown}
        disabled={options.length === 0}
        className="w-full min-h-[52px] flex items-center justify-between gap-2 bg-tt-card border border-tt-border rounded-xl px-4 py-3 text-base text-left cursor-pointer disabled:opacity-60"
      >
        <span className={selected ? 'text-tt-text' : 'text-tt-muted'}>{selected ? selected.name : placeholder}</span>
        <span className={`shrink-0 text-tt-muted transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden>▾</span>
      </button>
      {open && options.length > 0 && (
        <ul
          id="picker-listbox"
          role="listbox"
          className="mt-1 max-h-60 overflow-y-auto rounded-xl border border-tt-border bg-tt-card py-1"
        >
          {options.map((o, i) => {
            const isSel = o.id === value;
            const isHi = i === highlight;
            return (
              <li
                key={o.id}
                id={`picker-opt-${o.id}`}
                role="option"
                aria-selected={isSel}
                onClick={() => choose(o.id)}
                onPointerEnter={() => setHighlight(i)}
                className={`px-4 py-3 min-h-[44px] flex items-center justify-between gap-2 cursor-pointer ${isHi ? 'bg-tt-card-hover' : ''}`}
              >
                <span className="break-words text-tt-text">{o.name}</span>
                {isSel && <span className="shrink-0 text-tt-green" aria-hidden>✓</span>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

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
  // Picker gate: who is packing this session. Selected in a small modal that the existing
  // "Start scanning" button opens; UI-only (no persistence), read by focus mode to show it.
  const [pickerId, setPickerId] = useState('');
  const [pickerModalOpen, setPickerModalOpen] = useState(false);
  const { data: storesData } = useStores();
  const activeStore = storesData?.activeStore ?? 'all';
  // Eligible pickers: role 'fulfillment' AND status active/probation (no hosts, no former).
  const { employees } = useEmployees();
  const pickers = useMemo(
    () => employees.filter((e) => e.role?.trim().toLowerCase() === 'fulfillment' && (e.status === 'active' || e.status === 'probation')),
    [employees],
  );
  const pickerName = useMemo(() => employees.find((e) => e.id === pickerId)?.name ?? '', [employees, pickerId]);
  // Tracking coverage for the active store (label-barcode scanning depends on stored tracking).
  const [coverage, setCoverage] = useState<null | { total: number; with_tracking: number; missing_tracking: number }>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  // Resume cursor (order_id keyset) that survives across button clicks: a throttled/partial sweep
  // saves its next_after here so the next Fetch continues from there rather than restarting at zero
  // (which would re-examine everything and re-trigger the same throttle).
  const syncCursorRef = useRef<string | null>(null);
  // Pick-ticket batch: age window + the route's included/excluded counts (always surfaced so we
  // never show a bare "included" number). Fetched on the idle view; reused verbatim on print.
  const [ticketDays, setTicketDays] = useState<'1' | '3' | '7' | 'all'>('3');
  const [ticketLoading, setTicketLoading] = useState(false);
  const [ticketInfo, setTicketInfo] = useState<null | {
    groups: PickTicketGroup[];
    days: string | number;
    included_boxes: number;
    included_orders: number;
    excluded_boxes: number;
    excluded_orders: number;
    no_timestamp_orders: number;
  }>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const confirmedRef = useRef(false); // fire /confirm + count once per box
  // Pick start time = the instant the current box loaded. Set on every successful box load
  // (so a different box resets it), preserved across "Change picker" (same loaded box), and
  // cleared when returning to Ready. Sent on confirm to record true per-box pick duration.
  const pickStartedAtRef = useRef<string | null>(null);

  const focusInput = useCallback(() => { requestAnimationFrame(() => inputRef.current?.focus()); }, []);
  // Keep the scanner aimed at the hidden input while in focus mode — but NOT while the picker
  // gate is open (the modal owns focus then). When the gate closes this re-runs and re-arms the
  // scanner, which is what "activates" scanning the moment a picker is chosen.
  useEffect(() => { if (focus && !pickerModalOpen) focusInput(); }, [focus, screen, box, pickerModalOpen, focusInput]);

  // Leaving the tab (unmount) while still full-screen → drop out of fullscreen. Self-contained
  // (no external deps) so it runs exactly once on unmount.
  useEffect(() => () => {
    const d = document as Document & { webkitExitFullscreen?: () => Promise<void> | void; webkitFullscreenElement?: Element | null };
    if (d.fullscreenElement || d.webkitFullscreenElement) { try { (d.exitFullscreen ?? d.webkitExitFullscreen)?.call(d); } catch { /* ignore */ } }
  }, []);

  const pickLines = useMemo(() => (box ? buildPickLines(box) : []), [box]);
  const anyPicked = useMemo(() => Object.values(counts).some((v) => v > 0), [counts]);
  const pickedUnits = useMemo(() => Object.values(counts).reduce((a, b) => a + b, 0), [counts]);
  const totalUnits = useMemo(() => pickLines.reduce((a, l) => a + l.required_qty, 0), [pickLines]);
  const allComplete = useMemo(
    () => pickLines.length > 0 && pickLines.every((l) => (counts[l.key] ?? 0) >= l.required_qty),
    [pickLines, counts],
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
      pickStartedAtRef.current = new Date().toISOString(); // box loaded → start the pick clock (resets per box)
      // Only UNBOUND-AUCTION orders trigger the set-aside alert (mixed box → the warning WINS).
      // Catalog orders are pickable and never suppress a real unresolved warning.
      const unbound = (b.missing_orders?.length ?? 0) > 0 || b.missing_order_ids.length > 0;
      const lines = buildPickLines(b);
      if (unbound) setScreen('alert');            // any unbound-auction → set aside, never pick
      else if (lines.length === 0) setScreen('empty'); // all do-not-pack / nothing to pick
      else { setScreen('pick'); setActiveIdx(firstUnpickedIdx(lines, {})); }
    } catch {
      setErr('Network error loading the box'); setScreen('ready');
    } finally {
      setLoading(false); focusInput();
    }
  }

  function onScan() {
    const v = value.trim(); setValue('');
    if (pickerModalOpen) return; // picker gate open → swallow the scan (value already cleared)
    focusInput();
    if (!v || loading) return;
    if (screen === 'pick' && anyPicked) { setAbandon({ scan: v }); return; } // guard mid-pick
    loadBox(v);
  }

  // ── pick actions ──
  function grab(line: PickLine) {
    if (!box) return;
    const have = counts[line.key] ?? 0;
    if (have >= line.required_qty) return;
    const next = have + 1;
    const nc = { ...counts, [line.key]: next };
    setCounts(nc);
    if (next >= line.required_qty) {
      setJustDone(true);
      window.setTimeout(() => {
        setJustDone(false);
        const complete = pickLines.every((l) => (nc[l.key] ?? 0) >= l.required_qty);
        if (complete) enterFinish(box);
        else setActiveIdx(firstUnpickedIdx(pickLines, nc));
      }, 550);
    }
  }

  function enterFinish(b: Box) {
    setScreen('finish');
    if (!confirmedRef.current) {
      confirmedRef.current = true;
      setPickedToday((n) => n + 1);
      // Preserve the existing verify write — the box records as verified on finish. Now also
      // sends the selected picker so the completion is attributed (Phase 1). The picker is
      // gated at "Start scanning", so pickerId is set here; the server validates + falls back
      // to Unassigned if it is ever missing/invalid (never blocks the write).
      fetch('/api/shipping/confirm', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          group_key: b.group_key,
          order_ids: b.order_ids,
          picker_employee_id: pickerId || undefined,
          pick_started_at: pickStartedAtRef.current || undefined,
        }),
      }).catch(() => {});
    }
  }

  const backToReady = () => { setBox(null); setCounts({}); setErr(null); pickStartedAtRef.current = null; setScreen('ready'); focusInput(); };

  // ── true-fullscreen takeover (hides browser chrome: URL bar, etc.) ──
  // MUST be invoked from the tap handler — browsers block programmatic fullscreen outside a user
  // gesture. Denial is non-fatal: focus mode still works, just with the browser chrome visible.
  const enterFullscreen = () => {
    const el = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };
    const req = el.requestFullscreen ?? el.webkitRequestFullscreen;
    try { const p = req?.call(el); if (p && typeof (p as Promise<void>).catch === 'function') (p as Promise<void>).catch(() => {}); } catch { /* denied — continue windowed */ }
  };
  const exitFullscreen = () => {
    const d = document as Document & { webkitExitFullscreen?: () => Promise<void> | void; webkitFullscreenElement?: Element | null };
    if (!(d.fullscreenElement || d.webkitFullscreenElement)) return;
    const ex = d.exitFullscreen ?? d.webkitExitFullscreen;
    try { const p = ex?.call(d); if (p && typeof (p as Promise<void>).catch === 'function') (p as Promise<void>).catch(() => {}); } catch { /* ignore */ }
  };

  // ── focus enter / hold-to-exit ──
  const startScanning = () => { enterFullscreen(); setFocus(true); setBox(null); setCounts({}); setErr(null); setScreen('ready'); focusInput(); };
  // "Start scanning" now enters the full-screen scanner FIRST, then gates it behind the picker
  // modal — the picker is chosen over the (blurred) scanner, never before entering fullscreen.
  const beginSession = () => { startScanning(); setPickerModalOpen(true); };
  const beginHold = () => { setHolding(true); holdTimer.current = setTimeout(() => { setHolding(false); exitFullscreen(); setFocus(false); setPickerModalOpen(false); backToReady(); }, 900); };
  const cancelHold = () => { setHolding(false); if (holdTimer.current) clearTimeout(holdTimer.current); };

  // Picker chosen → drop the gate. We're already in focus mode (Start scanning entered it, or
  // this is a mid-session "Change picker"), so just close the modal; the refocus effect re-arms
  // the scanner. Clearing value discards any stray characters typed while the gate was up.
  const confirmPicker = () => { if (!pickerId) return; setValue(''); setPickerModalOpen(false); };
  // Cancel the gate. With NO picker chosen this backs fully out of the session (exit fullscreen +
  // reset temp state) so scanning never begins unattributed; with a picker already set (e.g. from
  // "Change picker"), it just closes and keeps the session running.
  const dismissPicker = () => { setPickerModalOpen(false); if (!pickerId) { exitFullscreen(); setFocus(false); backToReady(); } };

  const storeName = activeStore === 'all'
    ? 'All stores'
    : (storesData?.stores?.find((s) => s.id === activeStore)?.name ?? 'this store');
  const scopeLabel = ticketInfo
    ? (ticketInfo.days === 'all' ? 'all dates' : `last ${ticketInfo.days} days`)
    : (ticketDays === 'all' ? 'all dates' : `last ${ticketDays} days`);

  // Load the pack-ready batch + its included/excluded counts (READ-ONLY, our DB only). Runs on the
  // idle view so the counts (and the "older boxes hidden" caveat) are visible BEFORE printing.
  const loadTickets = useCallback(async () => {
    setTicketLoading(true); setErr(null);
    try {
      const params = new URLSearchParams();
      if (activeStore && activeStore !== 'all') params.set('store_id', activeStore);
      params.set('days', ticketDays);
      const res = await fetch(`/api/shipping/pick-tickets?${params.toString()}`);
      if (!res.ok) { setTicketInfo(null); setErr('Failed to load pick tickets'); return; }
      const json = await res.json();
      setTicketInfo({
        groups: (json.groups ?? []) as PickTicketGroup[],
        days: json.days ?? ticketDays,
        included_boxes: json.included_boxes ?? 0,
        included_orders: json.included_orders ?? 0,
        excluded_boxes: json.excluded_boxes ?? 0,
        excluded_orders: json.excluded_orders ?? 0,
        no_timestamp_orders: json.no_timestamp_orders ?? 0,
      });
    } catch {
      setTicketInfo(null); setErr('Failed to load pick tickets');
    } finally {
      setTicketLoading(false);
    }
  }, [activeStore, ticketDays]);

  useEffect(() => { if (!focus) loadTickets(); }, [focus, loadTickets]);

  // Confirm with the REAL route numbers before opening the print window (never a bare included
  // count; call out excluded boxes + a large-batch warning). Reuses the already-fetched groups so
  // what the operator confirms is exactly what prints.
  function printTickets() {
    if (!ticketInfo) return;
    const { groups, included_boxes, included_orders, excluded_boxes, no_timestamp_orders } = ticketInfo;
    if (!groups.length) { setErr('No pack-ready orders in this window to print'); return; }
    let msg = `Print ${included_boxes} ticket${included_boxes === 1 ? '' : 's'} `
      + `(${included_orders} order${included_orders === 1 ? '' : 's'}) for ${storeName} — ${scopeLabel}?`;
    if (excluded_boxes > 0) {
      msg += `\n\n${excluded_boxes.toLocaleString()} older box${excluded_boxes === 1 ? '' : 'es'} excluded.`;
    }
    if (no_timestamp_orders > 0 && ticketInfo.days !== 'all') {
      msg += `\n${no_timestamp_orders} order${no_timestamp_orders === 1 ? '' : 's'} with no date not included.`;
    }
    if (included_boxes > 200) {
      msg += `\n\n⚠ Large batch: ${included_boxes.toLocaleString()} tickets will print.`;
    }
    if (!window.confirm(msg)) return;
    printOrderTickets(groups);
  }

  // ── tracking coverage (staleness) — visible without clicking; refreshed after a sync ──
  const loadCoverage = useCallback(async () => {
    if (!activeStore || activeStore === 'all') { setCoverage(null); return; }
    try {
      const res = await fetch(`/api/shipping/sync-tracking?store_id=${encodeURIComponent(activeStore)}`);
      setCoverage(res.ok ? await res.json() : null);
    } catch { setCoverage(null); }
  }, [activeStore]);
  useEffect(() => { if (!focus) loadCoverage(); }, [focus, loadCoverage]);

  // Recover tracking for the active store: loop the bounded route until done, showing progress.
  async function syncTracking() {
    if (!activeStore || activeStore === 'all') { setSyncMsg('Pick a specific store first.'); return; }
    setSyncing(true); setErr(null);
    // Resume from where a prior partial/throttled run stopped, if any.
    let after: string | null = syncCursorRef.current;
    setSyncMsg(after ? 'Resuming label tracking…' : 'Fetching label tracking…');
    try {
      // Count from the route's ACTUAL fields (filled + corrected). The sweep is inherently multi-pass
      // (~9.7k orders / ~4–5 invocations), chained here via next_after; show the pass so it never
      // looks stalled. A partial/error result RETURNS what it wrote — we report it, never zero it.
      let filled = 0; let corrected = 0; let noLabel = 0; let guard = 0; let pass = 0;
      const soFar = () => `Filled ${filled} · corrected ${corrected}`;
      for (;;) {
        pass++;
        let res: Response;
        try {
          res = await fetch('/api/shipping/sync-tracking', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ store_id: activeStore, dry_run: false, after }),
          });
        } catch {
          syncCursorRef.current = after;  // save resume point — writes so far persisted
          setSyncMsg(filled + corrected > 0
            ? `${soFar()} so far, then lost connection. Click Fetch to resume.`
            : 'Couldn’t reach the server — check your connection and try again.');
          await loadCoverage(); return;
        }
        if (!res.ok) {
          // Hard error. Report accumulated progress from prior passes — never discard it. The write
          // gate is gone, so a 409 "paused" can't happen here. Cursor saved so a click resumes.
          syncCursorRef.current = after;
          const body = await res.json().catch(() => ({} as { error?: string }));
          const lead = filled + corrected > 0 ? `${soFar()} so far, then ` : '';
          if (res.status === 500) setSyncMsg(`${lead}failed: ${body.error ?? 'server error'}.${lead ? ' Click Fetch to resume.' : ''}`);
          else setSyncMsg(`${lead}failed (${res.status}).${lead ? ' Click Fetch to resume.' : ' Try again.'}`);
          await loadCoverage(); return;
        }
        const j: { filled?: number; corrected?: number; no_label?: number; examined?: number; remaining?: number;
                   done?: boolean; partial?: boolean; stopped_reason?: string | null; next_after?: string | null } = await res.json();
        filled += j.filled ?? 0; corrected += j.corrected ?? 0; noLabel = j.no_label ?? noLabel;
        const remaining = j.remaining ?? 0;
        if (j.partial) {
          // Route stopped on a recoverable error (e.g. a TikTok throttle) AFTER writing. Progress is
          // saved + resumable — stop auto-looping so we don't hammer the failing chunk; user resumes.
          syncCursorRef.current = j.next_after ?? after;
          const kind = /frequent|429|rate|too many/i.test(j.stopped_reason ?? '') ? 'rate limit' : 'error';
          setSyncMsg(`${soFar()} — paused (${kind}), ${remaining} left. Click Fetch to resume.`);
          await loadCoverage(); return;
        }
        const estTotal = pass + Math.ceil(remaining / Math.max(1, j.examined ?? 1));
        setSyncMsg(`Pass ${pass} of ~${estTotal} · ${soFar()}${remaining ? ` · ${remaining} to check…` : ''}`);
        if (j.done) { syncCursorRef.current = null; break; }                       // clean finish
        if (!j.next_after || ++guard > 50) { syncCursorRef.current = j.next_after ?? after; break; }
        after = j.next_after;
      }
      await loadCoverage();
      const doneClean = syncCursorRef.current === null;
      setSyncMsg(`${soFar()}${noLabel ? ` · ${noLabel} have no label yet` : ''}.${doneClean ? ' Done.' : ' Click Fetch to continue.'}`);
    } catch {
      setSyncMsg('Sync failed — try again.');
    } finally {
      setSyncing(false);
    }
  }

  // ── picker-selection modal (small, opened by "Start scanning"; also by "Change picker") ──
  const pickerModal = pickerModalOpen ? (
    <div className="fixed inset-0 z-[210] bg-black/70 backdrop-blur-md flex items-center justify-center p-4 sm:p-6">
      <div className="bg-tt-card border border-tt-border rounded-2xl p-6 max-w-sm w-full">
        <div className="text-lg font-bold text-tt-text">Who&apos;s picking?</div>
        <label htmlFor="picker-select" className="block text-xs uppercase tracking-wide text-tt-muted mt-4 mb-2">Picker</label>
        <PickerCombobox
          options={pickers}
          value={pickerId}
          onChange={setPickerId}
          placeholder="Select your name"
        />
        {pickers.length === 0 && (
          <div className="mt-3 text-sm text-tt-muted">No active fulfillment employees found. Add one with role “Fulfillment” in the Team tab.</div>
        )}
        <div className="mt-5 flex gap-3">
          <button onClick={dismissPicker} className="flex-1 min-h-[44px] py-3 rounded-xl border border-tt-border text-tt-text cursor-pointer">Cancel</button>
          <button
            onClick={confirmPicker}
            disabled={!pickerId}
            className={`flex-1 min-h-[44px] py-3 rounded-xl font-bold transition-opacity ${pickerId ? 'bg-tt-green text-black cursor-pointer hover:opacity-90' : 'bg-tt-card-hover text-tt-muted cursor-not-allowed'}`}
          >Continue to scanning</button>
        </div>
      </div>
    </div>
  ) : null;

  // ── idle (tab) view ──
  if (!focus) {
    return (
      <div>
        <div className="text-xl font-bold">Packing station</div>
        <div className="text-sm text-tt-muted mt-1 mb-6">Print your order-id pick tickets, then scan them to pick each box. Full-screen, scanner-driven.</div>
        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={beginSession}
            className="w-full sm:w-auto min-h-[56px] px-8 py-5 rounded-2xl bg-tt-green text-black text-xl font-extrabold cursor-pointer hover:opacity-90 transition-opacity shadow-lg"
          >
            ▶ Start scanning
          </button>
          <button
            onClick={syncTracking}
            disabled={syncing || activeStore === 'all'}
            title="Recover tracking numbers from TikTok so label scanning works — run after buying labels"
            className="flex-1 sm:flex-none min-h-[44px] px-6 py-4 rounded-2xl border border-tt-border text-tt-text text-base font-semibold cursor-pointer hover:bg-tt-card-hover transition-colors disabled:opacity-50"
          >
            {syncing ? 'Fetching…' : '🔄 Fetch label tracking'}
          </button>
          <button
            onClick={printTickets}
            disabled={ticketLoading || !ticketInfo || ticketInfo.included_boxes === 0}
            className="flex-1 sm:flex-none min-h-[44px] px-6 py-4 rounded-2xl border border-tt-border text-tt-text text-base font-semibold cursor-pointer hover:bg-tt-card-hover transition-colors disabled:opacity-50"
          >
            {ticketLoading ? 'Loading…' : '🖨 Print pick tickets'}
          </button>
          <label className="flex items-center gap-2 text-sm text-tt-muted w-full sm:w-auto">
            <span>Age</span>
            <select
              value={ticketDays}
              onChange={(e) => setTicketDays(e.target.value as '1' | '3' | '7' | 'all')}
              className="flex-1 sm:flex-none min-h-[44px] px-3 py-2 rounded-xl bg-tt-card border border-tt-border text-tt-text cursor-pointer"
            >
              <option value="1">Last 1 day</option>
              <option value="3">Last 3 days</option>
              <option value="7">Last 7 days</option>
              <option value="all">All dates</option>
            </select>
          </label>
        </div>
        {/* Tracking coverage — staleness visible without clicking; label scanning needs stored tracking. */}
        {activeStore !== 'all' && (
          <div className="mt-3 text-sm">
            {syncMsg ? (
              <span className={syncing ? 'text-tt-cyan' : 'text-tt-text'}>{syncMsg}</span>
            ) : coverage ? (
              coverage.missing_tracking > 0 ? (
                <span className="text-tt-red font-semibold">{coverage.missing_tracking.toLocaleString()} order{coverage.missing_tracking === 1 ? '' : 's'} missing tracking — fetch before packing</span>
              ) : (
                <span className="text-tt-muted">{coverage.with_tracking.toLocaleString()} of {coverage.total.toLocaleString()} orders have tracking</span>
              )
            ) : (
              <span className="text-tt-muted">Checking tracking coverage…</span>
            )}
          </div>
        )}
        {/* ALWAYS surface what's included AND what's hidden — never a bare included count. */}
        <div className="mt-3 text-sm text-tt-muted">
          {ticketLoading || !ticketInfo ? (
            'Counting pack-ready boxes…'
          ) : (
            <>
              <span className="text-tt-text font-semibold">
                {ticketInfo.included_boxes.toLocaleString()} box{ticketInfo.included_boxes === 1 ? '' : 'es'}
              </span>
              {' '}({scopeLabel})
              {' · '}
              {ticketInfo.excluded_boxes > 0
                ? `${ticketInfo.excluded_boxes.toLocaleString()} older box${ticketInfo.excluded_boxes === 1 ? '' : 'es'} hidden`
                : 'no older boxes hidden'}
              {ticketInfo.no_timestamp_orders > 0 && (
                <> {' · '}{ticketInfo.no_timestamp_orders.toLocaleString()} order{ticketInfo.no_timestamp_orders === 1 ? '' : 's'} with no date{ticketInfo.days === 'all' ? '' : ' — not included'}</>
              )}
            </>
          )}
        </div>
        {err && <div className="mt-4 text-sm text-tt-red">{err}</div>}
        {pickedToday > 0 && <div className="mt-6 text-sm text-tt-muted">{pickedToday} {pickedToday === 1 ? 'box' : 'boxes'} picked this session</div>}
      </div>
    );
  }

  const unbound: MissingOrder[] = box
    ? (box.missing_orders?.length ? box.missing_orders : box.missing_order_ids.map((id) => ({ order_id: id, listing_name: null, seller_sku: null })))
    : [];
  const line = box && screen === 'pick' ? pickLines[activeIdx] ?? null : null;
  const have = line ? counts[line.key] ?? 0 : 0;
  const lineDone = line ? have >= line.required_qty : false;

  // ── focus-mode overlay ──
  // Rendered through a PORTAL to <body> so it escapes the tab-content stacking context (a
  // transformed/positioned ancestor was clipping/under-layering the `fixed` overlay, letting
  // the tab nav bleed through). Solid, OPAQUE bg-tt-bg fills the whole dynamic viewport at
  // z-[200] — above the app header/nav (z-50) — so nothing behind is visible or interactable.
  // Safe under SSR: the overlay only appears after a client click (focus starts false → idle view).
  if (typeof document === 'undefined') return null;
  return createPortal(
    <div
      className="fixed inset-0 z-[200] w-screen h-[100dvh] max-w-full bg-tt-bg text-tt-text flex flex-col select-none overflow-hidden"
      style={{
        paddingTop: 'env(safe-area-inset-top)',
        paddingBottom: 'env(safe-area-inset-bottom)',
        paddingLeft: 'env(safe-area-inset-left)',
        paddingRight: 'env(safe-area-inset-right)',
      }}
    >
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
        disabled={pickerModalOpen}
        autoComplete="off" autoCorrect="off" autoCapitalize="none" spellCheck={false}
        className="absolute w-px h-px opacity-0 pointer-events-none" aria-hidden
      />

      {/* Hold-to-exit control (tap-and-hold ~0.9s, not a single tap) — same handler, larger + labelled */}
      <div
        className="absolute z-20 flex flex-col items-center gap-1"
        style={{ top: 'calc(env(safe-area-inset-top) + 1rem)', right: 'calc(env(safe-area-inset-right) + 1rem)' }}
      >
        <button
          onPointerDown={beginHold} onPointerUp={cancelHold} onPointerLeave={cancelHold} onPointerCancel={cancelHold}
          title="Hold to exit"
          aria-label="Hold to exit"
          className="relative w-16 h-16 rounded-full border-2 border-tt-border-hover bg-tt-card flex items-center justify-center text-tt-text overflow-hidden active:scale-95 transition-transform"
        >
          <span
            className="absolute inset-0 rounded-full bg-tt-red/30"
            style={{ transform: holding ? 'scale(1)' : 'scale(0)', transition: holding ? 'transform 0.9s linear' : 'transform 0s' }}
          />
          <span className="relative text-2xl leading-none">✕</span>
        </button>
        <span className="text-[10px] font-semibold uppercase tracking-wider text-tt-muted pointer-events-none">Hold to exit</span>
      </div>

      <div className={`flex-1 min-h-0 w-full flex flex-col items-center overflow-x-hidden ${screen === 'pick' ? 'overflow-y-hidden p-3' : 'p-4 overflow-y-auto justify-center'}`}>

        {/* READY */}
        {screen === 'ready' && (
          <div className="w-full max-w-sm mx-auto px-5 text-center">
            <div className="mx-auto w-40 h-40 max-w-[70vw] max-h-[70vw] rounded-3xl border-4 border-tt-cyan/40 flex items-center justify-center animate-pulse">
              <span className="text-tt-cyan text-6xl">⤢</span>
            </div>
            <div className="mt-8 text-3xl font-bold break-words">Ready to scan</div>
            <div className="mt-2 text-base text-tt-muted break-words">Scan a shipping label to load the box</div>
            {pickerName && (
              <div className="mt-3 text-sm text-tt-muted break-words">
                Picking as <span className="font-semibold text-tt-text">{pickerName}</span>
                <button onClick={() => setPickerModalOpen(true)} className="ml-2 underline cursor-pointer">Change picker</button>
              </div>
            )}
            {loading && (
              <div className="mt-6 flex items-center justify-center gap-3 text-tt-cyan font-semibold text-lg break-words">
                <span className="w-5 h-5 border-2 border-tt-cyan border-t-transparent rounded-full animate-spin" />
                Loading box…
              </div>
            )}
            {err && (
              <div className="mt-6 rounded-2xl border-2 border-tt-red/50 bg-tt-red/10 px-5 py-4 text-tt-red font-semibold text-base break-words">
                <span className="mr-2" aria-hidden>⚠</span>{err}
              </div>
            )}
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
            <button onClick={backToReady} className="mt-8 w-full min-h-[56px] py-5 rounded-2xl bg-tt-red text-white text-xl font-extrabold cursor-pointer hover:opacity-90">
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
            <button onClick={backToReady} className="mt-8 w-full min-h-[56px] py-5 rounded-2xl bg-tt-red text-white text-xl font-extrabold cursor-pointer hover:opacity-90">
              Set aside &amp; scan next
            </button>
          </div>
        )}

        {/* PICK — one SKU per screen, sized to the device with dvh + flex + clamp:
            [progress dots] · [HERO photo/number — flex-1, takes only leftover space, object-contain]
            · [PINNED controls — number, count, Grab, nav; always visible, never scrolls]. */}
        {screen === 'pick' && box && line && (
          <div className="flex-1 min-h-0 w-full max-w-2xl flex flex-col gap-[clamp(0.35rem,1.4vh,0.9rem)]">
            {/* progress dots (tappable) — compact, top. Catalog lines get a square dot so a picker
                can see at a glance that the box mixes internal-SKU and catalog items. */}
            <div className="shrink-0 flex flex-wrap justify-center gap-2">
              {pickLines.map((l, i) => {
                const c = (counts[l.key] ?? 0) >= l.required_qty;
                return (
                  <button
                    key={l.key} onClick={() => setActiveIdx(i)}
                    className="p-2.5 flex items-center justify-center cursor-pointer"
                    aria-label={`Item ${i + 1}`}
                  >
                    <span className={`block w-3.5 h-3.5 transition-colors ${l.kind === 'catalog' ? 'rounded-[3px]' : 'rounded-full'} ${i === activeIdx ? 'ring-2 ring-offset-2 ring-offset-tt-bg ring-tt-cyan' : ''} ${c ? 'bg-tt-green' : 'bg-tt-border'}`} />
                  </button>
                );
              })}
            </div>

            {/* HERO — takes ONLY the leftover height. SKU line: photo or big #number. Catalog line:
                a CATALOG-tagged card with the real listing name + seller SKU (no internal #). */}
            <button onClick={() => grab(line)} disabled={lineDone}
              className="relative flex-1 min-h-0 w-full rounded-3xl border-2 border-tt-border bg-tt-card overflow-hidden flex items-center justify-center cursor-pointer disabled:cursor-default">
              {line.kind === 'sku' ? (
                line.thumbnail_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={line.thumbnail_url} alt="" className="max-w-full max-h-full object-contain" onError={(e) => { e.currentTarget.style.display = 'none'; }} />
                ) : (
                  <div className="flex flex-col items-center justify-center px-4 text-center">
                    <div className="font-mono font-bold text-tt-text leading-none" style={{ fontSize: 'clamp(3rem, 22vh, 11rem)' }}>#{line.sku_number ?? '?'}</div>
                    <div className="mt-3 font-semibold text-tt-text break-words leading-tight" style={{ fontSize: 'clamp(1rem, 4vh, 2rem)' }}>{line.title}</div>
                  </div>
                )
              ) : (
                <div className="flex flex-col items-center justify-center px-5 text-center">
                  <span className="inline-block rounded-md border-2 border-tt-cyan text-tt-cyan font-extrabold tracking-wide" style={{ fontSize: 'clamp(0.8rem,2.6vh,1.15rem)', padding: '0.15em 0.5em' }}>CATALOG ITEM</span>
                  <div className="mt-4 font-bold text-tt-text break-words leading-tight" style={{ fontSize: 'clamp(1.1rem, 4.2vh, 2.1rem)' }}>{line.listing_name}</div>
                  <div className="mt-3 text-tt-muted break-words" style={{ fontSize: 'clamp(0.9rem, 3vh, 1.4rem)' }}>Seller SKU <span className="font-mono text-tt-text break-all">{line.seller_sku || '—'}</span></div>
                </div>
              )}
              {justDone && lineDone && (
                <div className="absolute inset-0 bg-tt-green/90 flex items-center justify-center text-black font-bold" style={{ fontSize: 'clamp(4rem, 26vh, 12rem)' }}>✓</div>
              )}
            </button>

            {/* PINNED controls — reserved space, always visible, everything clamp-sized so the
                whole block scales with the device and never overflows. */}
            <div className="shrink-0 flex flex-col gap-[clamp(0.3rem,1.2vh,0.7rem)]">
              {/* line label (always pinned & visible) — internal #SKU, or the catalog listing. */}
              <div className="text-center leading-tight px-1">
                {line.kind === 'sku' ? (
                  <>
                    <span className="font-mono font-extrabold text-tt-text align-middle" style={{ fontSize: 'clamp(1.4rem, 5.5vw, 2.4rem)' }}>#{line.sku_number ?? '?'}</span>
                    <span className="ml-2 font-semibold text-tt-text break-words align-middle" style={{ fontSize: 'clamp(0.85rem, 3.4vw, 1.25rem)' }}>{line.title}</span>
                  </>
                ) : (
                  <>
                    <span className="inline-block rounded border border-tt-cyan text-tt-cyan font-bold align-middle mr-2" style={{ fontSize: 'clamp(0.6rem,2.4vw,0.85rem)', padding: '0 0.35em' }}>CATALOG</span>
                    <span className="font-semibold text-tt-text break-words align-middle" style={{ fontSize: 'clamp(0.85rem, 3.4vw, 1.25rem)' }}>{line.listing_name} · <span className="font-mono">{line.seller_sku || '—'}</span></span>
                  </>
                )}
              </div>
              {/* count */}
              <div className={`text-center font-extrabold ${lineDone ? 'text-tt-green' : 'text-tt-text'}`} style={{ fontSize: 'clamp(1.1rem, 4.5vw, 1.9rem)' }}>{have} / {line.required_qty} grabbed</div>
              {/* grab */}
              <button onClick={() => grab(line)} disabled={lineDone}
                className={`w-full rounded-2xl font-extrabold transition-opacity ${lineDone ? 'bg-tt-card-hover text-tt-muted cursor-default' : 'bg-tt-green text-black cursor-pointer hover:opacity-90'}`}
                style={{ padding: 'clamp(0.55rem, 1.9vh, 1rem) 0', fontSize: 'clamp(1rem, 4vw, 1.4rem)' }}>
                {lineDone ? '✓ Complete' : 'Grab one'}
              </button>
              {/* Back / info / Next */}
              <div className="flex items-center justify-between gap-2">
                <button onClick={() => setActiveIdx((i) => Math.max(0, i - 1))} disabled={activeIdx === 0}
                  className="shrink-0 rounded-xl border border-tt-border text-tt-text disabled:opacity-40 cursor-pointer" style={{ padding: 'clamp(0.5rem,1.5vh,0.75rem) clamp(0.9rem,4vw,1.25rem)', minHeight: '44px', minWidth: '44px' }}>‹ Back</button>
                <span className="flex-1 min-w-0 truncate text-center text-xs text-tt-muted">Item {activeIdx + 1} of {pickLines.length} · {pickedUnits}/{totalUnits} units</span>
                <button onClick={() => setActiveIdx((i) => Math.min(pickLines.length - 1, i + 1))} disabled={activeIdx === pickLines.length - 1}
                  className="shrink-0 rounded-xl border border-tt-border text-tt-text disabled:opacity-40 cursor-pointer" style={{ padding: 'clamp(0.5rem,1.5vh,0.75rem) clamp(0.9rem,4vw,1.25rem)', minHeight: '44px', minWidth: '44px' }}>Next ›</button>
              </div>
              {/* New label / Finish */}
              <div className="flex items-center justify-between gap-3">
                <button onClick={() => (anyPicked ? setAbandon({ scan: null }) : backToReady())} className="shrink-0 inline-flex items-center min-h-[44px] px-2 text-sm text-tt-muted underline cursor-pointer">New label</button>
                {allComplete && (
                  <button onClick={() => enterFinish(box)} className="flex-1 min-h-[52px] px-6 py-3 rounded-xl bg-tt-cyan text-black text-lg font-extrabold cursor-pointer hover:opacity-90 shadow-lg">Finish box ›</button>
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
            <button onClick={backToReady} className="mt-8 w-full min-h-[56px] py-5 rounded-2xl bg-tt-green text-black text-xl font-extrabold cursor-pointer hover:opacity-90 shadow-lg">
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

      {pickerModal}
    </div>,
    document.body,
  );
}
