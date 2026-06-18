'use client';

import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useState } from 'react';
import { useLiveSessions, useStartSession, type LiveSession } from '@/hooks/useLiveSessions';

function whenLabel(s: LiveSession): string {
  const iso = s.started_at ?? s.created_at;
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export default function LiveSessionsPanel() {
  const { data: sessions = [], isLoading } = useLiveSessions();
  const startSession = useStartSession();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  const live = sessions.filter((s) => s.status === 'live');
  const past = sessions.filter((s) => s.status !== 'live');

  async function start() {
    setError(null);
    try {
      const session = await startSession.mutateAsync();
      router.push(`/live/${session.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to start session.');
    }
  }

  return (
    <div>
      {/* Primary action */}
      <div className="flex items-end justify-between gap-4 mb-6">
        <div>
          <h2 className="text-xl font-semibold">Live Tracking</h2>
          <p className="text-sm text-tt-muted mt-1 max-w-md">
            Start a session, then log each auction item as you sell it. Reconcile against TikTok orders later.
          </p>
        </div>
        <button
          onClick={start}
          disabled={startSession.isPending}
          className="px-5 py-2.5 rounded-lg bg-tt-cyan text-black text-sm font-semibold cursor-pointer hover:opacity-90 transition-opacity disabled:opacity-50 whitespace-nowrap"
        >
          {startSession.isPending ? 'Starting…' : 'Start Live Session'}
        </button>
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-tt-red/40 bg-tt-red/10 px-4 py-2.5 text-sm text-tt-red">
          {error}
        </div>
      )}

      {isLoading ? (
        <div className="flex items-center justify-center py-16 text-tt-muted">
          <div className="w-5 h-5 border-2 border-tt-muted border-t-transparent rounded-full animate-spin mr-3" />
          Loading sessions…
        </div>
      ) : sessions.length === 0 ? (
        <div className="rounded-2xl border border-tt-border bg-tt-card py-16 text-center">
          <div className="text-tt-text font-medium">No sessions yet</div>
          <p className="text-sm text-tt-muted mt-2 max-w-sm mx-auto">
            Start your first live session to open the host tracking workspace.
          </p>
        </div>
      ) : (
        <div className="space-y-6">
          {live.length > 0 && (
            <SessionGroup label="Live now">
              {live.map((s) => (
                <SessionRow key={s.id} s={s} />
              ))}
            </SessionGroup>
          )}
          {past.length > 0 && (
            <SessionGroup label="Previous sessions">
              {past.map((s) => (
                <SessionRow key={s.id} s={s} />
              ))}
            </SessionGroup>
          )}
        </div>
      )}
    </div>
  );
}

function SessionGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-tt-muted mb-2">{label}</div>
      <div className="rounded-2xl border border-tt-border bg-tt-card overflow-hidden divide-y divide-tt-border">
        {children}
      </div>
    </div>
  );
}

function SessionRow({ s }: { s: LiveSession }) {
  const isLive = s.status === 'live';
  return (
    <Link
      href={`/live/${s.id}`}
      className="flex items-center gap-4 px-4 py-3.5 hover:bg-tt-card-hover transition-colors"
    >
      <span
        className={`w-2 h-2 rounded-full ${isLive ? 'bg-tt-green animate-pulse' : 'bg-tt-muted'}`}
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <div className="font-medium truncate">{s.title}</div>
        <div className="text-xs text-tt-muted">{whenLabel(s)}</div>
      </div>
      <span
        className={`text-xs font-medium px-2 py-0.5 rounded-md ${
          isLive ? 'bg-tt-green/15 text-tt-green' : 'bg-tt-border text-tt-muted'
        }`}
      >
        {isLive ? 'Live' : 'Ended'}
      </span>
      <span className="text-tt-muted" aria-hidden>›</span>
    </Link>
  );
}
