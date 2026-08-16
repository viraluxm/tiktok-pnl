'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { clockControlsMounted } from './clockActivity';

// Low-frequency self-heal for the mid-day-shift papercut. /s/[token] is a force-dynamic server
// snapshot taken at page load, so a shift ADDED after load never surfaces its clock button on its
// own — the shift list is not re-fetched client-side, and router.refresh() otherwise fires only
// after a punch confirms. This re-renders the server component every ~2 min, which re-fetches the
// shift list and re-evaluates the [start-45m, end+60m] window, so a newly added shift's clock button
// appears on its own.
//
// It refreshes ONLY when no ClockControls is mounted. A mounted control means the worker already has
// an in-window shift (nothing to self-heal) and may be mid-punch — and, because the QR sheet and the
// in-flight punch both live inside a mounted control, that one check also guarantees we never refresh
// while a sheet is open or a punch is in flight. Once a refresh surfaces a new in-window shift, its
// control mounts and this goes quiet until the control unmounts.
//
// Note: a rare same-worker overlap (a second shift added while a first is already in-window) waits
// for the first control to unmount before surfacing — the deliberate cost of never remounting a live
// control, per spec.
const REFRESH_MS = 120_000;

export function ScheduleAutoRefresh() {
  const router = useRouter();
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState !== 'visible') return; // don't churn a backgrounded tab
      if (clockControlsMounted()) return; // never refresh under a live control (covers sheet/punch)
      router.refresh();
    }, REFRESH_MS);
    return () => clearInterval(id);
  }, [router]);
  return null;
}
