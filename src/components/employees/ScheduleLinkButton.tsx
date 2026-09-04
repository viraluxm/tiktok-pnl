'use client';

import { useState } from 'react';
import { scheduleLinkUrl, type ScheduleLink } from '@/hooks/useScheduleLinks';

// A real property of the design, not boilerplate: the token IS the identity. Anyone holding the
// URL can act as this employee.
export const LINK_WARNING =
  'This link is personal — anyone with it can release and claim shifts as this employee. Send it one to one, never in a group chat.';

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

// Roster ACTIONS button. No active token → "Create employee link" (mints, copies, flips to copied).
// Active token → "Copy employee link" (copies the full URL, brief "Copied ✓"). onCreated fires after
// a fresh mint so the caller can surface LINK_WARNING. "Employee link" because the same persistent
// URL is the person's whole portal — schedule, time off, QR clock-in — not a per-week credential.
export function ScheduleLinkButton({
  employeeId,
  token,
  onMint,
  onCreated,
}: {
  employeeId: string;
  token: string | null;
  onMint: (employeeId: string) => Promise<{ url: string }>;
  onCreated: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);

  function flashCopied() {
    setCopied(true);
    setFailed(false);
    setTimeout(() => setCopied(false), 1800);
  }

  async function handleClick() {
    if (busy) return;
    setFailed(false);
    if (token) {
      if (await copyText(scheduleLinkUrl(token))) flashCopied();
      else setFailed(true);
      return;
    }
    setBusy(true);
    try {
      const { url } = await onMint(employeeId);
      if (await copyText(url)) flashCopied();
      else setFailed(true);
      onCreated();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  const label = failed ? 'Copy failed' : copied ? 'Copied ✓' : busy ? 'Creating…' : token ? 'Copy employee link' : 'Create employee link';
  return (
    <button
      onClick={handleClick}
      disabled={busy}
      className={`px-3 py-1.5 rounded-lg text-[11px] font-semibold transition-colors disabled:opacity-50 ${
        failed ? 'bg-tt-red/15 text-tt-red' : copied ? 'bg-tt-green/15 text-tt-green' : 'bg-white/5 text-tt-text hover:bg-white/10'
      }`}
    >
      {label}
    </button>
  );
}

// Rare actions live in the Edit-employee modal: shows link state + created date, with Revoke and
// Regenerate (Regenerate = mint, which server-side revokes the prior active token). The warning is
// shown persistently here since this section is where links are created/rotated.
export function ScheduleLinkSection({
  link,
  onMint,
  onRevoke,
  onCreated,
}: {
  link: ScheduleLink | null;
  onMint: () => Promise<{ url: string }>;
  onRevoke: (tokenId: string) => Promise<void>;
  onCreated: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function createOrRegen() {
    setBusy(true);
    setErr(null);
    try {
      const { url } = await onMint();
      const ok = await copyText(url);
      if (ok) {
        setCopied(true);
        setTimeout(() => setCopied(false), 1800);
      }
      onCreated();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function revoke() {
    if (!link || busy) return;
    if (!window.confirm('Revoke this schedule link? The employee’s current URL stops working immediately.')) return;
    setBusy(true);
    setErr(null);
    try {
      await onRevoke(link.id);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-xl border border-tt-border p-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold text-tt-text">Schedule link</span>
        {link ? (
          <span className="text-[11px] text-tt-green">Active · created {link.created_at.slice(0, 10)}</span>
        ) : (
          <span className="text-[11px] text-tt-muted">No active link</span>
        )}
      </div>
      <p className="text-[11px] text-tt-muted">{LINK_WARNING}</p>
      {copied && <p className="text-[11px] text-tt-green">Link copied ✓</p>}
      {err && <p className="text-[11px] text-tt-red">{err}</p>}
      <div className="flex gap-2">
        <button
          onClick={createOrRegen}
          disabled={busy}
          className="px-3 py-1.5 rounded-lg text-[11px] font-semibold bg-white/5 text-tt-text hover:bg-white/10 transition-colors disabled:opacity-50"
        >
          {busy ? 'Working…' : link ? 'Regenerate' : 'Create link'}
        </button>
        {link && (
          <button
            onClick={revoke}
            disabled={busy}
            className="px-3 py-1.5 rounded-lg text-[11px] font-semibold bg-tt-red/15 text-tt-red hover:bg-tt-red/25 transition-colors disabled:opacity-50"
          >
            Revoke
          </button>
        )}
      </div>
    </div>
  );
}
