'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import {
  ALLOWED_ACTIONS,
  TIME_CLOCK_ACTIONS,
  friendlyClockError,
  type AttendanceState,
  type TimeClockAction,
} from '@/lib/timeclock';
import SupervisorGate from './SupervisorGate';

// The badge-scan time clock. Runs as the dedicated 'timeclock' kiosk account; ALL data access is via
// /api/kiosk/* server routes (owner resolved server-side from app_metadata) — the client never
// queries employees or badges. Inverted flow: a scan IDENTIFIES the person, then only valid actions
// are offered; a scan NEVER clocks out. No optimistic UI — every card reflects a server-confirmed
// response, and a failed/timed-out request renders a loud red failure.

type ScanEnvelope = { ok: boolean; statusCode: number; data: Record<string, unknown>; failed?: 'timeout' | 'network' };

async function postJson(url: string, body: unknown, timeoutMs = 8000): Promise<ScanEnvelope> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { ok: res.ok, statusCode: res.status, data };
  } catch (e) {
    return { ok: false, statusCode: 0, data: {}, failed: (e as Error)?.name === 'AbortError' ? 'timeout' : 'network' };
  } finally {
    clearTimeout(t);
  }
}

type Result =
  | { kind: 'success'; title: string; sub?: string }
  | { kind: 'error'; title: string; sub?: string }
  | { kind: 'info'; title: string; sub?: string }
  | { kind: 'prompt'; name: string; badge: string };

type Overlay = null | 'lock' | 'manual-verify' | 'manual-pick';
type PickEmployee = { id: string; name: string; role: string | null; state: AttendanceState };

