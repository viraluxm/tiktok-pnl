'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useLiveSession, useEndSession } from '@/hooks/useLiveSessions';

export default function HostTrackingShell({ sessionId }: { sessionId: string }) {
  const { data: session, isLoading, isError } = useLiveSession(sessionId);
  const endSession = useEndSession();
  const [confirmEnd, setConfirmEnd] = useState(false);

  const isLive = session?.status === 'live';
  const ended = !!session && !isLive;

  async function onEnd() {
    try {
      await endSession.mutateAsync(sessionId);
      setConfirmEnd(false);
    } catch {
      setConfirmEnd(false);
    }
  }

  return (
    <div className="min-h-screen bg-tt-bg text-tt-text">
      {/* Workspace header */}
      <header className="sticky top-0 z-40 flex items-center gap-4 px-6 py-4 border-b border-tt-border bg-[rgba(15,15,15,0.95)] backdrop-blur-xl">
        <Link href="/dashboard" className="text-sm text-tt-muted hover:text-tt-text transition-colors">
          ‹ Live Tracking
        </Link>
        <div className="flex items-center gap-3 min-w-0">
          <span
            className={`w-2 h-2 rounded-full ${isLive ? 'bg-tt-green animate-pulse' : 'bg-tt-muted'}`}
            aria-hidden
          />
          <h1 className="text-base font-semibold truncate">
            {isLoading ? 'Loading…' : session ? session.title : 'Session'}
          </h1>
          {session && (
            <span
              className={`text-xs font-medium px-2 py-0.5 rounded-md ${
                isLive ? 'bg-tt-green/15 text-tt-green' : 'bg-tt-border text-tt-muted'
              }`}
            >
              {isLive ? 'Live' : 'Ended'}
            </span>
          )}
        </div>

        {isLive && (
          <div className="ml-auto">
            {confirmEnd ? (
              <span className="inline-flex items-center gap-2">
                <span className="text-sm text-tt-muted">End this session?</span>
                <button
                  onClick={onEnd}
                  disabled={endSession.isPending}
                  className="px-3 py-1.5 rounded-lg bg-tt-red/90 text-white text-sm font-medium cursor-pointer hover:opacity-90 disabled:opacity-50"
                >
                  {endSession.isPending ? 'Ending…' : 'Yes, end'}
                </button>
                <button
                  onClick={() => setConfirmEnd(false)}
                  className="px-3 py-1.5 rounded-lg border border-tt-border text-sm text-tt-muted cursor-pointer hover:bg-tt-card-hover"
                >
                  Cancel
                </button>
              </span>
            ) : (
              <button
                onClick={() => setConfirmEnd(true)}
                className="px-4 py-2 rounded-lg border border-tt-border text-sm text-tt-text cursor-pointer hover:bg-tt-card-hover transition-colors"
              >
                End Session
              </button>
            )}
          </div>
        )}
      </header>

      <main className="max-w-5xl mx-auto px-6 py-8">
        {isLoading ? (
          <div className="flex items-center justify-center py-24 text-tt-muted">
            <div className="w-5 h-5 border-2 border-tt-muted border-t-transparent rounded-full animate-spin mr-3" />
            Loading session…
          </div>
        ) : isError || !session ? (
          <div className="rounded-2xl border border-tt-border bg-tt-card py-16 text-center">
            <div className="text-tt-text font-medium">Session not found</div>
            <p className="text-sm text-tt-muted mt-2">
              It may have been deleted, or it belongs to another account.
            </p>
            <Link
              href="/dashboard"
              className="inline-block mt-4 px-4 py-2 rounded-lg border border-tt-border text-sm text-tt-text hover:bg-tt-card-hover transition-colors"
            >
              Back to Live Tracking
            </Link>
          </div>
        ) : (
          <>
            {ended && (
              <div className="mb-6 rounded-lg border border-tt-border bg-tt-card-hover px-4 py-3 text-sm text-tt-muted">
                This session has ended. It is read-only: you can review the log here. Live logging controls are disabled.
              </div>
            )}

            <div className="grid gap-6 md:grid-cols-2">
              {/* Current selection (filled by the logging engine next phase) */}
              <section className="rounded-2xl border border-tt-border bg-tt-card p-6 min-h-[220px] flex flex-col">
                <div className="text-xs uppercase tracking-wide text-tt-muted">Current selection</div>
                <div className="flex-1 flex flex-col items-center justify-center text-center gap-2 py-6">
                  <span className="inline-flex items-center gap-2 rounded-full border border-tt-border bg-tt-card-hover px-3 py-1 text-xs font-medium text-tt-cyan">
                    Logging engine: next phase
                  </span>
                  <p className="text-sm text-tt-muted max-w-xs">
                    {isLive
                      ? 'This is where you’ll scan or pick a SKU by shortcut, set quantity, see total cost and expected price, then mark Sold, Not Sold, Canceled, or Manual.'
                      : 'No live logging on an ended session.'}
                  </p>
                </div>
              </section>

              {/* Sold log */}
              <section className="rounded-2xl border border-tt-border bg-tt-card p-6 min-h-[220px] flex flex-col">
                <div className="text-xs uppercase tracking-wide text-tt-muted">Sold log</div>
                <div className="flex-1 flex flex-col items-center justify-center text-center gap-2 py-6">
                  <p className="text-sm text-tt-muted max-w-xs">
                    Logged auctions will appear here in order (auction #, SKUs, total cost, status), with CSV export.
                  </p>
                </div>
              </section>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
