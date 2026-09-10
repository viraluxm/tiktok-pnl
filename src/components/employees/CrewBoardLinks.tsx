'use client';

import { useCallback, useEffect, useState } from 'react';

// Mint / copy / regenerate / revoke the two read-only CREW BOARD links — one per shift, handed to
// the manager on that shift.
//
// Read-only and fulfillment-only by construction (see /s/[token]/pickers): the route carries no
// pay, no rates and no punch edits — it selects employee name and role and nothing else. It is
// still a bearer URL, so anyone holding it can read the shift's picker output; that is why
// Regenerate (which revokes the old URL in the same call) is one click away.
//
// Deliberately mounted on the TEAM tab rather than Shipping: handing out and taking away a link
// is people/access work, and it belongs next to the other link controls a manager already knows.

interface CrewToken {
  id: string;
  crew: 'am' | 'pm';
  label: string;
  target_boxes: number | null;
  token: string;
  path: string;
}

const CREWS: { crew: 'am' | 'pm'; label: string; window: string }[] = [
  { crew: 'am', label: 'Morning crew', window: '4:00 AM – 3:00 PM' },
  { crew: 'pm', label: 'Night crew', window: '3:00 PM – 4:00 AM' },
];

export default function CrewBoardLinks() {
  const [tokens, setTokens] = useState<CrewToken[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/crew-board-tokens', { cache: 'no-store' });
      if (res.ok) {
        const j = (await res.json().catch(() => ({}))) as { tokens?: CrewToken[] };
        setTokens(j.tokens ?? []);
      }
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const urlFor = (t: CrewToken) =>
    `${typeof window === 'undefined' ? '' : window.location.origin}${t.path}`;

  async function copy(value: string, key: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(key);
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 1800);
    } catch {
      setError('Could not copy — select the link and copy it manually.');
    }
  }

  // Mint doubles as regenerate: the endpoint revokes this crew's existing active token in the
  // same request, so the old URL dies the moment a new one is issued.
  async function mint(crew: 'am' | 'pm', label: string, regenerating: boolean) {
    if (regenerating && !window.confirm(
      `Regenerate the ${label} link? The current URL stops working immediately and anyone using it loses access.`,
    )) return;
    setBusy(crew);
    setError(null);
    try {
      const res = await fetch('/api/admin/crew-board-tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ crew, label, targetBoxes: 200 }),
      });
      const j = (await res.json().catch(() => ({}))) as CrewToken & { error?: string };
      if (!res.ok) throw new Error(j.error ?? 'Could not create the link');
      await load();
      await copy(`${window.location.origin}${j.path}`, crew);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function revoke(t: CrewToken) {
    if (!window.confirm(`Revoke the ${t.label} link? The URL stops working immediately.`)) return;
    setBusy(t.crew);
    setError(null);
    try {
      const res = await fetch(`/api/admin/crew-board-tokens?id=${encodeURIComponent(t.id)}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Could not revoke the link');
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function setTarget(t: CrewToken) {
    const raw = window.prompt(
      `Per-shift target for ${t.label}, in weighted boxes.\n\nLeave blank to remove the target and show counts only.`,
      t.target_boxes == null ? '' : String(t.target_boxes),
    );
    if (raw === null) return;                       // cancelled
    const trimmed = raw.trim();
    const targetBoxes = trimmed === '' ? null : Number(trimmed);
    if (targetBoxes !== null && (!Number.isInteger(targetBoxes) || targetBoxes <= 0)) {
      setError('Target must be a whole number above zero, or blank to remove it.');
      return;
    }
    setBusy(t.crew);
    setError(null);
    try {
      const res = await fetch('/api/admin/crew-board-tokens', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: t.id, targetBoxes }),
      });
      if (!res.ok) throw new Error('Could not update the target');
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="rounded-xl border border-tt-border bg-tt-card p-3 space-y-2.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-semibold text-tt-text">Crew board links</span>
        <span className="text-[11px] text-tt-muted">Live picker pace, one link per shift</span>
      </div>
      <p className="text-[11px] text-tt-muted">
        Read-only, no login, no pay data. Anyone with the URL can open it — regenerate to cut off
        access.
      </p>
      {error && <p className="text-[11px] text-tt-red">{error}</p>}

      {CREWS.map(({ crew, label, window: win }) => {
        const t = tokens.find((x) => x.crew === crew);
        const working = busy === crew;
        return (
          <div key={crew} className="rounded-lg border border-tt-border/70 px-3 py-2 space-y-1.5">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div className="min-w-0">
                <span className="text-xs font-semibold text-tt-text">{label}</span>
                <span className="text-[11px] text-tt-muted"> · {win}</span>
              </div>
              {loaded && (
                t
                  ? <span className="text-[11px] text-tt-green">Active · target {t.target_boxes ?? '—'}</span>
                  : <span className="text-[11px] text-tt-muted">No link</span>
              )}
            </div>

            {copied === crew && <p className="text-[11px] text-tt-green">Link copied ✓</p>}

            <div className="flex flex-wrap gap-1.5">
              {t && (
                <button
                  onClick={() => copy(urlFor(t), crew)}
                  disabled={working}
                  className="px-2.5 py-1 rounded-lg text-[11px] font-semibold bg-white/5 text-tt-text hover:bg-white/10 transition-colors disabled:opacity-50 cursor-pointer"
                >Copy link</button>
              )}
              <button
                onClick={() => mint(crew, label, !!t)}
                disabled={working}
                className="px-2.5 py-1 rounded-lg text-[11px] font-semibold bg-white/5 text-tt-text hover:bg-white/10 transition-colors disabled:opacity-50 cursor-pointer"
              >{working ? 'Working…' : t ? 'Regenerate' : 'Create link'}</button>
              {t && (
                <>
                  <button
                    onClick={() => setTarget(t)}
                    disabled={working}
                    className="px-2.5 py-1 rounded-lg text-[11px] font-semibold bg-white/5 text-tt-text hover:bg-white/10 transition-colors disabled:opacity-50 cursor-pointer"
                  >Set target</button>
                  <button
                    onClick={() => revoke(t)}
                    disabled={working}
                    className="px-2.5 py-1 rounded-lg text-[11px] font-semibold bg-tt-red/15 text-tt-red hover:bg-tt-red/25 transition-colors disabled:opacity-50 cursor-pointer"
                  >Revoke</button>
                </>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
