'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { fmtDateLA, fmtTimeRangeLA, isOvernight } from '@/lib/schedule/format';

// Phase 2 employee controls: Drop Shift, Cancel Offer, and Pick Up Shift.
//
// Same shape as parts.tsx — plain fetch to our own /s/[token]/* endpoints, no Supabase client on
// this page (no auth session; see CLAUDE.md). Kept in a separate file so the legacy Release/Claim
// controls stay untouched while both flows coexist.
//
// VOCABULARY. Employee-facing copy never says "release", "claim", "instance" or "materialize".
// A dropped shift is OFFERED and the worker is told, in as many words, that it is still theirs.

async function post(url: string, body: unknown): Promise<{ ok: boolean; data: Record<string, unknown> }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, data };
}

const sheet = 'fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm';
const card = 'w-full max-w-sm rounded-[16px] border border-tt-border bg-tt-card p-5 shadow-2xl';
const cancelBtn = 'flex-1 rounded-xl bg-white/5 py-2.5 text-sm font-semibold text-tt-muted transition-colors hover:bg-white/10 hover:text-tt-text';

function ShiftFacts({ startsAt, endsAt }: { startsAt: string; endsAt: string }) {
  return (
    <div className="my-3 rounded-lg border border-tt-border bg-white/[0.02] px-3 py-2">
      <p className="text-sm font-medium text-tt-text">{fmtDateLA(startsAt)}</p>
      <p className="text-xs text-tt-muted">
        {fmtTimeRangeLA(startsAt, endsAt)}
        {isOvernight(startsAt, endsAt) && <span className="ml-1.5">🌙 +1d</span>}
      </p>
    </div>
  );
}