export default function BadgeKiosk() {
  const [status, setStatus] = useState<'idle' | 'pending' | 'result'>('idle');
  const [result, setResult] = useState<Result | null>(null);
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [manualCreds, setManualCreds] = useState<{ email: string; password: string } | null>(null);
  const [pickList, setPickList] = useState<PickEmployee[]>([]);
  const [pickBusy, setPickBusy] = useState(false);
  const [manualError, setManualError] = useState<string | null>(null);
  const [idleLocked, setIdleLocked] = useState(false);   // from /api/kiosk/window-state
  const [dismissedUntil, setDismissedUntil] = useState(0); // owner-dismiss grace (epoch ms)
  const [idleGate, setIdleGate] = useState(false);        // the unlock supervisor modal

  const overlayRef = useRef<Overlay>(null);
  const lockedRef = useRef(false);
  const bufferRef = useRef('');
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    overlayRef.current = overlay;
  }, [overlay]);

  const scheduleDismiss = useCallback((ms: number) => {
    if (dismissTimer.current) clearTimeout(dismissTimer.current);
    dismissTimer.current = setTimeout(() => {
      setStatus('idle');
      setResult(null);
    }, ms);
  }, []);

  // Apply a /api/kiosk/{scan,start-break,clock-out} response to the result card. `name` is the
  // employee identified by the preceding scan (used to personalise state-token messages).
  const applyResponse = useCallback(
    (env: ScanEnvelope, badge: string, name: string | null) => {
      setStatus('result');
      if (env.failed) {
        setResult({ kind: 'error', title: "Didn't go through", sub: 'Could not reach the server. Please scan again.' });
        scheduleDismiss(6000);
        return;
      }
      const data = env.data as { result?: string; employee_name?: string; code?: string; error?: string };
      if (!env.ok) {
        if (data.code === 'BADGE_NOT_RECOGNIZED') {
          // Unknown, revoked, inactive — identical generic message. No name.
          setResult({ kind: 'error', title: 'Badge not recognized', sub: 'See supervisor.' });
        } else if (data.code && data.code !== 'UNKNOWN' && data.code !== 'KIOSK_NOT_CONFIGURED') {
          setResult({ kind: 'error', title: friendlyClockError(data.code, name ?? 'This employee'), sub: undefined });
        } else {
          setResult({ kind: 'error', title: "Didn't go through", sub: data.error ?? 'Please try again.' });
        }
        scheduleDismiss(6000);
        return;
      }
      const who = data.employee_name ?? name ?? '';
      switch (data.result) {
        case 'clocked_in':
          setResult({ kind: 'success', title: `Welcome, ${who}`, sub: 'Clocked in.' });
          scheduleDismiss(5000);
          break;
        case 'break_ended':
          setResult({ kind: 'success', title: `Welcome back, ${who}`, sub: 'Break ended.' });
          scheduleDismiss(5000);
          break;
        case 'break_started':
          setResult({ kind: 'success', title: `Break started`, sub: who });
          scheduleDismiss(5000);
          break;
        case 'clocked_out':
          setResult({ kind: 'success', title: `Goodbye, ${who}`, sub: 'Clocked out.' });
          scheduleDismiss(5000);
          break;
        case 'prompt':
          // Working: offer Start break / Clock out. A scan never clocks out on its own.
          setResult({ kind: 'prompt', name: who, badge });
          scheduleDismiss(20000);
          break;
        case 'status':
          setResult({ kind: 'info', title: who, sub: 'Already recorded just now.' });
          scheduleDismiss(4000);
          break;
        default:
          setResult({ kind: 'info', title: who || 'Done', sub: undefined });
          scheduleDismiss(4000);
      }
    },
    [scheduleDismiss],
  );

  const handleScan = useCallback(
    async (raw: string) => {
      if (overlayRef.current || lockedRef.current) return; // ignore scans while a modal is open or idle-locked
      const badge = raw.trim().toUpperCase();
      if (!badge) return;
      if (dismissTimer.current) clearTimeout(dismissTimer.current);
      setStatus('pending');
      setResult(null);
      const env = await postJson('/api/kiosk/scan', { badge });
      applyResponse(env, badge, null);
    },
    [applyResponse],
  );

  // Document-level scan buffer: barcode scanners type fast and end with Enter. We also flush on a
  // ~100ms idle gap (Enter-less scanners). Keystrokes are IGNORED whenever a text field is focused
  // (the supervisor modal), so normal typing is never swallowed. The listener stays attached across
  // idle resets and modal open/close.
  useEffect(() => {
    const isTextField = (el: Element | null): boolean => {
      if (!el) return false;
      const tag = el.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (el as HTMLElement).isContentEditable;
    };
    const flush = () => {
      if (idleTimer.current) {
        clearTimeout(idleTimer.current);
        idleTimer.current = null;
      }
      const code = bufferRef.current;
      bufferRef.current = '';
      if (code) void handleScan(code);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (isTextField(document.activeElement)) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        flush();
        return;
      }
      if (e.key.length === 1) {
        bufferRef.current += e.key;
        if (idleTimer.current) clearTimeout(idleTimer.current);
        idleTimer.current = setTimeout(flush, 100);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      if (idleTimer.current) clearTimeout(idleTimer.current);
    };
  }, [handleScan]);

  useEffect(() => {
    return () => {
      if (dismissTimer.current) clearTimeout(dismissTimer.current);
    };
  }, []);

  // Idle auto-lock (Option B): poll window-state ~1/min. UNLOCKED if a scheduled shift window is
  // open OR anyone is on the clock; otherwise LOCKED. On a network error we keep the last state
  // (never flap the lock on a blip). Re-render on each poll re-evaluates the owner-dismiss grace.
  useEffect(() => {
    let active = true;
    const poll = async () => {
      try {
        const res = await fetch('/api/kiosk/window-state');
        const j = (await res.json().catch(() => ({}))) as { locked?: boolean };
        if (active && res.ok) setIdleLocked(!!j.locked);
      } catch {
        /* keep last state */
      }
    };
    void poll();
    const id = setInterval(poll, 60_000);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, []);

  // ── prompt actions (explicit buttons after a working scan) ──
  const promptAction = async (badge: string, name: string, action: 'start_break' | 'clock_out') => {
    if (dismissTimer.current) clearTimeout(dismissTimer.current);
    setStatus('pending');
    setResult(null);
    const url = action === 'start_break' ? '/api/kiosk/start-break' : '/api/kiosk/clock-out';
    const env = await postJson(url, { badge });
    applyResponse(env, badge, name);
  };

  // ── manual (supervisor-gated) override ──
  const openManual = () => {
    setManualError(null);
    setOverlay('manual-verify');
  };
  const onManualVerified = async (email: string, password: string) => {
    setManualCreds({ email, password });
    setPickBusy(true);
    setManualError(null);
    try {
      const res = await fetch('/api/kiosk/employees', { method: 'GET' });
      const j = (await res.json().catch(() => ({}))) as { employees?: PickEmployee[] };
      setPickList(Array.isArray(j.employees) ? j.employees : []);
      setOverlay('manual-pick');
    } catch {
      setManualError('Could not load employees.');
      setOverlay('manual-pick');
    } finally {
      setPickBusy(false);
    }
  };
  const closeManual = () => {
    setOverlay(null);
    setManualCreds(null);
    setPickList([]);
    setManualError(null);
  };
  const manualPunch = async (emp: PickEmployee, action: TimeClockAction) => {
    if (!manualCreds) return;
    setPickBusy(true);
    setManualError(null);
    const env = await postJson('/api/kiosk/manual-punch', {
      employee_id: emp.id,
      action,
      email: manualCreds.email,
      password: manualCreds.password,
    });
    setPickBusy(false);
    if (env.failed || !env.ok) {
      const data = env.data as { code?: string; error?: string };
      setManualError(env.failed ? 'Could not reach the server.' : data.error ?? 'Could not record that.');
      return;
    }
    closeManual();
    setStatus('result');
    const data = env.data as { result?: string; employee_name?: string };
    const who = data.employee_name ?? emp.name;
    setResult({ kind: 'success', title: who, sub: 'Recorded (manual).' });
    scheduleDismiss(5000);
  };

  // ── exit / lock (supervisor-gated) ──
  const onLockVerified = async () => {
    // Sign the KIOSK account out (allowed — this is signOut, never signIn) and return to /login.
    try {
      await createClient().auth.signOut();
    } catch {
      /* ignore */
    }
    window.location.href = '/login';
  };

  // Locked per window-state, minus any active owner-dismiss grace. Kept on a ref so the scan buffer
  // (a stable listener) can consult it without re-subscribing.
  const effectiveLocked = idleLocked && Date.now() >= dismissedUntil;
  lockedRef.current = effectiveLocked;

  return (
    <div className="flex min-h-screen flex-col bg-gray-950 text-white">
      <header className="flex items-center justify-between px-6 py-4">
        <h1 className="text-lg font-semibold tracking-tight">Time Clock</h1>
        <div className="flex gap-2">
          <button
            onClick={openManual}
            className="rounded-lg border border-gray-700 px-3 py-2 text-sm text-gray-300 hover:bg-gray-800"
          >
            Manual entry
          </button>
          <button
            onClick={() => setOverlay('lock')}
            className="rounded-lg border border-gray-700 px-3 py-2 text-sm text-gray-300 hover:bg-gray-800"
          >
            Lock
          </button>
        </div>
      </header>

      <main className="flex flex-1 items-center justify-center px-6 pb-16">
        {status === 'idle' && (
          <div className="text-center">
            <div className="mb-6 text-7xl">📇</div>
            <p className="text-3xl font-medium text-gray-200">Scan your badge</p>
            <p className="mt-2 text-gray-500">Hold your badge up to the scanner</p>
          </div>
        )}

        {status === 'pending' && (
          <div className="text-center">
            <p className="text-3xl font-medium text-gray-300">One moment…</p>
          </div>
        )}

        {status === 'result' && result && (
          <ResultCard
            result={result}
            onStartBreak={(badge, name) => promptAction(badge, name, 'start_break')}
            onClockOut={(badge, name) => promptAction(badge, name, 'clock_out')}
          />
        )}
      </main>

      {/* Idle auto-lock overlay (Option B). Distinct from the manual Lock button above: the owner
          password DISMISSES this back to scanning (stays signed in) for a short grace, whereas Lock
          signs the account out. Covers the whole screen, so scanning + the header are blocked. */}
      {effectiveLocked && !idleGate && (
        <div className="fixed inset-0 z-40 flex flex-col items-center justify-center bg-gray-950 px-6 text-center">
          <div className="mb-6 text-6xl">🔒</div>
          <p className="text-3xl font-semibold text-gray-100">Kiosk locked</p>
          <p className="mt-3 max-w-md text-gray-400">
            No scheduled shift right now. Working an unscheduled shift? A supervisor must add it to the
            schedule — or unlock with the owner password to punch.
          </p>
          <button
            onClick={() => setIdleGate(true)}
            className="mt-8 rounded-xl border border-gray-600 px-6 py-3 text-lg font-medium text-gray-200 hover:bg-gray-800"
          >
            Unlock (supervisor)
          </button>
        </div>
      )}
      {idleGate && (
        <SupervisorGate
          title="Unlock kiosk"
          submitLabel="Unlock"
          onCancel={() => setIdleGate(false)}
          onVerified={() => {
            setDismissedUntil(Date.now() + 5 * 60_000); // 5-min grace so a worker can punch (their open entry then keeps it awake)
            setIdleGate(false);
          }}
        />
      )}

      {overlay === 'lock' && (
        <SupervisorGate title="Exit kiosk" submitLabel="Exit" onCancel={() => setOverlay(null)} onVerified={onLockVerified} />
      )}
      {overlay === 'manual-verify' && (
        <SupervisorGate
          title="Manual entry"
          submitLabel="Unlock"
          onCancel={() => setOverlay(null)}
          onVerified={onManualVerified}
        />
      )}
      {overlay === 'manual-pick' && (
        <ManualPicker
          employees={pickList}
          busy={pickBusy}
          error={manualError}
          onPunch={manualPunch}
          onClose={closeManual}
        />
      )}
    </div>
  );
}

