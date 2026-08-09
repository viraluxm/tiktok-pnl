'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import PackStationOverlay from '@/components/shipping/PackStationOverlay';

// The station login lands straight into the packing overlay — always-on, no idle tab view, no
// fullscreen request (the page IS the whole screen under the bare (station) layout). Exit
// (hold ✕) returns to scan-ready inside the overlay rather than unmounting. All data comes from
// the /api/station/* routes (service_role, owner-scoped).
//
// Device mode ('pick' | 'pack') is remembered per device in the `lensed_station_mode` cookie. If
// absent, a one-time full-screen picker chooses it; the current mode shows small in a corner with
// a "change" affordance that re-opens the picker.

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
      />
      {/* Current-mode chip, portalled above the overlay (z-[205] > overlay z-[200]); "change"
          re-opens the picker. Top-LEFT so it never overlaps the overlay's top-right hold-to-exit. */}
      {typeof document !== 'undefined' && createPortal(
        <div
          className="fixed z-[205] flex items-center gap-2 rounded-lg bg-tt-card/90 border border-tt-border px-3 py-1.5 text-xs text-tt-muted backdrop-blur"
          style={{ top: 'calc(env(safe-area-inset-top) + 0.75rem)', left: 'calc(env(safe-area-inset-left) + 0.75rem)' }}
        >
          <span className="font-bold uppercase tracking-wide text-tt-text">{mode}</span>
          <button onClick={() => setMode(null)} className="underline cursor-pointer">change</button>
        </div>,
        document.body,
      )}
    </>
  );
}
