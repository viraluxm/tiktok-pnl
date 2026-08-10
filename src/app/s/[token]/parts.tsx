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
}: {
  token: string;
  instanceId: string;
  periodEnd: string; // 'Mon, Aug 24' — shown on the confirm step
  atCap: boolean; // already at 2 net drops this period
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function onClick() {
    const warn = atCap
      ? '⚠ You are already at 2 drops this pay period. Releasing this shift risks a write-up.\n\n'
      : '';
    if (!window.confirm(`${warn}Release this shift? Your pay period ends ${periodEnd}. It will go to the open board for a teammate to pick up.`)) {
      return;
    }
    setBusy(true);
    setErr(null);
    const { ok, data } = await post(`/s/${token}/release`, { instanceId });
    setBusy(false);
    if (ok) router.refresh();
    else setErr(String(data.error ?? 'Could not release'));
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        onClick={onClick}
        disabled={busy}
        className="rounded-md border border-tt-border px-3 py-1.5 text-xs font-medium text-tt-text hover:bg-tt-card-hover disabled:opacity-50"
      >
        {busy ? 'Releasing…' : 'Release'}
      </button>
      {err && <span className="text-[11px] text-tt-red">{err}</span>}
    </div>
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
      // NOT a success — the shift is NOT theirs yet. The instance stays on the board and no
      // approval path exists until Phase 7, so the copy must not imply it's done.
      setMsg({
        kind: 'pending',
        text: 'This shift would put you over 40 hours, so it needs a manager to approve it. It is NOT yours yet — a manager will follow up.',
      });
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