function ResultCard({
  result,
  onStartBreak,
  onClockOut,
}: {
  result: Result;
  onStartBreak: (badge: string, name: string) => void;
  onClockOut: (badge: string, name: string) => void;
}) {
  if (result.kind === 'prompt') {
    return (
      <div className="w-full max-w-md text-center">
        <p className="mb-1 text-sm uppercase tracking-wide text-gray-500">Hello</p>
        <p className="mb-8 text-4xl font-semibold">{result.name}</p>
        <div className="grid grid-cols-2 gap-4">
          <button
            onClick={() => onStartBreak(result.badge, result.name)}
            className="rounded-2xl bg-amber-500 px-6 py-8 text-2xl font-semibold text-black"
          >
            Start Break
          </button>
          <button
            onClick={() => onClockOut(result.badge, result.name)}
            className="rounded-2xl bg-rose-600 px-6 py-8 text-2xl font-semibold text-white"
          >
            Clock Out
          </button>
        </div>
      </div>
    );
  }
  const palette =
    result.kind === 'success'
      ? 'bg-emerald-600'
      : result.kind === 'error'
        ? 'bg-red-600'
        : 'bg-gray-700';
  return (
    <div className={`w-full max-w-md rounded-3xl ${palette} px-8 py-12 text-center shadow-2xl`}>
      <p className="text-4xl font-bold">{result.title}</p>
      {result.sub && <p className="mt-3 text-xl text-white/90">{result.sub}</p>}
    </div>
  );
}

