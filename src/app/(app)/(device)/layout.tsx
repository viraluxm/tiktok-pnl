'use client';

/**
 * (device) shell — wraps /pick & /pack (URLs unchanged; route group).
 * Gate: no device → /fulfillment/provision; no active shift → /fulfillment.
 * Provides useFulfillmentShift() context, the shift header (Break/End), and the timers:
 *   - idle 10-min auto-end (working only), reset by any pointerdown/keydown (global listener)
 *   - break-cap 60-min auto-end (on_break)
 *   - ~60s heartbeat bumping the shift's updated_at (feeds the boot backstop in /fulfillment)
 * Shift is restored from the DB on mount (source of truth); localStorage caches device only.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { FulfillmentShiftContext } from '@/lib/fulfillment/shiftContext';

const IDLE_MS = 10 * 60 * 1000, BREAKCAP_MS = 60 * 60 * 1000, HEARTBEAT_MS = 60 * 1000;
type Shift = { shiftId: string; workerId: string; workerName: string; mode: 'picker' | 'packer'; state: 'working' | 'on_break' };
function readDevice(): { device_id: string; kind: 'picker' | 'packer'; token: string } | null {
  try { return JSON.parse(localStorage.getItem('lensed.fulfillment.device') || 'null'); } catch { return null; }
}

export default function DeviceShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const supabase = createClient();
  const [ready, setReady] = useState(false);
  const [shift, setShift] = useState<Shift | null>(null);
  const shiftRef = useRef<Shift | null>(null);
  const idleRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const breakRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const hbRef = useRef<ReturnType<typeof setInterval>>(undefined);

  const api = async (path: string, body: unknown) => fetch(`/api/fulfillment/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  const endShift = useCallback(async (reason: 'manual' | 'idle' | 'break_timeout') => {
    const s = shiftRef.current; if (!s) return;
    clearTimeout(idleRef.current); clearTimeout(breakRef.current); clearInterval(hbRef.current);
    await api('end-shift', { shiftId: s.shiftId, reason });
    shiftRef.current = null; setShift(null);
    router.replace('/fulfillment');
  }, [router]);

  const armIdle = useCallback(() => {
    clearTimeout(idleRef.current);
    if (shiftRef.current?.state === 'working') idleRef.current = setTimeout(() => endShift('idle'), IDLE_MS);
  }, [endShift]);

  // Boot: device + restore active shift from DB.
  useEffect(() => {
    const device = readDevice();
    if (!device) { router.replace('/fulfillment/provision'); return; }
    (async () => {
      const { data } = await supabase
        .from('fulfillment_shifts').select('id, worker_id, mode, state, started_at')
        .eq('device_id', device.device_id).in('state', ['working', 'on_break'])
        .order('started_at', { ascending: false }).limit(1).maybeSingle();
      if (!data) { router.replace('/fulfillment'); return; }
      const { data: w } = await supabase.from('fulfillment_workers').select('name').eq('id', data.worker_id).maybeSingle();
      const s: Shift = { shiftId: data.id as string, workerId: data.worker_id as string, workerName: (w?.name as string) ?? 'Worker', mode: data.mode as 'picker' | 'packer', state: data.state as 'working' | 'on_break' };
      shiftRef.current = s; setShift(s); setReady(true);
    })();
    return () => { clearTimeout(idleRef.current); clearTimeout(breakRef.current); clearInterval(hbRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Timers + global activity listener whenever the shift/state changes.
  useEffect(() => {
    if (!shift) return;
    shiftRef.current = shift;
    clearInterval(hbRef.current);
    hbRef.current = setInterval(() => {
      if (shiftRef.current?.state === 'working') supabase.from('fulfillment_shifts').update({ state: 'working' }).eq('id', shift.shiftId).then(() => {});
    }, HEARTBEAT_MS);
    if (shift.state === 'working') { clearTimeout(breakRef.current); armIdle(); }
    else { clearTimeout(idleRef.current); clearTimeout(breakRef.current); breakRef.current = setTimeout(() => endShift('break_timeout'), BREAKCAP_MS); }
    const onAct = () => armIdle();
    document.addEventListener('pointerdown', onAct); document.addEventListener('keydown', onAct);
    return () => { document.removeEventListener('pointerdown', onAct); document.removeEventListener('keydown', onAct); clearInterval(hbRef.current); };
  }, [shift, armIdle, endShift, supabase]);

  async function doBreak() { const s = shiftRef.current; if (!s) return; await api('shift/break', { shiftId: s.shiftId }); const ns = { ...s, state: 'on_break' as const }; shiftRef.current = ns; setShift(ns); }
  async function doResume() { const s = shiftRef.current; if (!s) return; await api('shift/resume', { shiftId: s.shiftId }); const ns = { ...s, state: 'working' as const }; shiftRef.current = ns; setShift(ns); }

  if (!ready || !shift) return <div className="min-h-screen bg-tt-bg flex items-center justify-center text-tt-muted">Loading shift…</div>;

  return (
    <FulfillmentShiftContext.Provider value={{ shiftId: shift.shiftId, workerId: shift.workerId, workerName: shift.workerName, mode: shift.mode, state: shift.state, markActivity: armIdle }}>
      <div className="min-h-screen bg-tt-bg">
        <header className="sticky top-0 z-40 flex items-center justify-between bg-tt-card border-b border-tt-border px-4 py-2">
          <div className="text-sm"><span className="font-semibold">{shift.workerName}</span> · <span className="text-tt-muted">{shift.mode}</span></div>
          <div className="flex gap-2">
            {shift.state === 'working'
              ? <button onClick={doBreak} className="px-3 py-1 rounded-lg border border-tt-border text-tt-muted text-sm">Break</button>
              : <button onClick={doResume} className="px-3 py-1 rounded-lg bg-tt-cyan text-black text-sm font-semibold">Resume</button>}
            <button onClick={() => endShift('manual')} className="px-3 py-1 rounded-lg border border-tt-red/40 text-tt-red text-sm">End shift</button>
          </div>
        </header>
        {shift.state === 'on_break'
          ? (
            <div className="min-h-[70vh] flex flex-col items-center justify-center text-center p-8">
              <div className="text-4xl font-bold mb-2">On break</div>
              <div className="text-tt-muted mb-6">Scanning paused. Resume when you&apos;re back.</div>
              <button onClick={doResume} className="px-8 py-4 rounded-2xl bg-tt-cyan text-black text-xl font-bold">Resume</button>
            </div>
          )
          : children}
      </div>
    </FulfillmentShiftContext.Provider>
  );
}
