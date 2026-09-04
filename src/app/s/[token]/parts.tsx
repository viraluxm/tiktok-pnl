'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

// Public-page interaction buttons. These call ONLY our own /s/[token]/* POST endpoints via fetch —
// there is NO Supabase client here (no auth session on these routes; see CLAUDE.md).

async function post(url: string, body: unknown): Promise<{ ok: boolean; data: Record<string, unknown> }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, data };
}

export function ReleaseButton({
  token,
  instanceId,
  periodEnd,
  atCap,
  dropsUsed,
  dropCap,
}: {
  token: string;
  instanceId: string;
  periodEnd: string; // 'Mon, Aug 24' — shown on the confirm step
  atCap: boolean; // already at the cap this pay period
  dropsUsed: number;
  dropCap: number;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Replaces a window.confirm. A native confirm cannot collect the reason, and it stated the
  // consequence only AT the cap — so a worker on their first drop was told nothing and a worker
  // on their second was warned about a write-up that never actually arrived, because the cap was
  // not enforced anywhere. Both are now true statements: the position is always shown, and the
  // server refuses past the cap (routing to a manager rather than hard-blocking into a no-show).
  async function submit() {
    if (!reason.trim()) { setErr('Please say why you cannot work this shift.'); return; }
    setBusy(true);
    setErr(null);
    const { ok, data } = await post(`/s/${token}/release`, { instanceId, reason: reason.trim() });
    setBusy(false);
    if (ok) { setOpen(false); setReason(''); router.refresh(); }
    else setErr(String(data.error ?? 'Could not release'));
  }

  const remaining = Math.max(0, dropCap - dropsUsed);

  return (
    <>
      <button
        onClick={() => { setOpen(true); setErr(null); }}
        className="rounded-md border border-tt-border px-3 py-1.5 text-xs font-medium text-tt-text hover:bg-tt-card-hover"
      >
        Release
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 sm:p-8"
          onClick={() => !busy && setOpen(false)}
          role="dialog" aria-modal="true" aria-label="Release this shift"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="max-h-[85dvh] w-full max-w-md overflow-y-auto overscroll-contain rounded-2xl border border-tt-border bg-tt-card p-4 shadow-2xl"
          >
            <h2 className="text-base font-semibold text-tt-text">Release this shift</h2>

            {/* Always state where they stand, not only at the cap. */}
            <p className={`mt-1 text-xs ${atCap ? 'text-tt-red' : 'text-tt-muted'}`}>
              {atCap
                ? `You have used all ${dropCap} drops this pay period. A manager has to release this one for you.`
                : `This will be drop ${dropsUsed + 1} of ${dropCap} this pay period${remaining <= 1 ? ' — your last one.' : '.'}`}
            </p>
            <p className="mt-1 text-xs text-tt-muted">
              Pay period ends {periodEnd}. It goes to the open board for a teammate to pick up — if you
              claim one of theirs in the same period, this drop cancels out.
            </p>

            <label className="mt-3 block text-[10px] uppercase tracking-wide text-tt-muted">
              Why can&apos;t you work it? <span className="text-tt-red">*</span>
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                maxLength={300}
                rows={3}
                disabled={atCap}
                placeholder="e.g. doctor&apos;s appointment I couldn&apos;t move"
                // 16px: iOS Safari zooms the page for a focused control under 16px, and this
                // overlay is fixed-position — the zoom would leave it half off-screen.
                className="mt-1 w-full resize-none appearance-none rounded-lg border border-tt-input-border bg-tt-input-bg px-3 py-2.5 text-base text-tt-text [-webkit-text-fill-color:var(--color-tt-text)] placeholder:text-tt-muted/60 disabled:opacity-50"
              />
            </label>

            {err && <p className="mt-2 text-xs text-tt-red">{err}</p>}

            <div className="mt-3 flex gap-2">
              <button
                type="button" onClick={() => setOpen(false)} disabled={busy}
                className="min-h-12 flex-1 rounded-lg border border-tt-border text-base font-semibold text-tt-muted disabled:opacity-40"
              >Cancel</button>
              <button
                type="button" onClick={submit} disabled={busy || atCap || !reason.trim()}
                className="min-h-12 flex-1 rounded-lg bg-tt-red text-base font-semibold text-white disabled:opacity-40"
              >{busy ? 'Releasing…' : 'Release'}</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

export function ClaimButton({ token, instanceId }: { token: string; instanceId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'err' | 'pending'; text: string } | null>(null);

  async function onClick() {
    setBusy(true);
    setMsg(null);
    const { ok, data } = await post(`/s/${token}/claim`, { instanceId });
    setBusy(false);
    if (ok && data.result === 'claimed') {
      router.refresh();
    } else if (ok && data.result === 'pending_approval') {
      // NOT a success — the shift is NOT theirs yet. Refresh so it moves out of the board and into
      // the "Pending approval" section (the live state of the request). Show a brief note first.
      setMsg({
        kind: 'pending',
        text: 'Over 40 hours — sent to a manager to approve. Not yours yet.',
      });
      router.refresh();
    } else {
      setMsg({ kind: 'err', text: String(data.error ?? 'Could not claim') });
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        onClick={onClick}
        disabled={busy || msg?.kind === 'pending'}
        className="rounded-md bg-tt-magenta px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50"
      >
        {busy ? 'Claiming…' : 'Claim'}
      </button>
      {msg && <span className={`text-right text-[11px] ${msg.kind === 'err' ? 'text-tt-red' : 'text-tt-yellow'}`}>{msg.text}</span>}
    </div>
  );
}