function ManualPicker({
  employees,
  busy,
  error,
  onPunch,
  onClose,
}: {
  employees: PickEmployee[];
  busy: boolean;
  error: string | null;
  onPunch: (emp: PickEmployee, action: TimeClockAction) => void;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-gray-900 p-4 text-white">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-xl font-semibold">Manual entry — pick an employee</h2>
        <button onClick={onClose} className="rounded-lg border border-gray-600 px-4 py-2 text-gray-200">
          Done
        </button>
      </div>
      {error && <p className="mb-3 rounded-lg bg-red-900/60 px-3 py-2 text-sm text-red-200">{error}</p>}
      <div className="grid flex-1 grid-cols-1 gap-2 overflow-y-auto sm:grid-cols-2">
        {employees.map((emp) => {
          const actions = ALLOWED_ACTIONS[emp.state];
          return (
            <div key={emp.id} className="rounded-xl border border-gray-700 bg-gray-800 p-3">
              <div className="mb-2 flex items-baseline justify-between">
                <span className="text-lg font-medium">{emp.name}</span>
                <span className="text-xs uppercase text-gray-400">{emp.state.replace('_', ' ')}</span>
              </div>
              <div className="flex flex-wrap gap-2">
                {actions.map((a) => (
                  <button
                    key={a}
                    disabled={busy}
                    onClick={() => onPunch(emp, a)}
                    className="rounded-lg bg-gray-100 px-3 py-2 text-sm font-medium text-gray-900 disabled:opacity-50"
                  >
                    {TIME_CLOCK_ACTIONS.find((m) => m.action === a)?.label ?? a}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
        {employees.length === 0 && !busy && <p className="text-gray-400">No active employees.</p>}
      </div>
    </div>
  );
}
