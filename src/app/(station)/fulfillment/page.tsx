'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import PackStationOverlay, { type OpenBox } from '@/components/shipping/PackStationOverlay';
import { enterFullscreen, isFullscreen } from '@/lib/fullscreen';

// The station login lands straight into the packing overlay — always-on, no idle tab view. Exit
// (hold ✕) returns to scan-ready inside the overlay rather than unmounting. All data comes from
// the /api/station/* routes (service_role, owner-scoped).
//
// ─── FULLSCREEN ───
// This page originally requested fullscreen NOWHERE, on the theory that "the page IS the whole
// screen under the bare (station) layout". That is true of the LAYOUT but not of the browser:
// on the warehouse's Android Chrome tablets the URL bar, tab switcher and back affordance stay
// on screen, and every one of them is a way to leave the route mid-box. Real device photos show
// the URL bar visible during a pick.
//
// requestFullscreen() only works from a genuine user gesture, so it can never be issued on mount
// — a mount-time request is denied every time and is worse than not trying, because it looks like
// it should work. There are exactly two gestures available on this route, and both now carry it:
//   1. the one-time device-mode picker's PICK/PACK tap (first run on a device), and
//   2. a SHORT TAP on the mode chip (every run after that, since the picker no longer renders).
// Both go through the shared, denial-tolerant helper in @/lib/fullscreen — the same mechanism the
// Shipping tab and the time-clock kiosk use. Denial is non-fatal: the station keeps working
// windowed exactly as it does today.
//
// Device mode ('pick' | 'pack') is remembered per device in the `lensed_station_mode` cookie. If
// absent, a one-time full-screen picker chooses it; the current mode shows small in a corner as
// plain text. Changing it needs a ~900ms press-and-hold on the chip (matching the overlay's
// hold-to-exit gesture) so a mistap can't drop a packer into pick mode mid-box.

type Mode = 'pick' | 'pack';
const MODE_COOKIE = 'lensed_station_mode';
const MODE_MAX_AGE = 34_560_000; // ~400 days — the browser cap; effectively "remember this device"

function getCookie(name: string): string | null {
  const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : null;
}
function setCookie(name: string, value: string) {
  document.cookie = `${name}=${encodeURIComponent(value)}; max-age=${MODE_MAX_AGE}; path=/; samesite=lax`;
}