/** DROP SHIFT — offers the shift while it stays yours. */
export function DropShiftButton({
  token, instanceId, startsAt, endsAt,
}: { token: string; instanceId: string; startsAt: string; endsAt: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    setBusy(true); setErr(null);
    const { ok, data } = await post(`/s/${token}/offer`, { instanceId });
    setBusy(false);
    if (ok) { setOpen(false); router.refresh(); }
    else setErr(String(data.error ?? 'Could not drop this shift.'));
  }

  return (
    <>
      <button
        type="button" onClick={() => { setOpen(true); setErr(null); }}
        className="rounded-lg bg-white/5 px-3 py-1.5 text-xs font-semibold text-tt-text transition-colors hover:bg-white/10"
      >Drop Shift</button>

      {open && (
        <div className={sheet} role="dialog" aria-modal="true" aria-label="Drop this shift">
          <div className={card}>
            <h3 className="text-base font-semibold text-tt-text">Drop this shift?</h3>
            <ShiftFacts startsAt={startsAt} endsAt={endsAt} />
            <p className="text-sm text-tt-muted">Your shift will be offered to eligible coworkers.</p>
            {/* The single most important sentence on this page: dropping is not handing back. */}
            <p className="mt-2 text-sm font-medium text-tt-text">
              You are still responsible for this shift until another employee picks it up and a
              manager approves the change.
            </p>
            {err && <p className="mt-3 rounded-lg bg-tt-red/10 px-3 py-2 text-[11px] text-tt-red">{err}</p>}
            <div className="mt-4 flex gap-2">
              <button type="button" onClick={() => setOpen(false)} className={cancelBtn}>Cancel</button>
              <button
                type="button" onClick={submit} disabled={busy}
                className="flex-1 rounded-xl bg-tt-cyan py-2.5 text-sm font-semibold text-black transition-colors hover:bg-tt-cyan/90 disabled:opacity-50"
              >{busy ? 'Working…' : 'Drop Shift'}</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/**
 * CANCEL OFFER — take your own offer back off the board.
 *
 * Shown only on a shift that is currently `offer_state='offered'` AND still yours. The shift never
 * stopped being yours, so this restores nothing — it just stops coworkers being able to ask for it
 * and closes any requests already in. That is why the copy leads with reassurance rather than a
 * warning: nothing about the worker's own schedule changes.
 *
 * `offerId` is sent so a stale tab cannot cancel a cycle it never saw; the server refuses a
 * mismatch as STALE_OFFER rather than closing the current offer.
 */
export function CancelOfferButton({
  token, instanceId, offerId, startsAt, endsAt,
}: { token: string; instanceId: string; offerId: string; startsAt: string; endsAt: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    setBusy(true); setErr(null);
    const { ok, data } = await post(`/s/${token}/cancel-offer`, { instanceId, offerId });
    setBusy(false);
    if (ok) { setOpen(false); router.refresh(); }
    else setErr(String(data.error ?? 'Could not cancel this offer.'));
  }

  return (
    <>
      <button
        type="button" onClick={() => { setOpen(true); setErr(null); }}
        className="rounded-lg bg-white/5 px-3 py-1.5 text-xs font-semibold text-tt-text transition-colors hover:bg-white/10"
      >Cancel Offer</button>

      {open && (
        <div className={sheet} role="dialog" aria-modal="true" aria-label="Cancel this offer">
          <div className={card}>
            <h3 className="text-base font-semibold text-tt-text">Cancel this offer?</h3>
            <ShiftFacts startsAt={startsAt} endsAt={endsAt} />
            <p className="text-sm text-tt-muted">
              You&rsquo;ll stay scheduled for this shift. Any pending pickup requests will be cancelled.
            </p>
            {err && <p className="mt-3 rounded-lg bg-tt-red/10 px-3 py-2 text-[11px] text-tt-red">{err}</p>}
            <div className="mt-4 flex gap-2">
              <button type="button" onClick={() => setOpen(false)} className={cancelBtn}>Keep Offering</button>
              <button
                type="button" onClick={submit} disabled={busy}
                className="flex-1 rounded-xl bg-tt-cyan py-2.5 text-sm font-semibold text-black transition-colors hover:bg-tt-cyan/90 disabled:opacity-50"
              >{busy ? 'Working…' : 'Cancel Offer'}</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/** PICK UP SHIFT — files a pending request. Never assigns the shift. */
export function PickUpShiftButton({
  token, instanceId, offerId, startsAt, endsAt, disabledReason,
}: {
  token: string; instanceId: string; offerId: string;
  startsAt: string; endsAt: string;
  /** Employee-facing reason this viewer cannot take it; renders a static label instead. */
  disabledReason?: string | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (disabledReason) {
    return <span className="shrink-0 text-xs text-tt-muted">{disabledReason}</span>;
  }

  async function submit() {
    setBusy(true); setErr(null);
    const { ok, data } = await post(`/s/${token}/pickup`, { instanceId, offerId });
    setBusy(false);
    if (ok) { setOpen(false); router.refresh(); }
    else setErr(String(data.error ?? 'Could not request this shift.'));
  }

  return (
    <>
      <button
        type="button" onClick={() => { setOpen(true); setErr(null); }}
        className="rounded-lg bg-tt-cyan/15 px-3 py-1.5 text-xs font-semibold text-tt-cyan transition-colors hover:bg-tt-cyan/25"
      >Pick Up Shift</button>

      {open && (
        <div className={sheet} role="dialog" aria-modal="true" aria-label="Pick up this shift">
          <div className={card}>
            <h3 className="text-base font-semibold text-tt-text">Pick up this shift?</h3>
            <ShiftFacts startsAt={startsAt} endsAt={endsAt} />
            <p className="text-sm text-tt-muted">A manager must approve the change before the shift becomes yours.</p>
            {err && <p className="mt-3 rounded-lg bg-tt-red/10 px-3 py-2 text-[11px] text-tt-red">{err}</p>}
            <div className="mt-4 flex gap-2">
              <button type="button" onClick={() => setOpen(false)} className={cancelBtn}>Cancel</button>
              <button
                type="button" onClick={submit} disabled={busy}
                className="flex-1 rounded-xl bg-tt-cyan py-2.5 text-sm font-semibold text-black transition-colors hover:bg-tt-cyan/90 disabled:opacity-50"
              >{busy ? 'Requesting…' : 'Request Pickup'}</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
