'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import QRCode from 'qrcode';
import {
  shortTrainingSessionLabel,
  trainingHostPath,
  trainingControllerPath,
  trainingHostUrl,
  trainingControllerUrl,
  parseLauncherSessions,
} from '@/lib/training/session';
import {
  derivePracticeStatus,
  formatPracticeRunLength,
  PRACTICE_STATUS_LABEL,
  PRACTICE_TRAINEE_NAME_MAX,
  type PracticeSessionRow,
  type PracticeStatus,
} from '@/lib/training/registry';
import {
  useCreatePracticeSession,
  usePracticeSessions,
  useRemovePracticeSession,
  useRenamePracticeSession,
} from '@/hooks/usePracticeSessions';

// The LEGACY per-browser index. Sessions now live in the practice_sessions table
// (migration 136), which is shared across machines and survives a cache clear.
// This key is read exactly once, to import anything a browser still holds, and is
// then deleted — see LegacyImport below.
const LEGACY_STORAGE_KEY = 'training:launcher:recent-sessions';

const STATUS_STYLE: Record<PracticeStatus, string> = {
  live: 'bg-[#00B66C] text-white',
  created: 'bg-tt-input-bg text-tt-muted',
  stale: 'bg-tt-yellow text-black',
  ended: 'bg-tt-input-bg text-tt-muted',
};

