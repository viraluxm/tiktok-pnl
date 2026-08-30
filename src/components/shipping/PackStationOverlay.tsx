'use client';

/**
 * PackStationOverlay — the full-screen scanner-driven pick/pack overlay, extracted VERBATIM from
 * ShippingTab so it can run in two places with identical behavior:
 *   • Shipping tab ("Start scanning") — endpoints = /api/shipping/*, exit unmounts back to the tab.
 *   • Station login (/fulfillment)    — endpoints = /api/station/*, exit returns to scan-ready.
 *
 * This component is presentation + scan routing ONLY. Box resolution (orders/SKUs/qty/exclusions)
 * is owned by the endpoints. Fullscreen enter/exit is the CALLER's concern (kept in ShippingTab);
 * the overlay only reports "exit" via onExit. The picker gate opens on mount (session start).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { isSlotCode, normalizeSlotCode } from '@/lib/mapping/slotCode';

export interface PackStationEndpoints {
  boxes: string;
  scan: string;
  confirm: string;
  /**
   * Where a lead's override goes. REQUIRED rather than defaulted, because the two logins are
   * confined to different API namespaces and a silent default would work on one and 403 on the
   * other — with the failure landing on the fulfilment station, which is the login the
   * override actually exists for.
   */
  override: string;
}

interface BoxSku {
  inventory_sku_id: string;
  sku_number: number | null;
  title: string;
  barcode: string | null;
  thumbnail_url: string | null;
  required_qty: number;
  // Set at BIND time when this order line could not be filled from stock (the sale went through
  // with nothing on the shelf). A fact about the order, not a live inventory read: it is decided
  // once, when the bind draws short, and never changes. Older payloads omit it → not short.
  shelf_out?: boolean;
  // Where this SKU lives, e.g. "R3A L2" — rack, side, level. Null when it has no section
  // mapped yet; the screen then shows no guidance rather than guessing, and the line sorts
  // last. Older payloads omit both fields.
  location_label?: string | null;
  // Every slot code that legitimately holds this SKU. More than one when it sits on both
  // faces of a rack, or in two places — walking to the far face is not an error.
  slot_codes?: string[];
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
  catalog_orders?: CatalogOrder[];
  order_types?: Record<string, 'bound' | 'unbound_auction' | 'catalog'>;
  missing_order_ids: string[];
  missing_orders?: MissingOrder[];
  excluded?: { order_id: string; reason: string; skus: string[] }[];
  excluded_count?: number;
  status_unverified?: boolean;
  already_verified_at: string | null;
}

type Screen = 'ready' | 'alert' | 'pick' | 'finish' | 'empty';

// Bound on the scan round-trip. Long enough for a slow warehouse connection, short enough
// that a hung request cannot quietly kill the device for the rest of the shift.
const SCAN_TIMEOUT_MS = 15_000;

type PickLine =
  | { kind: 'sku'; key: string; sku_number: number | null; title: string; barcode: string | null; thumbnail_url: string | null; required_qty: number; shelf_out: boolean; location_label: string | null; slot_codes: string[] }
  | { kind: 'catalog'; key: string; order_id: string; listing_name: string; seller_sku: string; required_qty: number };

const buildPickLines = (b: Box): PickLine[] => [
  ...b.skus.map((s): PickLine => ({ kind: 'sku', key: s.inventory_sku_id, sku_number: s.sku_number, title: s.title, barcode: s.barcode, thumbnail_url: s.thumbnail_url, required_qty: s.required_qty, shelf_out: s.shelf_out === true, location_label: s.location_label ?? null, slot_codes: s.slot_codes ?? [] })),
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

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    document.getElementById(`picker-opt-${options[highlight]?.id ?? ''}`)?.scrollIntoView({ block: 'nearest' });
  }, [open, highlight, options]);

  const choose = (id: string) => { onChange(id); setOpen(false); };

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

export interface PackStationOverlayProps {
  endpoints: PackStationEndpoints;
  pickers: { id: string; name: string }[];
  // storeLabel is part of the interface (station passes "All stores") but is intentionally not
  // rendered here — surfacing it would change ShippingTab's existing overlay output.
  storeLabel: string;
  // 'pick' (default) = the one-SKU-at-a-time grab flow (unchanged). 'pack' = a scrollable
  // all-lines checklist that ticks whole lines and does NOT write a verification (see finishPack).
  mode?: 'pick' | 'pack';
  pickerId: string;
  onPickerChange: (id: string) => void;
  pickedCount: number;
  onBoxPicked: () => void;
  onExit: () => void;
  // OPTIONAL, purely observational: fires whenever the loaded box changes (null on scan-ready).
  // ShippingTab uses it to record which box was open so an interrupted session can be resumed.
  // The station mount (/fulfillment) does not pass it, so its behavior is unchanged. Must be a
  // STABLE reference (useCallback) — it is an effect dependency below.
  onBoxChange?: (box: OpenBox | null) => void;
}

