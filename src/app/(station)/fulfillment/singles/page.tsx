'use client';

import { useEffect, useRef, useState } from 'react';

// SINGLES PREP STATION — credit a finished pile by scanning its header slip.
//
// Its OWN route, deliberately not a mode inside PackStationOverlay: that overlay is the live
// packing path and this needed none of its machinery. A separate screen also means the prep bench
// can sit on a device that never enters the pack flow at all.
//
// UNDER /fulfillment ON PURPOSE. The station role is hard-confined by middleware to
// STATION_CONFINEMENT = { allow: ['/fulfillment', '/api/station'] }, and isPathAllowed()
// prefix-matches, so /fulfillment/singles is reachable with NO middleware change. A top-level
// /singles would have needed the allowlist widened — an app-wide-blast-radius edit for a screen
// that fits perfectly well inside the namespace the station already owns.
//
// SCAN WHEN THE PILE IS FINISHED, not when it is started. Stated on screen, because the whole
// meaning of the number depends on it: a scan at the start would credit work not yet done, and
// anyone pulled away mid-pile would keep the full count.

interface Picker { id: string; name: string }

interface Result {
  batch: { code: string; caption: string };
  picker: string;
  printed: number;
  credited: number;
  already_counted: number;
  blocked: number;
}

const PICKER_KEY = 'lensed_singles_picker';

export default function SinglesStationPage() {
  const [pickers, setPickers] = useState<Picker[]>([]);
  const [pickerId, setPickerId] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [todayCredited, setTodayCredited] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetch('/api/station/employees')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setPickers((d?.employees ?? []) as Picker[]))
      .catch(() => { /* the gate below shows the empty state */ });
    try {
      const saved = localStorage.getItem(PICKER_KEY);
      if (saved) setPickerId(saved);
    } catch { /* private mode — the packer just picks again */ }
  }, []);

  // Keep focus on the input: a barcode scanner is a keyboard, and a blurred field silently drops
  // the scan. Refocus after every result so piles can be run back to back without touching it.
  useEffect(() => { inputRef.current?.focus(); }, [result, error, pickerId]);

  function choosePicker(id: string) {
    setPickerId(id);
    setResult(null);
    setError(null);
    try { localStorage.setItem(PICKER_KEY, id); } catch { /* non-fatal */ }
  }

  async function submit(scanned: string) {
    const value = scanned.trim();
    if (!value || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/station/singles-scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: value, picker_employee_id: pickerId }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(j.error ?? 'That scan did not work.'); setResult(null); }
      else { setResult(j as Result); setTodayCredited((n) => n + (j.credited ?? 0)); }
    } catch {
      setError('Could not reach the server — check the connection and scan again.');
    } finally {
      setBusy(false);
      setCode('');
    }
  }

  const picker = pickers.find((p) => p.id === pickerId);

  // Who is packing comes first: without it a scan cannot be credited to anyone, which is the exact
  // problem this screen exists to fix.
  if (!pickerId) {
    return (
      <Shell>
        <h1 className="text-2xl font-bold text-tt-text mb-1">Singles prep</h1>
        <p className="text-sm text-tt-muted mb-6">Who is packing?</p>
        {pickers.length === 0 ? (
          <p className="text-sm text-tt-muted">No pickers on the roster yet.</p>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
            {pickers.map((p) => (
              <button
                key={p.id}
                onClick={() => choosePicker(p.id)}
                className="min-h-[64px] px-4 py-3 rounded-2xl border border-tt-border bg-tt-card text-tt-text font-semibold hover:bg-tt-card-hover transition-colors cursor-pointer"
              >{p.name}</button>
            ))}
          </div>
        )}
      </Shell>
    );
  }

  return (
    <Shell>
      <div className="flex items-baseline justify-between gap-3 mb-1 flex-wrap">
        <h1 className="text-2xl font-bold text-tt-text">Singles prep</h1>
        <button
          onClick={() => choosePicker('')}
          className="text-xs text-tt-muted underline underline-offset-2 cursor-pointer"
        >{picker?.name ?? 'Change'} · switch</button>
      </div>
      <p className="text-sm text-tt-muted mb-5">
        Scan the slip <strong className="text-tt-text">when the pile is finished</strong>.
      </p>

      <form
        onSubmit={(e) => { e.preventDefault(); void submit(code); }}
        className="mb-5"
      >
        <input
          ref={inputRef}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          disabled={busy}
          placeholder="Scan the slip barcode"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          className="w-full min-h-[64px] px-4 rounded-2xl bg-tt-input-bg border border-tt-input-border text-tt-text text-xl tracking-wide placeholder:text-tt-muted/60 focus:outline-none focus:border-tt-cyan/50 disabled:opacity-50"
        />
      </form>

      {busy && <p className="text-sm text-tt-muted">Crediting…</p>}

      {error && (
        <div className="rounded-2xl border border-tt-red/40 bg-tt-red/10 px-4 py-4">
          <p className="text-tt-red font-semibold">{error}</p>
        </div>
      )}

      {result && !error && (
        <div className="rounded-2xl border border-tt-border bg-tt-card px-4 py-4">
          <div className="text-xs uppercase tracking-wide text-tt-muted">{result.batch.caption}</div>
          <div className="mt-1 text-4xl font-extrabold text-tt-green tabular-nums leading-none">
            +{result.credited}
          </div>
          <div className="mt-2 text-sm text-tt-text">
            credited to <strong>{result.picker}</strong>
          </div>

          {/* The slip says "148 LABELS". If some were already confirmed at the pack station the
              honest answer is 130 of 148 — a headline that quietly disagreed with the paper in
              their hand is how people stop trusting the number. */}
          {(result.already_counted > 0 || result.blocked > 0 || result.credited !== result.printed) && (
            <div className="mt-2 text-xs text-tt-muted leading-relaxed">
              {result.credited} of {result.printed} on the slip
              {result.already_counted > 0 && <> · {result.already_counted} already counted</>}
              {result.blocked > 0 && (
                <> · <span className="text-tt-yellow">{result.blocked} refunded or cancelled — do not ship</span></>
              )}
            </div>
          )}

          {result.credited === 0 && (
            <p className="mt-2 text-xs text-tt-yellow">
              Nothing new to credit — this pile was already counted.
            </p>
          )}
        </div>
      )}

      {todayCredited > 0 && (
        <p className="mt-5 text-xs text-tt-muted">
          {todayCredited.toLocaleString()} credited on this device since it was opened.
        </p>
      )}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-tt-bg px-5 py-7">
      <div className="mx-auto max-w-lg">{children}</div>
    </div>
  );
}
