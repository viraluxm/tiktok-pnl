'use client';

import { useCallback, useEffect, useState } from 'react';
import QRCode from 'qrcode';
import {
  isValidTrainingSessionId,
  shortTrainingSessionLabel,
  trainingHostPath,
  trainingControllerPath,
  trainingHostUrl,
  trainingControllerUrl,
} from '@/lib/training/session';

// Launcher storage: a small list of recently created sessions so the admin can
// reopen them after a reload. Clearly namespaced and capped (not per-session
// scoped — this IS the cross-session index).
const LAUNCHER_STORAGE_KEY = 'training:launcher:recent-sessions';
const MAX_RECENT = 8;

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

  // Creating a session is purely local: mint a UUID and remember it. It does NOT
  // open, navigate to, or launch the host screen — the admin stays on this page
  // and the host joins independently via the card's QR code or host link.
  const createSession = useCallback(() => {
    const sessionId = crypto.randomUUID();
    persist([sessionId, ...sessions].slice(0, MAX_RECENT));
  }, [persist, sessions]);

  const removeSession = useCallback(
    (id: string) => {
      persist(sessions.filter((s) => s !== id));
    },
    [persist, sessions],
  );

  // Copies an ABSOLUTE url built by the shared @/lib/training/session helpers —
  // the same helpers the QR code uses, so the two can never disagree.
  const copyLink = useCallback(async (label: string, url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(label);
      window.setTimeout(() => setCopied((c) => (c === label ? null : c)), 1500);
    } catch {
      /* clipboard blocked — admin can still use the Open buttons */
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
          No active sessions yet. Create one, then have the host scan its QR code or open the host
          link.
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

              <HostQr sessionId={id} />

              <div className="mt-3 grid grid-cols-2 gap-2">
                <a
                  href={trainingHostPath(id)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex min-h-[40px] items-center justify-center rounded-lg bg-[#FE2C55] px-3 text-[13px] font-semibold text-white transition-[filter] hover:brightness-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
                >
                  Open Host
                </a>
                <button
                  type="button"
                  onClick={() => void copyLink(`host:${id}`, trainingHostUrl(window.location.origin, id))}
                  className="flex min-h-[40px] cursor-pointer items-center justify-center rounded-lg border border-tt-border bg-tt-input-bg px-3 text-[13px] font-medium text-tt-text transition-colors hover:bg-tt-card-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-tt-cyan/40"
                >
                  {copied === `host:${id}` ? 'Copied!' : 'Copy Host Link'}
                </button>
                <a
                  href={trainingControllerPath(id)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex min-h-[40px] items-center justify-center rounded-lg bg-[#00B66C] px-3 text-[13px] font-semibold text-white transition-[filter] hover:brightness-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
                >
                  Open Controller
                </a>
                <button
                  type="button"
                  onClick={() =>
                    void copyLink(`ctrl:${id}`, trainingControllerUrl(window.location.origin, id))
                  }
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

// Inline QR for one session's HOST url. Generated locally with the `qrcode`
// package already used by src/app/s/[token]/ClockControls.tsx (no network, no
// external QR service). The encoded value comes from trainingHostUrl() — the
// exact same helper behind "Copy Host Link" — so scanning and copying always
// resolve to the same URL.
function HostQr({ sessionId }: { sessionId: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    // `cancelled` keeps a late resolve from setting state after unmount (e.g. the
    // admin removes the card while generation is in flight).
    let cancelled = false;
    const url = trainingHostUrl(window.location.origin, sessionId);
    QRCode.toString(url, { type: 'svg', errorCorrectionLevel: 'M', margin: 4, width: 280 })
      .then((out) => {
        if (!cancelled) setSvg(out);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  return (
    <div className="mt-3 flex flex-col items-center">
      {/* White plate guarantees scannable contrast + quiet zone in any theme. */}
      <div className="w-full max-w-[200px] rounded-xl bg-white p-3">
        {svg ? (
          // Only ever the qrcode package's own SVG output — never user input.
          <div
            className="[&>svg]:h-auto [&>svg]:w-full"
            aria-label="QR code to open the host screen"
            role="img"
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        ) : (
          <div className="flex aspect-square items-center justify-center text-center text-[12px] text-black/50">
            {failed ? 'QR unavailable — use the host link' : 'Generating QR…'}
          </div>
        )}
      </div>
      <p className="mt-2 text-[12px] text-tt-muted">Scan to join as host</p>
    </div>
  );
}