/** The minimum a caller needs to describe the open box to an operator. */
export interface OpenBox { group_key: string; label: string }

export default function PackStationOverlay({
  endpoints,
  pickers,
  mode = 'pick',
  pickerId,
  onPickerChange,
  pickedCount,
  onBoxPicked,
  onExit,
  onBoxChange,
}: PackStationOverlayProps) {
  const [screen, setScreen] = useState<Screen>('ready');
  const [box, setBox] = useState<Box | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [activeIdx, setActiveIdx] = useState(0);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [justDone, setJustDone] = useState(false);
  const [abandon, setAbandon] = useState<null | { scan: string | null }>(null);
  // Transient feedback for a section scan that did not land (wrong section, not in this box).
  const [scanMsg, setScanMsg] = useState<string | null>(null);
  // A line the picker cannot scan — damaged label, unreachable — awaiting a lead's PIN.
  const [override, setOverride] = useState<null | { line: PickLine }>(null);
  const [holding, setHolding] = useState(false);
  const [value, setValue] = useState('');
  // Accumulates a wedge scanner's keystrokes between Enters, independent of what has focus.
  const scanBufRef = useRef('');
  // Picker gate opens on mount = the session starts by choosing who is packing.
  const [pickerModalOpen, setPickerModalOpen] = useState(true);

  const pickerName = useMemo(() => pickers.find((p) => p.id === pickerId)?.name ?? '', [pickers, pickerId]);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The 550ms "line complete" flash timer. Held in a ref (like holdTimer) because its callback
  // finishes the box — it calls enterFinish, which fires the verification write. Left dangling,
  // it survives the transition that cancelled the pick and confirms a box the picker abandoned.
  const doneTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelDoneTimer = () => { if (doneTimer.current) { clearTimeout(doneTimer.current); doneTimer.current = null; } };
  const confirmedRef = useRef(false); // fire /confirm + count once per box
  const pickStartedAtRef = useRef<string | null>(null);

  const focusInput = useCallback(() => { requestAnimationFrame(() => inputRef.current?.focus()); }, []);
  // Keep the scanner aimed at the hidden input — but NOT while the picker gate is open (the modal
  // owns focus then). When the gate closes this re-runs and re-arms the scanner.
  useEffect(() => { if (!pickerModalOpen) focusInput(); }, [screen, box, pickerModalOpen, focusInput]);
  // Unmount cleanup — the Shipping tab unmounts the overlay on exit, and a surviving flash timer
  // would confirm the box after the picker walked away.
  useEffect(() => () => { if (doneTimer.current) clearTimeout(doneTimer.current); }, []);

  // Report the open box upward (no-op when the caller passes no handler). Read-only mirror of
  // `box` — it never influences the overlay's own behavior.
  useEffect(() => {
    onBoxChange?.(box ? { group_key: box.group_key, label: box.scanned_value ?? box.scanned_order_id } : null);
  }, [box, onBoxChange]);

  const pickLines = useMemo(() => (box ? buildPickLines(box) : []), [box]);
  const anyPicked = useMemo(() => Object.values(counts).some((v) => v > 0), [counts]);
  const pickedUnits = useMemo(() => Object.values(counts).reduce((a, b) => a + b, 0), [counts]);
  const totalUnits = useMemo(() => pickLines.reduce((a, l) => a + l.required_qty, 0), [pickLines]);
  const allComplete = useMemo(
    () => pickLines.length > 0 && pickLines.every((l) => (counts[l.key] ?? 0) >= l.required_qty),
    [pickLines, counts],
  );
  // Pack-mode (sm+) grid column CAP by line count so a 2-item box gets 2 large cards, not 2
  // small ones in a wide grid: <=4 → 2, 5–9 → 3, 10+ → 4. Combined with auto-fit/minmax below,
  // columns still collapse on narrower viewports and never shrink cards below a readable floor.
  const packCols = pickLines.length <= 4 ? 2 : pickLines.length <= 9 ? 3 : 4;

  // ── scan → box resolution (endpoint-driven, unchanged shape) ──
  async function loadBox(scan: string) {
    // Drop any pending flash timer from the OUTGOING box before its state is replaced — it would
    // otherwise fire against the new box and confirm the previous one's group_key.
    cancelDoneTimer(); setJustDone(false);
    setLoading(true); setErr(null);
    // A scan request that never settles used to leave `loading` true forever, and every
    // subsequent scan was then dropped silently by the `if (loading) return` guard in onScan —
    // the device looked completely dead with nothing on screen to explain it. Flaky warehouse
    // wifi is enough to cause that. Bound it, and say so when it fires.
    const ctl = new AbortController();
    const timeout = setTimeout(() => ctl.abort(), SCAN_TIMEOUT_MS);
    try {
      const res = await fetch(endpoints.scan, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scan }), signal: ctl.signal,
      });
      // A middleware bounce to /login returns HTML, not JSON, so this throws rather than
      // yielding a useful error. Say "signed out" instead of a parse failure.
      const json = await res.json().catch(() => null);
      if (json === null) {
        setErr('Signed out or unreachable — reload the page and sign in again.');
        setScreen('ready');
        return;
      }
      if (!res.ok) {
        const t = json.parsed_tracking ? ` (tracking ${json.parsed_tracking})` : '';
        setErr(`No matching order for “${json.scanned_value ?? scan}”${t}`);
        setScreen('ready');
        return;
      }
      const b = json as Box;
      setBox(b); setCounts({}); setActiveIdx(0); confirmedRef.current = false; setErr(null);
      pickStartedAtRef.current = new Date().toISOString();
      const unbound = (b.missing_orders?.length ?? 0) > 0 || b.missing_order_ids.length > 0;
      const lines = buildPickLines(b);
      if (unbound) setScreen('alert');
      else if (lines.length === 0) setScreen('empty');
      else { setScreen('pick'); setActiveIdx(firstUnpickedIdx(lines, {})); }
    } catch (e) {
      setErr(
        (e as Error)?.name === 'AbortError'
          ? `No response after ${Math.round(SCAN_TIMEOUT_MS / 1000)}s — check the connection and scan again.`
          : 'Network error loading the box',
      );
      setScreen('ready');
    } finally {
      clearTimeout(timeout);
      setLoading(false); focusInput();
    }
  }

  /**
   * A section scan while picking is a PICK CONFIRMATION, not a new box.
   *
   * Scanning a section that belongs to this box but is not the line on screen jumps to that
   * line and counts it — picking out of order is normal and useful, not an error worth
   * refusing.
   */
  function confirmBySection(raw: string) {
    const code = normalizeSlotCode(raw);
    const idx = pickLines.findIndex((l) => l.kind === 'sku' && l.slot_codes.includes(code));
    if (idx === -1) {
      setScanMsg('That section is not in this order.');
      return;
    }
    const l = pickLines[idx];
    if ((counts[l.key] ?? 0) >= l.required_qty) {
      setScanMsg(`${(l.kind === 'sku' && l.location_label) || 'That section'} is already complete.`);
      return;
    }
    setActiveIdx(idx);
    setScanMsg(null);
    grab(l, 'scan');
  }

  function onScan() {
    const v = value.trim(); setValue('');
    handleScan(v);
  }

  /**
   * Handle one completed scan, wherever it came from.
   *
   * Split out from onScan because scans no longer arrive only through the hidden input — see
   * the window-level listener below.
   */
  function handleScan(v: string) {
    if (pickerModalOpen) {
      // The gate is a full-screen modal, so it is usually obvious — but say it anyway, because
      // a scan that vanishes with no acknowledgement is indistinguishable from a broken device.
      setScanMsg('Choose who\'s picking first.');
      return;
    }
    focusInput();
    if (!v) return;
    if (loading) {
      setScanMsg('Still loading the last scan — one moment.');
      return;
    }
    // Prefix test, so a section label can never be mistaken for a shipping label and start a
    // new box mid-pick. See lib/mapping/slotCode.
    if (screen === 'pick' && isSlotCode(v)) { confirmBySection(v); return; }
    if (screen === 'pick' && anyPicked) { setAbandon({ scan: v }); return; }
    loadBox(v);
  }

  // ── Scanner capture, at the WINDOW rather than a focused input ──────────────────────────
  //
  // The scanner is a keyboard wedge: it types the code then presses Enter. Relying on a hidden
  // input holding focus is fragile on a touch device — tapping ANY control (Next, the item
  // photo, a mode button) moves focus to it, and from then on every scan lands there instead.
  // Enter just re-clicks the focused button, so the device looks completely dead while the
  // scanner beeps happily. That is the reported "scanning does nothing", and it explains why
  // the FIRST scan of a box works and later ones do not: the first happens before anyone has
  // touched the screen.
  //
  // Capturing at the window removes the dependency on focus entirely. Keystrokes are ignored
  // while the operator is deliberately typing in a real field (the override PIN, the SKU
  // search) so those still behave normally.
  useEffect(() => {
    const inRealTextField = () => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === inputRef.current) return false;
      return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable;
    };
    const onKey = (e: KeyboardEvent) => {
      if (inRealTextField()) return;
      if (e.key === 'Enter') {
        const v = scanBufRef.current.trim();
        scanBufRef.current = '';
        if (!v) return;
        e.preventDefault();
        setValue('');
        handleScan(v);
        return;
      }
      // Printable characters only; a scanner emits nothing else mid-code.
      if (e.key.length === 1) scanBufRef.current += e.key;
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // Lead-authorised bypass for a section that cannot be scanned — a damaged or unreachable
  // label. Authorising and logging happen server-side; on success the line is counted as if
  // scanned, and the override is on the record.
  async function submitOverride(cred: { pin?: string; ownerPassword?: string }, reason: string) {
    if (!override || !box) return { ok: false, error: 'No line selected' };
    const line = override.line;
    try {
      // Which endpoint depends on WHICH LOGIN is running the overlay: a station session is
      // hard-confined to /api/station, so calling the shipping route there is a middleware 403
      // before the handler ever runs.
      const res = await fetch(endpoints.override, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pin: cred.pin,
          owner_password: cred.ownerPassword,
          reason,
          group_key: box.group_key,
          inventory_sku_id: line.kind === 'sku' ? line.key : null,
          picker_employee_id: pickerId || null,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, error: json.error || 'Could not authorise' };
      setOverride(null);
      setScanMsg(json.warning ? String(json.warning) : `Authorised by ${json.authorized_by}.`);
      grab(line, 'override');
      return { ok: true };
    } catch {
      return { ok: false, error: 'Network error' };
    }
  }

  // ── pick actions ──
  //
  // A line REQUIRES a section scan once its SKU has been mapped. Unmapped SKUs still pick by
  // tap, which is what lets verification roll out gradually instead of blocking the floor on
  // the day the first rack is drawn.
  const requiresScan = (line: PickLine) => line.kind === 'sku' && line.slot_codes.length > 0;

  function grab(line: PickLine, via: 'tap' | 'scan' | 'override' = 'tap') {
    if (!box) return;
    if (via === 'tap' && requiresScan(line)) {
      setScanMsg(`Scan the ${line.kind === 'sku' && line.location_label ? line.location_label : 'section'} label to confirm.`);
      return;
    }
    const have = counts[line.key] ?? 0;
    if (have >= line.required_qty) return;
    const next = have + 1;
    const nc = { ...counts, [line.key]: next };
    setCounts(nc);
    if (next >= line.required_qty) {
      setJustDone(true);
      cancelDoneTimer();
      doneTimer.current = setTimeout(() => {
        doneTimer.current = null;
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
      onBoxPicked();
      // Preserve the verify write — the box records as verified on finish, attributed to the
      // selected picker (validated server-side; falls back to Unassigned if missing/invalid).
      fetch(endpoints.confirm, {
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

  // ── pack-mode actions (mode === 'pack' only) ──
  // Tapping a row toggles the WHOLE line satisfied ↔ not (no per-unit counting): satisfied sets
  // counts[key] = required_qty, untick sets 0. allComplete then works unchanged.
  const toggleLine = (l: PickLine) => {
    setCounts((c) => ({ ...c, [l.key]: (c[l.key] ?? 0) >= l.required_qty ? 0 : l.required_qty }));
  };
  // Pack finish is a second-pass VERIFY, not the source of record. It must NOT call
  // endpoints.confirm: shipment_verifications upserts on (user_id, group_key) with
  // ignoreDuplicates, so a pack confirm after a pick confirm is silently dropped. Show the
  // verified screen and count the box locally, with NO write.
  function finishPack() {
    setScreen('finish');
    if (!confirmedRef.current) { confirmedRef.current = true; onBoxPicked(); }
  }

  const backToReady = () => { cancelDoneTimer(); setJustDone(false); setBox(null); setCounts({}); setErr(null); pickStartedAtRef.current = null; setScreen('ready'); focusInput(); };

  // ── hold-to-exit (tap-and-hold ~0.9s) → reset to scan-ready, then hand off to the caller. For
  // the Shipping tab onExit exits fullscreen + unmounts; for the station page it's a no-op so the
  // overlay stays mounted on scan-ready. ──
  const beginHold = () => { setHolding(true); holdTimer.current = setTimeout(() => { setHolding(false); setPickerModalOpen(false); backToReady(); onExit(); }, 900); };
  const cancelHold = () => { setHolding(false); if (holdTimer.current) clearTimeout(holdTimer.current); };

  // Picker chosen → drop the gate; the refocus effect re-arms the scanner.
  const confirmPicker = () => { if (!pickerId) return; setValue(''); setPickerModalOpen(false); };
  // Cancel the gate. With NO picker chosen, back out (onExit) so scanning never begins unattributed;
  // with a picker already set (mid-session "Change picker"), just close and keep running.
  const dismissPicker = () => { setPickerModalOpen(false); if (!pickerId) { backToReady(); onExit(); } };

  // ── picker-selection modal (opens on mount; also via "Change picker") ──
  const pickerModal = pickerModalOpen ? (
    <div className="fixed inset-0 z-[210] bg-black/70 backdrop-blur-md flex items-center justify-center p-4 sm:p-6">
      <div className="bg-tt-card border border-tt-border rounded-2xl p-6 max-w-sm w-full">
        <div className="text-lg font-bold text-tt-text">Who&apos;s picking?</div>
        <label htmlFor="picker-select" className="block text-xs uppercase tracking-wide text-tt-muted mt-4 mb-2">Picker</label>
        <PickerCombobox
          options={pickers}
          value={pickerId}
          onChange={onPickerChange}
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

  const unbound: MissingOrder[] = box
    ? (box.missing_orders?.length ? box.missing_orders : box.missing_order_ids.map((id) => ({ order_id: id, listing_name: null, seller_sku: null })))
    : [];
  const line = box && screen === 'pick' ? pickLines[activeIdx] ?? null : null;
  const have = line ? counts[line.key] ?? 0 : 0;
  const lineDone = line ? have >= line.required_qty : false;
  const needsScan = line ? requiresScan(line) : false;
  // Display-only. Never ANDed into lineDone, grab(), or allComplete — a short item is still
  // grabbable, still navigable, and still lets the box complete.
  const lineShelfOut = !!(line && line.kind === 'sku' && line.shelf_out);

  // ── focus-mode overlay — portalled to <body> so it escapes any transformed ancestor and fills
  // the whole dynamic viewport at z-[200], above app chrome. Safe under SSR (mounts client-side). ──
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
        // No Enter handler: the window-level listener above owns scan completion, so keeping
        // one here would double-fire whenever this input happens to hold focus.
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
            <div className="mt-10 text-sm text-tt-muted break-words">{pickedCount} {pickedCount === 1 ? 'box' : 'boxes'} picked today</div>
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
            · [PINNED controls — number, count, Grab, nav; always visible, never scrolls].
            mode === 'pick' only; pack mode renders the checklist block below instead. */}
        {screen === 'pick' && box && mode === 'pick' && line && (
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
              <div className={`w-full h-full flex items-center justify-center transition-opacity ${lineShelfOut ? 'opacity-30' : ''}`}>
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
              </div>
              {/* WHERE it is. Pinned top-left of the hero and pointer-events-none so the whole
                  area stays a tap target. Shown before anything else because it decides where
                  the picker walks; absent when the SKU has no section, rather than guessing. */}
              {line.kind === 'sku' && line.location_label && (
                <div className="absolute top-0 left-0 p-2 pointer-events-none">
                  <span
                    className="inline-block rounded-lg bg-tt-cyan text-black font-extrabold tracking-wide shadow-lg"
                    style={{ fontSize: 'clamp(1rem, 4.5vh, 2rem)', padding: '0.12em 0.45em' }}
                  >
                    {line.location_label}
                  </span>
                </div>
              )}

              {/* Picker-reported out-of-stock band. pointer-events-none so the whole hero stays a
                  tap target for grab() — a flagged item is still grabbable if it turns up. */}
              {lineShelfOut && (
                <div className="absolute inset-0 flex items-center pointer-events-none">
                  <div className="w-full mx-3 rounded bg-red-800/95 text-red-50 text-center py-2 font-medium tracking-wide" style={{ fontSize: '15px' }}>
                    OUT OF STOCK
                  </div>
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
              {/* grab — a mapped SKU is confirmed by SCANNING its section, not by tapping.
                  The button stays as the affordance and says what to do; tapping it explains
                  rather than silently doing nothing. An unmapped SKU still taps through, so
                  the floor is never blocked on a rack that has not been drawn yet. */}
              <button onClick={() => grab(line)} disabled={lineDone}
                className={`w-full rounded-2xl font-extrabold transition-opacity ${
                  lineDone ? 'bg-tt-card-hover text-tt-muted cursor-default'
                    : needsScan ? 'bg-tt-card-hover text-tt-cyan border-2 border-tt-cyan cursor-pointer'
                    : 'bg-tt-green text-black cursor-pointer hover:opacity-90'}`}
                style={{ padding: 'clamp(0.55rem, 1.9vh, 1rem) 0', fontSize: 'clamp(1rem, 4vw, 1.4rem)' }}>
                {lineDone ? '✓ Complete' : needsScan ? 'Scan the section label' : 'Grab one'}
              </button>
              {needsScan && !lineDone && (
                <button
                  onClick={() => setOverride({ line })}
                  className="w-full text-center text-tt-muted underline cursor-pointer"
                  style={{ fontSize: 'clamp(0.7rem, 2.6vw, 0.9rem)' }}
                >
                  Can&apos;t scan it? Get a lead to override
                </button>
              )}
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

        {/* PACK — all lines at once as a scrollable checklist. Tapping a row toggles the WHOLE
            line satisfied (toggleLine); catalog lines are visually distinct. No per-unit counting,
            and finishPack writes NO verification. mode === 'pack' only. */}
        {screen === 'pick' && box && mode === 'pack' && (
          <div className="flex-1 min-h-0 w-full flex flex-col gap-3">
            <div className="shrink-0 text-center text-base text-tt-muted break-words">
              {box.order_count} order{box.order_count === 1 ? '' : 's'} · tap each item as you pack it
            </div>

            {/* MOBILE (< sm): the existing compact row list — unchanged, so the handheld view
                never regresses. Hidden at sm+ where the card grid takes over. */}
            <div className="sm:hidden w-full max-w-2xl mx-auto flex-1 min-h-0 overflow-y-auto flex flex-col gap-2 pr-1">
              {pickLines.map((l) => {
                const done = (counts[l.key] ?? 0) >= l.required_qty;
                return (
                  <button
                    key={l.key}
                    onClick={() => toggleLine(l)}
                    className={`shrink-0 w-full flex items-center gap-3 rounded-2xl border-2 p-3 text-left transition-opacity ${done ? 'border-tt-green bg-tt-green/10 opacity-60' : (l.kind === 'catalog' ? 'border-tt-cyan/60 bg-tt-card' : 'border-tt-border bg-tt-card')}`}
                  >
                    <span className={`shrink-0 w-10 h-10 rounded-lg border-2 flex items-center justify-center text-2xl font-black ${done ? 'border-tt-green bg-tt-green text-black' : 'border-tt-border text-transparent'}`} aria-hidden>✓</span>
                    {l.kind === 'sku' ? (
                      l.thumbnail_url ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={l.thumbnail_url} alt="" className="shrink-0 w-16 h-16 rounded-lg object-cover border border-tt-border" onError={(e) => { e.currentTarget.style.display = 'none'; }} />
                      ) : (
                        <span className="shrink-0 w-16 h-16 rounded-lg border border-tt-border flex items-center justify-center font-mono font-extrabold text-tt-text text-lg">#{l.sku_number ?? '?'}</span>
                      )
                    ) : (
                      <span className="shrink-0 w-16 h-16 rounded-lg border-2 border-tt-cyan text-tt-cyan flex items-center justify-center text-xs font-extrabold">CAT</span>
                    )}
                    <div className="min-w-0 flex-1">
                      {l.kind === 'sku' ? (
                        <>
                          <div className="font-mono font-extrabold text-tt-text text-xl leading-tight">#{l.sku_number ?? '?'}</div>
                          <div className="text-sm text-tt-muted break-words leading-tight">{l.title}</div>
                        </>
                      ) : (
                        <>
                          <div className="inline-block rounded border border-tt-cyan text-tt-cyan text-[10px] font-extrabold px-1 leading-tight">CATALOG</div>
                          <div className="font-semibold text-tt-text break-words leading-tight">{l.listing_name}</div>
                          <div className="text-xs text-tt-muted break-all">Seller SKU {l.seller_sku || '—'}</div>
                        </>
                      )}
                    </div>
                    <span className="shrink-0 rounded-xl bg-tt-bg border border-tt-border px-3 py-2 text-2xl font-black tabular-nums text-tt-text">×{l.required_qty}</span>
                  </button>
                );
              })}
            </div>

            {/* DESKTOP (sm+): responsive card grid — image-dominant square cards that fill the
                viewport. auto-fit/minmax collapses columns on narrower widths; packCols caps the
                max so few items become few LARGE cards (not many small ones). Cards never shrink
                below a ~220px readable floor; overflow scrolls. Sizing is in fractions/viewport
                units so a 15" laptop and a 27" monitor both fill. */}
            <div
              className="hidden sm:grid flex-1 min-h-0 overflow-y-auto gap-4 pr-1"
              style={{
                gridTemplateColumns: `repeat(auto-fit, minmax(max(220px, calc((100% - ${packCols - 1} * 1rem) / ${packCols})), 1fr))`,
                // Rows share the container's height (1fr) so few items fill BOTH axes without
                // scrolling — the common 2–4 item case never scrolls. The 15rem floor is the
                // readable minimum; only when the rows' floors exceed the height (many items /
                // short viewport) does the grid overflow and scroll.
                gridAutoRows: 'minmax(15rem, 1fr)',
              }}
            >
              {pickLines.map((l) => {
                const done = (counts[l.key] ?? 0) >= l.required_qty;
                return (
                  <button
                    key={l.key}
                    onClick={() => toggleLine(l)}
                    className={`relative flex h-full flex-col overflow-hidden rounded-2xl border-4 text-left transition-colors ${done ? 'border-tt-green bg-tt-green/10' : (l.kind === 'catalog' ? 'border-tt-cyan/60 bg-tt-card' : 'border-tt-border bg-tt-card')}`}
                  >
                    {/* image-dominant area — the FLEXIBLE part of the card (flex-1) so it takes the
                        cell height left after the text footer; object-contain preserves aspect
                        without overflowing, so the card fills its cell in both axes. */}
                    <div className="relative w-full flex-1 min-h-0 flex items-center justify-center overflow-hidden bg-tt-bg">
                      {l.kind === 'sku' ? (
                        l.thumbnail_url ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={l.thumbnail_url} alt="" className="max-w-full max-h-full object-contain p-2" onError={(e) => { e.currentTarget.style.display = 'none'; }} />
                        ) : (
                          <span className="font-mono font-black text-tt-text leading-none" style={{ fontSize: 'clamp(2.5rem, 9vw, 8rem)' }}>#{l.sku_number ?? '?'}</span>
                        )
                      ) : (
                        <span className="inline-block rounded-lg border-2 border-tt-cyan text-tt-cyan font-extrabold tracking-wide" style={{ fontSize: 'clamp(1rem, 3vw, 2rem)', padding: '0.2em 0.6em' }}>CATALOG</span>
                      )}
                      {/* done → the WHOLE card reads as packed across the room: green wash + big ✓ */}
                      {done && (
                        <div className="absolute inset-0 bg-tt-green/50 flex items-center justify-center">
                          <span className="text-black font-black leading-none" style={{ fontSize: 'clamp(4rem, 16vw, 12rem)' }}>✓</span>
                        </div>
                      )}
                    </div>
                    {/* below the image: a FIXED footer (shrink-0) — #number + title (or catalog
                        listing) and ×qty. Its height stays constant so the image area flexes. */}
                    <div className="shrink-0 flex items-start justify-between gap-2 p-3">
                      <div className="min-w-0 flex-1">
                        {l.kind === 'sku' ? (
                          <>
                            <div className="font-mono font-extrabold text-tt-text leading-tight" style={{ fontSize: 'clamp(1.1rem, 1.8vw, 1.8rem)' }}>#{l.sku_number ?? '?'}</div>
                            <div className="text-tt-muted break-words leading-tight line-clamp-2" style={{ fontSize: 'clamp(0.8rem, 1vw, 1.1rem)' }}>{l.title}</div>
                          </>
                        ) : (
                          <>
                            <div className="inline-block rounded border border-tt-cyan text-tt-cyan text-[10px] font-extrabold px-1 leading-tight">CATALOG</div>
                            <div className="font-semibold text-tt-text break-words leading-tight line-clamp-2" style={{ fontSize: 'clamp(0.85rem, 1vw, 1.15rem)' }}>{l.listing_name}</div>
                            <div className="text-tt-muted break-all" style={{ fontSize: 'clamp(0.7rem, 0.8vw, 0.9rem)' }}>Seller SKU {l.seller_sku || '—'}</div>
                          </>
                        )}
                      </div>
                      <span className="shrink-0 rounded-xl bg-tt-bg border border-tt-border font-black tabular-nums text-tt-text leading-none" style={{ fontSize: 'clamp(1.3rem, 2vw, 2.4rem)', padding: 'clamp(0.35rem,0.8vw,0.7rem) clamp(0.5rem,1vw,0.9rem)' }}>×{l.required_qty}</span>
                    </div>
                  </button>
                );
              })}
            </div>
            <div className="shrink-0 flex items-center justify-between gap-3">
              <button onClick={() => (anyPicked ? setAbandon({ scan: null }) : backToReady())} className="shrink-0 inline-flex items-center min-h-[44px] px-2 text-sm text-tt-muted underline cursor-pointer">New label</button>
              <span className="flex-1 min-w-0 truncate text-center text-sm text-tt-muted">{pickLines.filter((l) => (counts[l.key] ?? 0) >= l.required_qty).length}/{pickLines.length} items</span>
              {allComplete && (
                <button onClick={finishPack} className="flex-1 min-h-[52px] px-6 py-3 rounded-xl bg-tt-cyan text-black text-lg font-extrabold cursor-pointer hover:opacity-90 shadow-lg">Box complete — verify ›</button>
              )}
            </div>
          </div>
        )}

        {/* FINISH */}
        {screen === 'finish' && (
          <div className="w-full max-w-sm mx-auto px-5 text-center">
            <div className="text-tt-green text-7xl mb-3">✓</div>
            <div className="text-3xl font-extrabold break-words">{mode === 'pack' ? 'Box verified' : 'Box picked'}</div>
            <div className="mt-2 text-lg text-tt-muted break-words">{mode === 'pack' ? 'All items checked off — set the box with its label.' : 'Put all items on the rack with the shipping label.'}</div>
            <button onClick={backToReady} className="mt-8 w-full min-h-[56px] py-5 rounded-2xl bg-tt-green text-black text-xl font-extrabold cursor-pointer hover:opacity-90 shadow-lg">
              Scan next label
            </button>
          </div>
        )}
      </div>

      {/* abandon-confirm (mid-pick new label / scan) */}
      {/* Section-scan feedback. A rejected scan must say WHY — a picker holding a scanner at a
          label that does nothing has no way to tell a wrong section from a dead scanner. */}
      {scanMsg && (
        <div className="absolute inset-x-0 z-30 flex justify-center px-4" style={{ bottom: 'calc(env(safe-area-inset-bottom) + 5.5rem)' }}>
          <button
            onClick={() => setScanMsg(null)}
            className="max-w-sm rounded-xl bg-tt-card border border-tt-cyan/70 px-4 py-2 text-center text-tt-text shadow-2xl cursor-pointer"
            style={{ fontSize: 'clamp(0.85rem, 3.2vw, 1rem)' }}
          >
            {scanMsg}
            <span className="ml-2 text-tt-muted underline">dismiss</span>
          </button>
        </div>
      )}

      {override && (
        <OverrideDialog
          line={override.line}
          onCancel={() => setOverride(null)}
          onSubmit={submitOverride}
        />
      )}

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

/**
 * Lead-authorised bypass for a section that cannot be scanned.
 *
 * Deliberately asks for a REASON as well as the PIN. The reason is what makes the override
 * log readable later — a column of "authorised" rows with no why tells you an override
 * happened but nothing about whether the labels are failing, and label failures are exactly
 * what this is meant to surface.
 */
function OverrideDialog({
  line, onCancel, onSubmit,
}: {
  line: PickLine;
  onCancel: () => void;
  onSubmit: (
    cred: { pin?: string; ownerPassword?: string },
    reason: string,
  ) => Promise<{ ok: boolean; error?: string }>;
}) {
  // A lead's PIN is the everyday path. The owner's own account password is the fallback for
  // when no lead is on the floor — rare, so it is behind a link rather than shown by default.
  const [mode, setMode] = useState<'pin' | 'owner'>('pin');
  const [pin, setPin] = useState('');
  const [ownerPassword, setOwnerPassword] = useState('');
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ready = mode === 'pin' ? pin.length >= 4 : ownerPassword.length > 0;

  const where = line.kind === 'sku' ? (line.location_label ?? `#${line.sku_number ?? '?'}`) : 'this line';

  return (
    <div className="absolute inset-0 bg-black/70 flex items-center justify-center p-6 z-40">
      <div className="bg-tt-card border border-tt-border rounded-2xl p-5 max-w-sm w-full">
        <div className="text-lg font-bold text-tt-text">Override the scan</div>
        <div className="mt-1 text-sm text-tt-muted">
          A lead enters their PIN to confirm <b className="text-tt-text">{where}</b> without scanning it.
          This is recorded.
        </div>

        {mode === 'pin' ? (
          <input
            autoFocus
            value={pin}
            onChange={(e) => { setPin(e.target.value.replace(/\D/g, '').slice(0, 8)); setErr(null); }}
            inputMode="numeric"
            placeholder="Lead PIN"
            className="mt-4 w-full rounded-xl border border-tt-border bg-tt-card px-3 py-2 text-center text-2xl tracking-[0.4em] text-tt-text"
          />
        ) : (
          <input
            autoFocus
            type="password"
            value={ownerPassword}
            onChange={(e) => { setOwnerPassword(e.target.value); setErr(null); }}
            placeholder="Account password"
            className="mt-4 w-full rounded-xl border border-tt-border bg-tt-card px-3 py-2 text-center text-lg text-tt-text"
          />
        )}

        <button
          onClick={() => {
            setMode(mode === 'pin' ? 'owner' : 'pin');
            setPin(''); setOwnerPassword(''); setErr(null);
          }}
          className="mt-2 w-full text-center text-xs text-tt-muted underline cursor-pointer"
        >
          {mode === 'pin'
            ? 'No lead available? Use the account password'
            : 'Use a lead PIN instead'}
        </button>
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="What's wrong? (e.g. label torn)"
          className="mt-2 w-full rounded-xl border border-tt-border bg-tt-card px-3 py-2 text-sm text-tt-text"
        />

        {err && <div className="mt-2 text-sm text-tt-red">{err}</div>}

        <div className="mt-4 flex gap-2">
          <button
            onClick={onCancel}
            className="flex-1 rounded-xl border border-tt-border py-2 text-sm text-tt-muted cursor-pointer"
          >
            Cancel
          </button>
          <button
            disabled={busy || !ready}
            onClick={async () => {
              setBusy(true);
              setErr(null);
              const r = await onSubmit(
                mode === 'pin' ? { pin } : { ownerPassword },
                reason,
              );
              setBusy(false);
              if (!r.ok) setErr(r.error ?? 'Could not authorise');
            }}
            className="flex-1 rounded-xl bg-tt-green py-2 text-sm font-bold text-black disabled:opacity-40 cursor-pointer"
          >
            {busy ? 'Checking…' : 'Authorise'}
          </button>
        </div>
      </div>
    </div>
  );
}
