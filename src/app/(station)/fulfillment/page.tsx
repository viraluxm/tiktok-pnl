'use client';

import { useEffect, useState } from 'react';
import PackStationOverlay from '@/components/shipping/PackStationOverlay';

// The station login lands straight into the packing overlay — always-on, no idle tab view, no
// fullscreen request (the page IS the whole screen under the bare (station) layout). Exit
// (hold ✕) returns to scan-ready inside the overlay rather than unmounting. All data comes from
// the /api/station/* routes (service_role, owner-scoped).
export default function FulfillmentPage() {
  const [pickers, setPickers] = useState<{ id: string; name: string }[]>([]);
  const [pickerId, setPickerId] = useState('');
  const [pickedCount, setPickedCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/station/employees')
      .then((r) => (r.ok ? r.json() : { employees: [] }))
      .then((d) => { if (!cancelled) setPickers((d.employees ?? []) as { id: string; name: string }[]); })
      .catch(() => { /* roster is best-effort; the picker gate shows "no employees" if empty */ });
    return () => { cancelled = true; };
  }, []);

  return (
    <PackStationOverlay
      endpoints={{ boxes: '/api/station/boxes', scan: '/api/station/scan', confirm: '/api/station/confirm' }}
      pickers={pickers}
      storeLabel="All stores"
      pickerId={pickerId}
      onPickerChange={setPickerId}
      pickedCount={pickedCount}
      onBoxPicked={() => setPickedCount((n) => n + 1)}
      onExit={() => { /* always-on: exit returns to scan-ready in the overlay; nothing to unmount */ }}
    />
  );
}
