'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  isValidTrainingSessionId,
  shortTrainingSessionLabel,
} from '@/lib/training/session';

// Launcher storage: a small list of recently created sessions so the admin can
// reopen them after a reload. Clearly namespaced and capped (not per-session
// scoped — this IS the cross-session index).
const LAUNCHER_STORAGE_KEY = 'training:launcher:recent-sessions';
const MAX_RECENT = 8;

// Build a root-relative path with the session encoded via URLSearchParams so the
// query is always well-formed (a UUID needs no escaping, but this is safe by
// construction and future-proof).
function withSession(pathname: string, id: string): string {
  return `${pathname}?${new URLSearchParams({ session: id }).toString()}`;
}
function hostPath(id: string): string {
  return withSession('/admin/training/live-simulator', id);
}
function controllerPath(id: string): string {
  return withSession('/admin/training/live-simulator/control', id);
}
// Absolute URL for the clipboard, resolved against the CURRENT origin so it works
// under any deployment host (no hard-coded production origin).
function absoluteUrl(path: string): string {
  return new URL(path, window.location.origin).toString();
}

function loadRecent(): string[] {
  try {
    const raw = localStorage.getItem(LAUNCHER_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    // Drop malformed entries and de-duplicate (preserving order), then cap.
    return [...new Set(parsed.filter(isValidTrainingSessionId))].slice(0, MAX_RECENT);
  } catch {
    return [];
  }
}

function saveRecent(ids: string[]): void {
  try {
    localStorage.setItem(LAUNCHER_STORAGE_KEY, JSON.stringify(ids.slice(0, MAX_RECENT)));
  } catch {
    /* storage unavailable (private mode / quota) — sessions stay in memory */
  }
}

export default function PracticeModeLauncher() {
  const [sessions, setSessions] = useState<string[]>([]);
  const [copied, setCopied] = useState<string | null>(null);

  // Hydrate from localStorage after mount. Must run in an effect (not a lazy
  // initializer) so server and first client render both start empty — reading
  // storage during render would cause an SSR hydration mismatch.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- syncing from an external store (localStorage) on mount
    setSessions(loadRecent());
  }, []);

  const persist = useCallback((next: string[]) => {
    setSessions(next);
    saveRecent(next);
  }, []);

  const createSession = useCallback(() => {
    const sessionId = crypto.randomUUID();
    persist([sessionId, ...sessions].slice(0, MAX_RECENT));
    // Open the host screen immediately in a new tab so the admin can hand off
    // the phone; they open the controller from the card when ready.
    window.open(hostPath(sessionId), '_blank', 'noopener');
  }, [persist, sessions]);

  const removeSession = useCallback(
    (id: string) => {
      persist(sessions.filter((s) => s !== id));
    },
    [persist, sessions],
  );

  const copyLink = useCallback(async (label: string, path: string) => {
    try {
      await navigator.clipboard.writeText(absoluteUrl(path));
      setCopied(label);
      window.setTimeout(() => setCopied((c) => (c === label ? null : c)), 1500);
    } catch {
      /* clipboard blocked — admin can still use Open buttons */
    }
  }, []);

  return (
    <div className="mt-6">
      <button
        type="button"
        onClick={createSession}
        className="inline-flex min-h-[48px] items-center justify-center rounded-xl bg-gradient-to-r from-tt-cyan to-[#4db8c0] px-6 text-[15px] font-semibold text-black transition-opacity hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-tt-cyan/50"
      >
        Create Practice Session
      </button>

      {sessions.length === 0 ? (
        <p className="mt-6 text-[13px] text-tt-muted">
          No active sessions yet. Create one to open a host screen and its controller.
        </p>
      ) : (
        <ul className="mt-6 grid gap-3 sm:grid-cols-2">
          {sessions.map((id) => (
            <li
              key={id}
              className="flex flex-col rounded-2xl border border-tt-border bg-tt-card p-4 backdrop-blur-xl"
            >
              <div className="flex items-center justify-between">
                <span className="font-mono text-sm font-semibold tabular-nums text-tt-text">
                  {shortTrainingSessionLabel(id)}
                </span>
                <button
                  type="button"
                  onClick={() => removeSession(id)}
                  className="cursor-pointer text-[12px] text-tt-muted transition-colors hover:text-tt-text focus:outline-none focus-visible:ring-2 focus-visible:ring-tt-cyan/40"
                  aria-label={`Remove session ${shortTrainingSessionLabel(id)}`}
                >
                  Remove
                </button>
              </div>

              <div className="mt-3 grid grid-cols-2 gap-2">
                <a
                  href={hostPath(id)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex min-h-[40px] items-center justify-center rounded-lg bg-[#FE2C55] px-3 text-[13px] font-semibold text-white transition-[filter] hover:brightness-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
                >
                  Open Host
                </a>
                <a
                  href={controllerPath(id)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex min-h-[40px] items-center justify-center rounded-lg bg-[#00B66C] px-3 text-[13px] font-semibold text-white transition-[filter] hover:brightness-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
                >
                  Open Controller
                </a>
                <button
                  type="button"
                  onClick={() => void copyLink(`host:${id}`, hostPath(id))}
                  className="flex min-h-[40px] cursor-pointer items-center justify-center rounded-lg border border-tt-border bg-tt-input-bg px-3 text-[13px] font-medium text-tt-text transition-colors hover:bg-tt-card-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-tt-cyan/40"
                >
                  {copied === `host:${id}` ? 'Copied!' : 'Copy Host Link'}
                </button>
                <button
                  type="button"
                  onClick={() => void copyLink(`ctrl:${id}`, controllerPath(id))}
                  className="flex min-h-[40px] cursor-pointer items-center justify-center rounded-lg border border-tt-border bg-tt-input-bg px-3 text-[13px] font-medium text-tt-text transition-colors hover:bg-tt-card-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-tt-cyan/40"
                >
                  {copied === `ctrl:${id}` ? 'Copied!' : 'Copy Controller Link'}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
