'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import PackStationOverlay from '@/components/shipping/PackStationOverlay';

// The station login lands straight into the packing overlay — always-on, no idle tab view, no
// fullscreen request (the page IS the whole screen under the bare (station) layout). Exit
// (hold ✕) returns to scan-ready inside the overlay rather than unmounting. All data comes from
// the /api/station/* routes (service_role, owner-scoped).
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

  // Read the saved device mode once on mount (cookie → avoids SSR hydration mismatch).
  useEffect(() => {
    setMounted(true);
    const m = getCookie(MODE_COOKIE);
    if (m === 'pick' || m === 'pack') setMode(m);
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
    const choose = (m: Mode) => { setCookie(MODE_COOKIE, m); setMode(m); };
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
    holdTimer.current = setTimeout(() => { setHolding(false); setMode(null); }, 900);
  };
  const cancelHoldChange = () => {
    setHolding(false);
    if (holdTimer.current) { clearTimeout(holdTimer.current); holdTimer.current = null; }
  };

  return (
    <>
      <PackStationOverlay
        mode={mode}
        endpoints={{ boxes: '/api/station/boxes', scan: '/api/station/scan', confirm: '/api/station/confirm', override: '/api/station/override' }}
        pickers={pickers}
        storeLabel="All stores"
        pickerId={pickerId}
        onPickerChange={setPickerId}
        pickedCount={pickedCount}
        onBoxPicked={() => setPickedCount((n) => n + 1)}
        onExit={() => { /* always-on: exit returns to scan-ready in the overlay; nothing to unmount */ }}
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
          aria-label={`Mode: ${mode}. Press and hold to change.`}
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
          <span className="relative text-[10px] normal-case text-tt-muted">hold to change</span>
        </button>,
        document.body,
      )}
    </>
  );
}