export default function PracticeModeLauncher() {
  const { data: sessions = [], isLoading, error } = usePracticeSessions();
  const create = useCreatePracticeSession();
  const remove = useRemovePracticeSession();

  const [name, setName] = useState('');
  const [copied, setCopied] = useState<string | null>(null);

  // `now` drives the derived status badges between refetches, so a session that
  // stops beating flips to Disconnected on its own rather than waiting for the
  // next list read.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(t);
  }, []);

  // ended_at IS the boundary between the two lists, so a session cannot be in both
  // and a host that rejoins (restartPractice clears ended_at) moves back to Active
  // by itself.
  const active = useMemo(() => sessions.filter((s) => s.ended_at === null), [sessions]);
  const history = useMemo(() => sessions.filter((s) => s.ended_at !== null), [sessions]);
  const liveCount = useMemo(
    () => active.filter((s) => derivePracticeStatus(s, now) === 'live').length,
    [active, now],
  );

  const createSession = useCallback(() => {
    // Fire-and-forget: the mutation invalidates the list on success, and its own
    // error state renders below. The id is minted SERVER-side now.
    create.mutate({ trainee_name: name.trim() || undefined }, { onSuccess: () => setName('') });
  }, [create, name]);

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
      <LegacyImport />

      {/* Create form. A name up front is optional: an audition link is often made
          before the candidate's name is known, and each card can be named later. */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !create.isPending) createSession();
          }}
          maxLength={PRACTICE_TRAINEE_NAME_MAX}
          aria-label="Trainee or candidate name"
          placeholder="Trainee / candidate name (optional)"
          className="min-w-0 flex-1 rounded-xl border border-tt-input-border bg-tt-input-bg px-3 py-2.5 text-sm text-tt-text transition-colors focus:border-tt-cyan focus:outline-none"
        />
        <button
          type="button"
          onClick={createSession}
          disabled={create.isPending}
          className="inline-flex min-h-[48px] shrink-0 cursor-pointer items-center justify-center rounded-xl bg-gradient-to-r from-tt-cyan to-[#4db8c0] px-6 text-[15px] font-semibold text-black transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-tt-cyan/50"
        >
          {create.isPending ? 'Creating…' : 'Create Session'}
        </button>
      </div>

      {create.error && (
        <p className="mt-2 text-[13px] text-tt-red">
          Could not create the session: {create.error.message}
        </p>
      )}

      <div className="mt-4 flex items-center gap-3 text-[13px] text-tt-muted">
        <span>
          <span className="font-semibold tabular-nums text-tt-text">{active.length}</span> active
        </span>
        {liveCount > 0 && (
          <span className="flex items-center gap-1.5 font-semibold text-tt-green">
            <span className="h-2 w-2 rounded-full bg-current motion-safe:animate-pulse" />
            {liveCount} live
          </span>
        )}
        {/* This list is shared, so say so — it is the whole point of the change. */}
        <span className="text-tt-muted">· visible to every admin</span>
      </div>

      {error ? (
        <p className="mt-6 text-[13px] text-tt-red">
          Could not load sessions: {error.message}
        </p>
      ) : isLoading ? (
        <p className="mt-6 text-[13px] text-tt-muted">Loading sessions…</p>
      ) : active.length === 0 ? (
        <p className="mt-6 text-[13px] text-tt-muted">
          No active sessions. Create one, then have the host scan its QR code or open the host link.
        </p>
      ) : (
        <ul className="mt-6 grid gap-3 sm:grid-cols-2">
          {active.map((s) => (
            <SessionCard
              key={s.id}
              session={s}
              status={derivePracticeStatus(s, now)}
              copied={copied}
              onCopy={copyLink}
              onDiscard={() => remove.mutate(s.id)}
              discarding={remove.isPending && remove.variables === s.id}
            />
          ))}
        </ul>
      )}

      <SessionHistory sessions={history} />
      {remove.error && (
        <p className="mt-2 text-[13px] text-tt-red">Could not discard: {remove.error.message}</p>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// One-time migration of a browser's legacy localStorage index into the registry.
//
// WHY THIS EXISTS. Before migration 136, that array was the ONLY record that a
// session id existed. Switching the launcher to read the table would strand any
// session a browser still held — including one running RIGHT NOW with a published
// camera and no other way back in. So each legacy id is imported (POST with an
// explicit id; re-importing is a no-op server-side) and only then is the key
// deleted. Renders nothing unless there was something to import.
function LegacyImport() {
  const create = useCreatePracticeSession();
  const [imported, setImported] = useState<number | null>(null);
  // Guards against a second run under StrictMode's setup→cleanup→setup.
  const ranRef = useRef(false);

  useEffect(() => {
    if (ranRef.current) return;
    ranRef.current = true;

    let legacy: string[] = [];
    try {
      legacy = parseLauncherSessions(localStorage.getItem(LEGACY_STORAGE_KEY));
    } catch {
      return; // storage unavailable — nothing to import
    }
    if (legacy.length === 0) return;

    void (async () => {
      let ok = 0;
      for (const id of legacy) {
        try {
          await create.mutateAsync({ id });
          ok++;
        } catch {
          // A 409 means the id belongs to someone else; anything else is
          // transient. Either way keep going — one bad id must not block the rest.
        }
      }
      // Only drop the legacy key once the loop has run, so a failure mid-way
      // leaves the source list intact for the next load.
      try {
        localStorage.removeItem(LEGACY_STORAGE_KEY);
      } catch {
        /* ignore */
      }
      setImported(ok);
    })();
    // create is a stable mutation object; the ref guard is the real once-only gate.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (imported === null || imported === 0) return null;
  return (
    <p className="mb-4 rounded-xl border border-tt-border bg-tt-card px-4 py-2.5 text-[13px] text-tt-muted">
      Imported {imported} session{imported === 1 ? '' : 's'} from this browser into the shared
      registry.
    </p>
  );
}

function SessionCard({
  session,
  status,
  copied,
  onCopy,
  onDiscard,
  discarding,
}: {
  session: PracticeSessionRow;
  status: PracticeStatus;
  copied: string | null;
  onCopy: (label: string, url: string) => Promise<void>;
  onDiscard: () => void;
  discarding: boolean;
}) {
  const id = session.id;
  const rename = useRenamePracticeSession();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(session.trainee_name ?? '');

  function commit() {
    setEditing(false);
    const next = draft.trim();
    if (next !== (session.trainee_name ?? '')) rename.mutate({ id, trainee_name: next });
  }

  return (
    <li className="flex flex-col rounded-2xl border border-tt-border bg-tt-card p-4 backdrop-blur-xl">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          {editing ? (
            <input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commit();
                if (e.key === 'Escape') {
                  setDraft(session.trainee_name ?? '');
                  setEditing(false);
                }
              }}
              maxLength={PRACTICE_TRAINEE_NAME_MAX}
              aria-label="Trainee or candidate name"
              className="w-full rounded-lg border border-tt-input-border bg-tt-input-bg px-2 py-1 text-sm text-tt-text focus:border-tt-cyan focus:outline-none"
            />
          ) : (
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="block max-w-full cursor-pointer truncate text-left text-sm font-semibold text-tt-text hover:text-tt-cyan focus:outline-none focus-visible:ring-2 focus-visible:ring-tt-cyan/40"
              title="Click to rename"
            >
              {session.trainee_name || 'Unnamed'}
            </button>
          )}
          <div className="mt-0.5 font-mono text-[11px] tabular-nums text-tt-muted">
            {shortTrainingSessionLabel(id)}
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <span
            className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${STATUS_STYLE[status]}`}
          >
            {PRACTICE_STATUS_LABEL[status]}
          </span>
          {/* Discard is offered ONLY for a session that has never run. Once a host
              has started, the session owns its footage and event timeline, so it is
              kept in History and there is no delete path — the route refuses too. */}
          {session.started_at === null && (
            <button
              type="button"
              onClick={onDiscard}
              disabled={discarding}
              className="cursor-pointer text-[12px] text-tt-muted transition-colors hover:text-tt-text disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-tt-cyan/40"
              aria-label={`Discard unused session ${shortTrainingSessionLabel(id)}`}
              title="Only an unused session can be discarded"
            >
              {discarding ? 'Discarding…' : 'Discard'}
            </button>
          )}
        </div>
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
          onClick={() => void onCopy(`host:${id}`, trainingHostUrl(window.location.origin, id))}
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
            void onCopy(`ctrl:${id}`, trainingControllerUrl(window.location.origin, id))
          }
          className="flex min-h-[40px] cursor-pointer items-center justify-center rounded-lg border border-tt-border bg-tt-input-bg px-3 text-[13px] font-medium text-tt-text transition-colors hover:bg-tt-card-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-tt-cyan/40"
        >
          {copied === `ctrl:${id}` ? 'Copied!' : 'Copy Controller Link'}
        </button>
      </div>
      {rename.error && (
        <p className="mt-2 text-[12px] text-tt-red">Rename failed: {rename.error.message}</p>
      )}
    </li>
  );
}

// Finished sessions. They are KEPT, never deletable: a session that ran owns its
// footage and its event timeline (Deploys 3 and 4), so this list is where a replay
// will hang off. Collapsed by default so a long history never buries the active
// sessions a manager is actually working with.
function SessionHistory({ sessions }: { sessions: PracticeSessionRow[] }) {
  const [open, setOpen] = useState(false);
  if (sessions.length === 0) return null;

  return (
    <section className="mt-8 border-t border-tt-border pt-5">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full cursor-pointer items-center justify-between text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-tt-cyan/40"
      >
        <span className="text-sm font-semibold text-tt-text">
          History
          <span className="ml-2 font-normal tabular-nums text-tt-muted">{sessions.length}</span>
        </span>
        <span className="text-[13px] text-tt-muted">{open ? 'Hide' : 'Show'}</span>
      </button>

      {open && (
        <ul className="mt-3 divide-y divide-tt-border">
          {sessions.map((s) => (
            <li key={s.id} className="flex items-baseline justify-between gap-3 py-2.5">
              <span className="min-w-0 truncate text-[13px] font-medium text-tt-text">
                {s.trainee_name || 'Unnamed'}
              </span>
              <span className="flex shrink-0 items-baseline gap-3 text-[12px] tabular-nums text-tt-muted">
                <span>{formatPracticeRunLength(s)}</span>
                {/* What was actually captured. Until the replay player exists this is
                    the honest answer to "is there anything to watch?" — and a
                    session with 0 recorded moments would otherwise look identical
                    to one with a full timeline. */}
                <span title="Timeline moments recorded for replay">
                  {s.event_count} {s.event_count === 1 ? 'moment' : 'moments'}
                </span>
                <span>
                  {new Date(s.ended_at ?? s.created_at).toLocaleDateString(undefined, {
                    month: 'short',
                    day: 'numeric',
                  })}
                </span>
                <span className="font-mono">{shortTrainingSessionLabel(s.id)}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
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