export default function FulfillmentPage() {
  const [mounted, setMounted] = useState(false);
  const [mode, setMode] = useState<Mode | null>(null);
  const [pickers, setPickers] = useState<{ id: string; name: string }[]>([]);
  const [pickerId, setPickerId] = useState('');
  const [pickedCount, setPickedCount] = useState(0);
  const [holding, setHolding] = useState(false);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Whether we are CURRENTLY fullscreen, so the chip can offer the affordance only when it would
  // do something. Tracked via the browser's own event rather than assumed from our request: the
  // OS/user can drop out of fullscreen at any time (Android back gesture, notification shade).
  const [fullscreen, setFullscreen] = useState(false);
  // The chip carries TWO gestures on one element, and they must not bleed into each other:
  //   • SHORT TAP  → request fullscreen (gesture 2 of 2 — the only one left once the device-mode
  //                  cookie is set and the picker screen no longer renders).
  //   • LONG PRESS → change device mode (unchanged).
  // Disambiguation: the long-press timer sets `longPressFired`, and the click handler — which the
  // browser fires on release for BOTH gestures — consumes that flag and does nothing. So a
  // completed hold never also toggles fullscreen, and a tap never changes mode. Cancelling by
  // dragging off (pointerleave/cancel) suppresses no click, because the browser does not fire one.
  // Declared with the other hooks, ABOVE the early returns below — hooks must run unconditionally.
  const longPressFired = useRef(false);

  // ─── GUARDING THE MODE CHANGE ───
  // A completed 900ms hold used to wipe straight to "Set up this device", losing an in-progress
  // box. Nothing about the gesture required intent: pointerleave cancels, so a finger that simply
  // rests without moving — a slow, heavy tap on a tablet — completes the hold. Mode is chosen once
  // per device and effectively never again, so the gesture being hard to fire costs nothing while
  // an accidental fire costs a pick.
  // Two guards, because they cover different failure modes:
  //   • MID-BOX  → refuse outright. This is the case that destroys work, and no confirm dialog is
  //                worth showing to someone who did not mean to open it. The operator sets the box
  //                aside first (New label / hold-✕), which is a deliberate act on its own.
  //   • IDLE     → confirm. Cheap, and converts a stray gesture into an explicit decision.
  const [openBox, setOpenBox] = useState<OpenBox | null>(null);
  const [confirmModeChange, setConfirmModeChange] = useState(false);
  const [blockedMidBox, setBlockedMidBox] = useState(false);
  const blockedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (blockedTimer.current) clearTimeout(blockedTimer.current); }, []);
  // Fires on release for tap AND long-press; `longPressFired` tells them apart. `click` is used
  // rather than `pointerup` because it is unambiguously an activation-triggering event for the
  // Fullscreen API on Chrome.
  const onChipClick = useCallback(() => {
    if (longPressFired.current) { longPressFired.current = false; return; }
    if (!isFullscreen()) void enterFullscreen();
  }, []);

  // Read the saved device mode once on mount (cookie → avoids SSR hydration mismatch).
  useEffect(() => {
    setMounted(true);
    const m = getCookie(MODE_COOKIE);
    if (m === 'pick' || m === 'pack') setMode(m);
  }, []);

  useEffect(() => {
    const sync = () => setFullscreen(isFullscreen());
    sync();
    document.addEventListener('fullscreenchange', sync);
    // Safari/older WebKit on iPadOS emits the prefixed event only.
    document.addEventListener('webkitfullscreenchange', sync);
    return () => {
      document.removeEventListener('fullscreenchange', sync);
      document.removeEventListener('webkitfullscreenchange', sync);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/station/employees')
      .then((r) => (r.ok ? r.json() : { employees: [] }))
      .then((d) => { if (!cancelled) setPickers((d.employees ?? []) as { id: string; name: string }[]); })
      .catch(() => { /* roster is best-effort; the picker gate shows "no employees" if empty */ });
    return () => { cancelled = true; };
  }, []);

  if (!mounted) return <div className="min-h-screen bg-tt-bg" />;

  // One-time device-mode picker — two large buttons, sets the cookie for this device.
  if (!mode) {
    // GESTURE 1 of 2. This tap is the first (and on a fresh device, only) real user gesture the
    // route gets, so fullscreen is requested here — synchronously inside the handler, BEFORE the
    // state updates that unmount this screen. Awaiting anything first would spend the gesture's
    // user-activation and the request would be denied.
    const choose = (m: Mode) => {
      void enterFullscreen();
      setCookie(MODE_COOKIE, m);
      setMode(m);
    };
    return (
      <main className="min-h-screen bg-tt-bg text-tt-text flex flex-col items-center justify-center gap-8 p-8 select-none">
        <div className="text-center">
          <h1 className="text-3xl font-extrabold">Set up this device</h1>
          <p className="mt-2 text-lg text-tt-muted">Is this station for picking or packing?</p>
        </div>
        <div className="flex w-full max-w-3xl flex-col gap-6 sm:flex-row">
          <button
            onClick={() => choose('pick')}
            className="flex-1 min-h-[40vh] rounded-3xl border-4 border-tt-cyan/50 bg-tt-card flex flex-col items-center justify-center gap-3 cursor-pointer hover:bg-tt-card-hover"
          >
            <span className="text-6xl font-black text-tt-text">PICK</span>
            <span className="text-lg text-tt-muted">One item at a time — pull each SKU</span>
          </button>
          <button
            onClick={() => choose('pack')}
            className="flex-1 min-h-[40vh] rounded-3xl border-4 border-tt-green/50 bg-tt-card flex flex-col items-center justify-center gap-3 cursor-pointer hover:bg-tt-card-hover"
          >
            <span className="text-6xl font-black text-tt-text">PACK</span>
            <span className="text-lg text-tt-muted">Checklist — tick each item as you pack</span>
          </button>
        </div>
      </main>
    );
  }

  // Changing device mode requires a deliberate ~900ms press-and-hold on the chip, mirroring the
  // overlay's hold-to-exit, so a single mistap can't switch modes mid-box. Completion re-opens the
  // one-time picker (setMode(null)); releasing early cancels and resets the progress fill.
  const beginHoldChange = () => {
    setHolding(true);
    longPressFired.current = false;
    holdTimer.current = setTimeout(() => {
      holdTimer.current = null;
      // Set regardless of which branch runs: the browser still fires `click` on release, and it
      // must not be read as a short tap (which would request fullscreen behind the dialog).
      longPressFired.current = true;
      setHolding(false);
      if (openBox) {
        setBlockedMidBox(true);
        if (blockedTimer.current) clearTimeout(blockedTimer.current);
        blockedTimer.current = setTimeout(() => setBlockedMidBox(false), 3000);
        return;
      }
      setConfirmModeChange(true);
    }, 900);
  };
  const cancelHoldChange = () => {
    setHolding(false);
    if (holdTimer.current) { clearTimeout(holdTimer.current); holdTimer.current = null; }
  };

  return (
    <>
      <PackStationOverlay
        mode={mode}
        endpoints={{ boxes: '/api/station/boxes', scan: '/api/station/scan', confirm: '/api/station/confirm' }}
        pickers={pickers}
        storeLabel="All stores"
        pickerId={pickerId}
        onPickerChange={setPickerId}
        pickedCount={pickedCount}
        onBoxPicked={() => setPickedCount((n) => n + 1)}
        onExit={() => { /* always-on: exit returns to scan-ready in the overlay; nothing to unmount */ }}
        // Read-only mirror of the overlay's loaded box, used ONLY to refuse a mode change while a
        // pick is in progress. setState from useState is a stable reference, which this prop
        // requires (it is an effect dependency inside the overlay).
        onBoxChange={setOpenBox}
      />
      {/* Current-mode chip, portalled above the overlay (z-[205] > overlay z-[200]). Plain text,
          no tap target: changing mode requires a press-and-hold (same gesture as the overlay's
          hold-to-exit). Top-LEFT so it never overlaps the overlay's top-right hold-to-exit. */}
      {typeof document !== 'undefined' && createPortal(
        <button
          onPointerDown={beginHoldChange}
          onPointerUp={cancelHoldChange}
          onPointerLeave={cancelHoldChange}
          onPointerCancel={cancelHoldChange}
          onClick={onChipClick}
          aria-label={
            fullscreen
              ? `Mode: ${mode}. Press and hold to change.`
              : `Mode: ${mode}. Tap for fullscreen, press and hold to change.`
          }
          className="fixed z-[205] flex items-center gap-2 overflow-hidden rounded-lg border border-tt-border bg-tt-card/90 px-3 py-1.5 text-xs backdrop-blur cursor-pointer select-none touch-none"
          style={{ top: 'calc(env(safe-area-inset-top) + 0.75rem)', left: 'calc(env(safe-area-inset-left) + 0.75rem)' }}
        >
          {/* hold-to-change progress fill — same feedback as the overlay's hold-to-exit: a tinted
              fill that grows over 0.9s linear while held and snaps back on release. */}
          <span
            aria-hidden
            className="absolute inset-0 origin-left bg-tt-cyan/30"
            style={{ transform: holding ? 'scaleX(1)' : 'scaleX(0)', transition: holding ? 'transform 0.9s linear' : 'transform 0s' }}
          />
          <span className="relative font-bold uppercase tracking-wide text-tt-text">{mode}</span>
          {/* The label doubles as the discoverability hint for fullscreen: an operator who has
              never seen the device-mode picker (cookie already set) would otherwise have no way
              to know the tap does anything. Once fullscreen, only the hold remains meaningful. */}
          <span className="relative text-[10px] normal-case text-tt-muted">
            {blockedMidBox
              ? 'finish or set aside the box first'
              : fullscreen ? 'hold to change' : 'tap = fullscreen · hold = change'}
          </span>
        </button>,
        document.body,
      )}
      {/* Mode-change confirmation. Only reachable from an IDLE completed hold — mid-box holds are
          refused before this can open. z-[220] clears both the overlay (200) and the chip (205).
          Portalled to <body> and marked data-overlay-exempt for the same reason the chip is: the
          overlay inerts its <body> siblings, and a dialog the operator cannot answer is worse than
          no dialog. */}
      {confirmModeChange && typeof document !== 'undefined' && createPortal(
        <div
          data-overlay-exempt=""
          className="fixed inset-0 z-[220] bg-black/70 backdrop-blur-md flex items-center justify-center p-4"
        >
          <div className="bg-tt-card border border-tt-border rounded-2xl p-6 max-w-sm w-full">
            <div className="text-lg font-bold text-tt-text">Change device mode?</div>
            <div className="mt-2 text-sm text-tt-muted">
              This device is set to <span className="font-bold uppercase text-tt-text">{mode}</span>.
              Changing it returns to the setup screen so you can pick again.
            </div>
            <div className="mt-5 flex gap-3">
              <button
                onClick={() => setConfirmModeChange(false)}
                className="flex-1 min-h-[44px] py-3 rounded-xl border border-tt-border text-tt-text cursor-pointer"
              >
                Keep {mode}
              </button>
              <button
                onClick={() => { setConfirmModeChange(false); setMode(null); }}
                className="flex-1 min-h-[44px] py-3 rounded-xl bg-tt-cyan text-black font-bold cursor-pointer hover:opacity-90"
              >
                Change mode
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
