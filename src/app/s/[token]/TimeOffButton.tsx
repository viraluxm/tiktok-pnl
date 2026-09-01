'use client';

import { useCallback, useState } from 'react';

// Top-right "Time off" control on the worker's schedule link, plus the request sheet.
//
// The sheet is deliberately thin: two dates and an optional reason. The deadline rule lives on the
// server (checkTimeOffWindow); `earliest` from GET only sets the picker's `min` so the form does
// not invite a request that will be refused. A refusal still renders the server's own message,
// because the server clock is the one that decides.

interface TimeOffRequest {
  id: string;
  start_date: string;
  end_date: string;
  reason: string | null;
  status: 'pending' | 'approved' | 'denied';
  decision_note: string | null;
}

function fmt(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC',
  });
}

const STATUS_STYLE: Record<TimeOffRequest['status'], string> = {
  pending: 'border-tt-yellow/50 text-tt-yellow',
  approved: 'border-tt-green/50 text-tt-green',
  denied: 'border-tt-muted/40 text-tt-muted',
};

export default function TimeOffButton({ token }: { token: string }) {
  const [open, setOpen] = useState(false);
  const [requests, setRequests] = useState<TimeOffRequest[]>([]);
  const [earliest, setEarliest] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    const res = await fetch(`/s/${token}/time-off`);
    if (!res.ok) return;
    const j = await res.json();
    setRequests(j.requests ?? []);
    setEarliest(j.earliest ?? '');
  }, [token]);

  // Fetched on the click that opens the sheet rather than in an effect keyed on `open`.
  // Opening IS the event, so there is no external system to synchronise to here — and doing it
  // in an effect would setState synchronously during render, cascading a second render for no
  // reason (react-hooks/set-state-in-effect).
  const openSheet = useCallback(() => { setOpen(true); void load(); }, [load]);

  async function submit() {
    if (!start) { setError('Pick a first day.'); return; }
    setBusy(true); setError('');
    const res = await fetch(`/s/${token}/time-off`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ start_date: start, end_date: end || start, reason }),
    });
    const j = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) { setError(j.error ?? 'Could not send that request.'); return; }
    setStart(''); setEnd(''); setReason('');
    void load();
  }

  async function withdraw(id: string) {
    setBusy(true);
    await fetch(`/s/${token}/time-off`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    setBusy(false);
    void load();
  }

  const pendingCount = requests.filter((r) => r.status === 'pending').length;

  return (
    <>
      <button
        type="button"
        onClick={openSheet}
        className="flex shrink-0 items-center gap-1.5 rounded-lg border border-tt-border px-3 py-1.5 text-xs font-semibold text-tt-text"
      >
        Time off
        {pendingCount > 0 && (
          <span className="rounded-full bg-tt-yellow px-1.5 text-[10px] font-bold text-black">{pendingCount}</span>
        )}
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 sm:items-center sm:p-8"
          onClick={() => setOpen(false)}
          role="dialog" aria-modal="true" aria-label="Time off"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="max-h-[85vh] w-full max-w-md overflow-y-auto rounded-t-2xl border border-tt-border bg-tt-card p-4 sm:rounded-2xl"
          >
            <div className="mb-3 flex items-start justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold text-tt-text">Request time off</h2>
                {earliest && (
                  <p className="mt-0.5 text-[11px] text-tt-muted">
                    Earliest you can request: {fmt(earliest)}. Schedules are built two weeks ahead.
                  </p>
                )}
              </div>
              <button
                type="button" onClick={() => setOpen(false)} aria-label="Close"
                className="h-8 w-8 shrink-0 rounded-lg border border-tt-border text-tt-muted"
              >✕</button>
            </div>

            <div className="space-y-2.5">
              <div className="flex gap-2">
                <label className="flex-1 text-[10px] uppercase tracking-wide text-tt-muted">
                  First day
                  <input
                    type="date" value={start} min={earliest || undefined}
                    onChange={(e) => setStart(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-tt-input-border bg-tt-input-bg px-2 py-2 text-sm text-tt-text"
                  />
                </label>
                <label className="flex-1 text-[10px] uppercase tracking-wide text-tt-muted">
                  Last day <span className="normal-case text-tt-muted/70">(optional)</span>
                  <input
                    type="date" value={end} min={start || earliest || undefined}
                    onChange={(e) => setEnd(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-tt-input-border bg-tt-input-bg px-2 py-2 text-sm text-tt-text"
                  />
                </label>
              </div>
              <input
                type="text" value={reason} maxLength={300}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Reason (optional)"
                className="w-full rounded-lg border border-tt-input-border bg-tt-input-bg px-2 py-2 text-sm text-tt-text placeholder:text-tt-muted/60"
              />
              {error && <p className="text-xs text-tt-magenta-soft">{error}</p>}
              <button
                type="button" onClick={submit} disabled={busy || !start}
                className="w-full rounded-lg bg-tt-cyan py-2.5 text-sm font-semibold text-black disabled:opacity-40"
              >
                {busy ? 'Sending…' : 'Send request'}
              </button>
            </div>

            {requests.length > 0 && (
              <div className="mt-5">
                <h3 className="mb-2 text-[10px] font-bold uppercase tracking-wider text-tt-muted">Your requests</h3>
                <div className="space-y-1.5">
                  {requests.map((r) => (
                    <div key={r.id} className="rounded-xl border border-tt-border bg-white/[0.02] px-3 py-2">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[13px] font-semibold text-tt-text">
                          {fmt(r.start_date)}{r.end_date !== r.start_date && ` – ${fmt(r.end_date)}`}
                        </span>
                        <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-bold capitalize ${STATUS_STYLE[r.status]}`}>
                          {r.status}
                        </span>
                      </div>
                      {r.reason && <div className="mt-0.5 text-[11px] text-tt-muted">{r.reason}</div>}
                      {r.decision_note && <div className="mt-0.5 text-[11px] text-tt-muted">Manager: {r.decision_note}</div>}
                      {r.status === 'pending' && (
                        <button
                          type="button" onClick={() => withdraw(r.id)} disabled={busy}
                          className="mt-1 text-[11px] font-semibold text-tt-muted underline disabled:opacity-40"
                        >Withdraw</button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
