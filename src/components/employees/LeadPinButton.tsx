'use client';

import { useState } from 'react';

// Make someone a lead, or stop them being one.
//
// There is no separate "lead" flag: HAVING an override PIN is the authorisation, and clearing
// it is how you revoke. That keeps authority out of employees.role, which feeds payroll and is
// constrained to pay-role classes — putting it there could move money.
//
// Per-person PINs, never one shared code. A shared code becomes floor knowledge inside a
// month, and from then on pickers self-authorise while the log still reads "authorised". With
// a PIN each, the authorising lead can be cross-checked against who was actually clocked in.

export function LeadPinButton({
  employeeId,
  employeeName,
  hasPin,
  onSet,
}: {
  employeeId: string;
  employeeName: string;
  hasPin: boolean;
  onSet: (employeeId: string, pin: string | null) => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  const [pin, setPin] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const close = () => { setOpen(false); setPin(''); setErr(null); };

  const run = async (value: string | null) => {
    setBusy(true);
    setErr(null);
    try {
      await onSet(employeeId, value);
      close();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title={hasPin ? `${employeeName} can authorise pick overrides` : 'Give a PIN to make this person a lead'}
        className={`rounded px-2 py-1 text-xs font-medium transition-colors cursor-pointer ${
          hasPin
            ? 'bg-tt-green/15 text-tt-green hover:bg-tt-green/25'
            : 'border border-tt-border text-tt-muted hover:text-tt-text'
        }`}
      >
        {hasPin ? 'Lead ✓' : 'Make lead'}
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6">
          <div className="w-full max-w-sm rounded-2xl border border-tt-border bg-tt-card p-5">
            <div className="text-base font-semibold text-tt-text">
              {hasPin ? `${employeeName}'s override PIN` : `Make ${employeeName} a lead`}
            </div>
            <p className="mt-1 text-xs text-tt-muted">
              A lead types this PIN on the pick screen to let a picker past a section label they
              cannot scan. Every use is recorded against their name.
            </p>

            <input
              autoFocus
              value={pin}
              onChange={(e) => { setPin(e.target.value.replace(/\D/g, '').slice(0, 8)); setErr(null); }}
              inputMode="numeric"
              placeholder={hasPin ? 'New PIN (4–8 digits)' : 'PIN (4–8 digits)'}
              className="mt-4 w-full rounded-xl border border-tt-border bg-tt-card px-3 py-2 text-center text-2xl tracking-[0.4em] text-tt-text"
            />
            <p className="mt-1 text-[11px] text-tt-muted">
              {hasPin
                ? 'Setting a new PIN replaces the old one. The current PIN cannot be shown — it is stored hashed.'
                : 'It is stored hashed and can never be read back, only replaced.'}
            </p>

            {err && <div className="mt-2 text-sm text-tt-red">{err}</div>}

            <div className="mt-4 flex flex-wrap gap-2">
              <button
                onClick={close}
                disabled={busy}
                className="flex-1 rounded-xl border border-tt-border py-2 text-sm text-tt-muted disabled:opacity-40 cursor-pointer"
              >
                Cancel
              </button>
              <button
                onClick={() => run(pin)}
                disabled={busy || pin.length < 4}
                className="flex-1 rounded-xl bg-tt-green py-2 text-sm font-bold text-black disabled:opacity-40 cursor-pointer"
              >
                {busy ? 'Saving…' : hasPin ? 'Replace PIN' : 'Make lead'}
              </button>
            </div>

            {hasPin && (
              <button
                onClick={() => run(null)}
                disabled={busy}
                className="mt-2 w-full rounded-xl border border-tt-red py-2 text-xs font-bold text-tt-red disabled:opacity-40 cursor-pointer"
              >
                Remove lead — {employeeName} can no longer authorise overrides
              </button>
            )}
          </div>
        </div>
      )}
    </>
  );
}
