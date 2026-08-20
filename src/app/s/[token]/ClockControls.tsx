'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import QRCode from 'qrcode';
import { acquireClockActivity } from './clockActivity';

// Clock controls for an IN-WINDOW assigned shift on the /s/[token] page. Additive — the release/drop
// flow and the 24h cutoff are untouched; this only appears when now ∈ [start-45m, end+60m]. A tap
// requests a server-issued single-use nonce and shows a full-screen white QR sheet for the station
// scanner. The sheet rotates the code every 30s (and on tab-refocus), wakes the screen, greys out
// offline, and polls the worker's state every 3s so it self-closes the moment the punch lands.

type State = 'clocked_out' | 'working' | 'on_break';
type Purpose = 'clock_in' | 'clock_out' | 'break_start' | 'break_end';

// The state the punch produces — used to detect confirmation from the 3s poll.
const EXPECTED_AFTER: Record<Purpose, State> = {
  clock_in: 'working',
  break_start: 'on_break',
  break_end: 'working',
  clock_out: 'clocked_out',
};
const ACTIONS: Record<State, { purpose: Purpose; label: string }[]> = {
  clocked_out: [{ purpose: 'clock_in', label: 'Clock in' }],
  working: [{ purpose: 'break_start', label: 'Start break' }, { purpose: 'clock_out', label: 'Clock out' }],
  on_break: [{ purpose: 'break_end', label: 'End break' }],
};

export function ClockControls({
  token,
  instanceId,
  workerName,
  workerId,
}: {
  token: string;
  instanceId: string;
  workerName: string;
  workerId: string;
}) {
  const router = useRouter();
  const [state, setState] = useState<State | null>(null);
  const [sheet, setSheet] = useState<{ purpose: Purpose } | null>(null);

  const fetchState = useCallback(async (): Promise<State | null> => {
    try {
      const res = await fetch(`/s/${token}/clock`, { cache: 'no-store' });
      if (!res.ok) return null;
      const j = (await res.json()) as { state?: State };
      return j.state ?? null;
    } catch {
      return null;
    }
  }, [token]);

  useEffect(() => {
    let active = true;
    void fetchState().then((s) => { if (active) setState(s); });
    return () => { active = false; };
  }, [fetchState]);

  // Mark this control "active" for its whole lifetime so the page's background auto-refresh
  // (ScheduleAutoRefresh) never remounts it — which also keeps it from interrupting the QR sheet or
  // an in-flight punch, both of which live inside this mounted control. See ./clockActivity.
  useEffect(() => acquireClockActivity(), []);

  if (state === null) return null;
  const actions = ACTIONS[state];
  if (actions.length === 0) return null;

  return (
    <>
      <div className="mt-2 flex flex-wrap gap-2">
        {actions.map((a) => (
          <button
            key={a.purpose}
            onClick={() => setSheet({ purpose: a.purpose })}
            className="rounded-md bg-tt-cyan px-3 py-1.5 text-xs font-semibold text-black hover:opacity-90"
          >
            {a.label}
          </button>
        ))}
      </div>
      {sheet && (
        <ClockSheet
          token={token}
          instanceId={instanceId}
          purpose={sheet.purpose}
          workerName={workerName}
          workerId={workerId}
          onClose={(confirmed) => {
            setSheet(null);
            void fetchState().then((s) => setState(s));
            if (confirmed) router.refresh();
          }}
        />
      )}
    </>
  );
}

function ClockSheet({
  token,
  instanceId,
  purpose,
  workerName,
  workerId,
  onClose,
}: {
  token: string;
  instanceId: string;
  purpose: Purpose;
  workerName: string;
  workerId: string;
  onClose: (confirmed: boolean) => void;
}) {
  const [svg, setSvg] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const [secs, setSecs] = useState(30);
  const wakeRef = useRef<WakeLockSentinel | null>(null);

  // Issue (or rotate) a code, then render it as a crisp SVG QR (ECC M, 4-module quiet zone).
  const issue = useCallback(async () => {
    try {
      const res = await fetch(`/s/${token}/clock`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shift_instance_id: instanceId, purpose }),
      });
      if (!res.ok) {
        // A legality/window rejection is terminal for this sheet; a network fail is "offline".
        setOffline(res.status === 0);
        if (res.status !== 0) { onClose(false); }
        return;
      }
      const j = (await res.json()) as { code: string };
      const s = await QRCode.toString(j.code, { type: 'svg', errorCorrectionLevel: 'M', margin: 4, width: 280 });
      setSvg(s);
      setOffline(false);
      setSecs(30);
    } catch {
      setOffline(true); // stop showing a stale QR; the render greys it out
    }
  }, [token, instanceId, purpose, onClose]);

  // Open: wake lock + first issue.
  useEffect(() => {
    (async () => {
      try { wakeRef.current = await navigator.wakeLock?.request('screen'); } catch { /* unsupported */ }
    })();
    void issue();
    return () => { try { void wakeRef.current?.release(); } catch { /* ignore */ } wakeRef.current = null; };
  }, [issue]);

  // Rotate every 30s + immediately on tab re-focus (a backgrounded timer drifts/stalls).
  useEffect(() => {
    const id = setInterval(() => void issue(), 30_000);
    const onVis = () => { if (document.visibilityState === 'visible') void issue(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', onVis); };
  }, [issue]);

  // 1s countdown to the next refresh (display only).
  useEffect(() => {
    const id = setInterval(() => setSecs((s) => (s > 0 ? s - 1 : 0)), 1000);
    return () => clearInterval(id);
  }, []);

  // Poll worker state every 3s; close the moment the punch lands (state reaches the expected value).
  useEffect(() => {
    const id = setInterval(async () => {
      try {
        const res = await fetch(`/s/${token}/clock`, { cache: 'no-store' });
        if (!res.ok) return;
        const j = (await res.json()) as { state?: State };
        if (j.state === EXPECTED_AFTER[purpose]) onClose(true);
      } catch { /* keep polling */ }
    }, 3000);
    return () => clearInterval(id);
  }, [token, purpose, onClose]);

  const heading =
    purpose === 'clock_in' ? 'Clock in' : purpose === 'clock_out' ? 'Clock out'
      : purpose === 'break_start' ? 'Start break' : 'End break';

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-white p-6 text-center text-gray-900">
      <p className="mb-1 text-sm font-medium uppercase tracking-wide text-gray-500">{heading} — show to the scanner</p>
      {offline ? (
        <div className="my-8 flex flex-col items-center">
          <div className="h-[280px] w-[280px] rounded-lg bg-gray-100" />
          <p className="mt-4 max-w-xs font-medium text-gray-700">No connection — use the station keypad.</p>
          <button onClick={() => void issue()} className="mt-3 rounded-md border border-gray-300 px-4 py-2 text-sm font-medium">Retry</button>
        </div>
      ) : svg ? (
        <>
          <div className="my-6" style={{ width: 280, height: 280 }} dangerouslySetInnerHTML={{ __html: svg }} />
          <p className="text-2xl font-semibold">{workerName}</p>
          <p className="text-sm text-gray-500">ID {workerId}</p>
          <p className="mt-3 text-xs text-gray-400">Refreshes in {secs}s</p>
        </>
      ) : (
        <div className="my-8 h-[280px] w-[280px] animate-pulse rounded-lg bg-gray-100" />
      )}
      <button onClick={() => onClose(false)} className="mt-8 rounded-lg border border-gray-300 px-6 py-2 font-medium text-gray-700">
        Cancel
      </button>
    </div>
  );
}
