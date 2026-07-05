'use client';

/**
 * /fulfillment — device boot + "select your name".
 * Boot: read device (localStorage) → validate-device (revoked → re-provision) → boot backstop
 * (auto-end stale shifts for this device: working w/ updated_at >10m → idle; on_break open
 * break >60m → break_timeout) → restore active shift (→ /pick|/pack) OR show the roster
 * filtered by device kind + role eligibility (active only). Tap name → start-shift → /pick|/pack.
 */

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';

const IDLE_MS = 10 * 60 * 1000, BREAKCAP_MS = 60 * 60 * 1000;
type Device = { device_id: string; kind: 'picker' | 'packer'; token: string };
type WorkerRow = { id: string; name: string; role: string };
function readDevice(): Device | null { try { return JSON.parse(localStorage.getItem('lensed.fulfillment.device') || 'null'); } catch { return null; } }

export default function FulfillmentHome() {
  const router = useRouter();
  const supabase = createClient();
  const [phase, setPhase] = useState<'loading' | 'revoked' | 'roster'>('loading');
  const [device, setDevice] = useState<Device | null>(null);
  const [workers, setWorkers] = useState<WorkerRow[]>([]);
  const [busy, setBusy] = useState(false);

  const endShiftApi = (shiftId: string, reason: string) =>
    fetch('/api/fulfillment/end-shift', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ shiftId, reason }) });

  const boot = useCallback(async () => {
    const d = readDevice();
    if (!d) { router.replace('/fulfillment/provision'); return; }
    setDevice(d);

    const v = await (await fetch('/api/fulfillment/validate-device', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: d.token }) })).json();
    if (!v.valid) { setPhase('revoked'); return; }

    // Boot backstop — auto-end stale shifts (covers a device that was closed mid-shift).
    const now = Date.now();
    const { data: open } = await supabase.from('fulfillment_shifts').select('id, state, updated_at').eq('device_id', d.device_id).in('state', ['working', 'on_break']);
    for (const s of open ?? []) {
      if (s.state === 'working' && now - new Date(s.updated_at as string).getTime() > IDLE_MS) {
        await endShiftApi(s.id as string, 'idle');
      } else if (s.state === 'on_break') {
        const { data: brk } = await supabase.from('fulfillment_shift_breaks').select('started_at').eq('shift_id', s.id).is('ended_at', null).order('started_at', { ascending: false }).limit(1).maybeSingle();
        if (brk && now - new Date(brk.started_at as string).getTime() > BREAKCAP_MS) await endShiftApi(s.id as string, 'break_timeout');
      }
    }

    // Restore a still-active shift → straight to its page.
    const { data: active } = await supabase.from('fulfillment_shifts').select('id, mode').eq('device_id', d.device_id).in('state', ['working', 'on_break']).order('started_at', { ascending: false }).limit(1).maybeSingle();
    if (active) { router.replace(active.mode === 'packer' ? '/pack' : '/pick'); return; }

    // Roster: eligible for this device kind, active only.
    const roles = d.kind === 'picker' ? ['picker', 'both'] : ['packer', 'both'];
    const { data: w } = await supabase.from('fulfillment_workers').select('id, name, role').eq('is_active', true).in('role', roles).order('name');
    setWorkers((w as WorkerRow[]) ?? []); setPhase('roster');
  }, [router, supabase]);

  useEffect(() => { boot(); }, [boot]);

  async function pickName(workerId: string) {
    if (!device) return;
    setBusy(true);
    const res = await fetch('/api/fulfillment/start-shift', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceId: device.device_id, workerId }) });
    const json = await res.json();
    setBusy(false);
    if (!res.ok) { setPhase('roster'); alert(json.error === 'INELIGIBLE' ? json.message : (json.message || 'Could not start shift')); return; }
    router.replace(json.mode === 'packer' ? '/pack' : '/pick');
  }

  if (phase === 'loading') return <div className="min-h-screen bg-tt-bg flex items-center justify-center text-tt-muted">Loading…</div>;
  if (phase === 'revoked') return (
    <div className="min-h-screen bg-tt-bg text-tt-text flex flex-col items-center justify-center p-8 text-center">
      <div className="text-2xl font-bold text-tt-red mb-2">This device was revoked</div>
      <div className="text-tt-muted mb-6">Ask an owner to re-provision it.</div>
      <button onClick={() => { localStorage.removeItem('lensed.fulfillment.device'); router.replace('/fulfillment/provision'); }}
        className="px-6 py-3 rounded-xl bg-tt-cyan text-black font-semibold">Re-provision</button>
    </div>
  );
  return (
    <div className="min-h-screen bg-tt-bg text-tt-text p-6">
      <div className="max-w-md mx-auto">
        <h1 className="text-2xl font-bold mb-1">Select your name</h1>
        <p className="text-sm text-tt-muted mb-5">{device?.kind === 'packer' ? 'Pack station' : 'Pick device'}</p>
        <div className="space-y-2">
          {workers.length === 0 && <div className="text-tt-muted text-sm">No eligible workers. Ask an owner to add you in Settings → Workers.</div>}
          {workers.map((w) => (
            <button key={w.id} disabled={busy} onClick={() => pickName(w.id)}
              className="w-full text-left rounded-xl border border-tt-border bg-tt-card p-4 active:bg-tt-card-hover text-lg font-medium disabled:opacity-50">
              {w.name} <span className="text-xs text-tt-muted">({w.role})</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
