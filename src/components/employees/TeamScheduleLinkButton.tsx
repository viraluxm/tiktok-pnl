'use client';

import { useCallback, useEffect, useState } from 'react';

// Mint / copy / revoke the ONE read-only team-schedule link. Read-only and schedule-only by
// construction (see /s/team/[token]) — it carries no pay, no rates and no punches, so it is safe
// to hand to a manager. It is still a bearer URL: anyone holding it can read the schedule, which
// is why revoking is one click away.

export default function TeamScheduleLinkButton() {
  const [token, setToken] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch('/api/admin/schedule/view-link', { cache: 'no-store' });
    if (res.ok) {
      const j = (await res.json().catch(() => ({}))) as { token?: string | null };
      setToken(j.token ?? null);
    }
    setLoaded(true);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const url = token ? `${typeof window === 'undefined' ? '' : window.location.origin}/s/team/${token}` : null;

  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setError('Could not copy — select the link and copy it manually.');
    }
  }

  async function create() {
    setBusy(true); setError(null);
    try {
      const res = await fetch('/api/admin/schedule/view-link', { method: 'POST' });
      const j = (await res.json().catch(() => ({}))) as { token?: string; error?: string };
      if (!res.ok) throw new Error(j.error ?? 'Could not create the link.');
      setToken(j.token ?? null);
      if (j.token) await copy(`${window.location.origin}/s/team/${j.token}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function revoke() {
    if (!confirm('Revoke the team schedule link? Anyone using it loses access immediately.')) return;
    setBusy(true); setError(null);
    try {
      const res = await fetch('/api/admin/schedule/view-link', { method: 'DELETE' });
      if (!res.ok) throw new Error('Could not revoke the link.');
      setToken(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!loaded) return null;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {url ? (
        <>
          <button
            type="button" onClick={() => copy(url)} disabled={busy}
            className="rounded-lg bg-white/5 px-3 py-1.5 text-xs font-semibold text-tt-text transition-colors hover:bg-white/10 disabled:opacity-50"
          >
            {copied ? 'Copied ✓' : 'Copy schedule link'}
          </button>
          <button
            type="button" onClick={revoke} disabled={busy}
            className="rounded-lg px-2 py-1.5 text-xs font-semibold text-tt-muted transition-colors hover:text-tt-red disabled:opacity-50"
          >Revoke</button>
        </>
      ) : (
        <button
          type="button" onClick={create} disabled={busy}
          className="rounded-lg bg-white/5 px-3 py-1.5 text-xs font-semibold text-tt-muted transition-colors hover:bg-white/10 hover:text-tt-text disabled:opacity-50"
        >
          {busy ? 'Creating…' : 'Create schedule link'}
        </button>
      )}
      {error && <span className="text-[11px] text-tt-red">{error}</span>}
    </div>
  );
}
