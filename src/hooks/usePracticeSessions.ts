'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PRACTICE_LIVE_WINDOW_MS, type PracticeSessionRow } from '@/lib/training/registry';
import { useEffect, useRef } from 'react';

const KEY = 'practice-sessions';

// How often the launcher re-reads the registry. Liveness is derived from
// last_seen_at, and hosts beat every ~15s, so refetching on that same cadence
// keeps the live/disconnected badges within one heartbeat of the truth without
// the launcher needing its own realtime subscription.
const REFETCH_MS = PRACTICE_LIVE_WINDOW_MS / 3;

// Reads a JSON response, turning the two ways these routes can fail into clear
// errors instead of confusing ones.
//
// THE SESSION-EXPIRY TRAP. /api/admin/* IS matched by middleware.ts, so a request
// with no valid session is 307'd to /login — and because fetch follows redirects
// by default, that arrives as a 200 with an HTML body. `res.ok` is therefore TRUE
// on an auth failure. Without the redirect check below, an expired session would
// surface as a JSON parse error (or, worse, an empty list that reads as "all your
// sessions disappeared"). Verified against the dev server: status=307,
// location=/login, final status 200.
async function readJson(res: Response): Promise<unknown> {
  if (res.redirected && new URL(res.url).pathname.startsWith('/login')) {
    throw new Error('Your sign-in expired — reload the page to sign in again.');
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const message =
      body && typeof body === 'object' && 'error' in body
        ? String((body as { error: unknown }).error)
        : `Request failed (${res.status})`;
    throw new Error(message);
  }
  // A 2xx that is not JSON means something answered that is not this API.
  if (body === null) throw new Error('Unexpected response from the server.');
  return body;
}

// The registry list. `refetchInterval` keeps the derived live badges fresh, and
// `refetchOnWindowFocus` means a manager tabbing back sees the truth immediately
// rather than up to one interval late.
export function usePracticeSessions() {
  return useQuery({
    queryKey: [KEY],
    queryFn: async (): Promise<PracticeSessionRow[]> => {
      const body = (await readJson(await fetch('/api/admin/training/sessions'))) as {
        sessions?: PracticeSessionRow[];
      };
      return body.sessions ?? [];
    },
    refetchInterval: REFETCH_MS,
    refetchOnWindowFocus: true,
    // Practice sessions are operational state a manager acts on immediately, so
    // never serve a stale list from cache without revalidating.
    staleTime: 0,
  });
}

export function useCreatePracticeSession() {
  const qc = useQueryClient();
  return useMutation({
    // `id` is only ever passed by the one-time legacy localStorage import.
    mutationFn: async (input: { trainee_name?: string; id?: string }) => {
      const body = (await readJson(
        await fetch('/api/admin/training/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        }),
      )) as { session: PracticeSessionRow };
      return body.session;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: [KEY] }),
  });
}

export function useRenamePracticeSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, trainee_name }: { id: string; trainee_name: string }) => {
      await readJson(
        await fetch(`/api/admin/training/sessions/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ trainee_name }),
        }),
      );
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: [KEY] }),
  });
}

export function useRemovePracticeSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await readJson(await fetch(`/api/admin/training/sessions/${id}`, { method: 'DELETE' }));
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: [KEY] }),
  });
}

// Completes recordings whose webhook never arrived, by asking LiveKit directly.
//
// WHY IT RUNS FROM THE LAUNCHER. The `egress_ended` webhook is configured in the
// LiveKit Cloud dashboard — outside this repo and outside this deploy. If it is
// missing or points at a stale preview URL, every row sits at 'recording' forever
// even though the MP4 landed fine. Reconciling here makes the webhook an
// optimisation rather than a dependency, which matters on a day with ~100
// recordings where nobody can be counting files by hand.
//
// GATED ON THERE BEING WORK TO DO. It only fires while at least one recording is
// still in flight, so an idle launcher makes no calls at all — this must not become
// a background poll against LiveKit.
export function useReconcileRecordings(sessions: PracticeSessionRow[]) {
  const qc = useQueryClient();
  const inFlight = sessions.some((s) => s.recordings.some((r) => r.status === 'recording'));
  // Serialises calls: reconcile reads and writes several rows, and two overlapping
  // passes would race each other for no benefit.
  const runningRef = useRef(false);

  useEffect(() => {
    if (!inFlight) return;
    let cancelled = false;

    const run = async () => {
      if (runningRef.current || cancelled) return;
      runningRef.current = true;
      try {
        const res = await fetch('/api/admin/training/recording/reconcile', { method: 'POST' });
        // Only refresh the list when something actually changed, so a steady state
        // does not invalidate the query every tick.
        if (res.ok && !res.redirected) {
          const body = (await res.json().catch(() => null)) as
            | { completed?: number; failed?: number; abandoned?: number }
            | null;
          const changed =
            (body?.completed ?? 0) + (body?.failed ?? 0) + (body?.abandoned ?? 0) > 0;
          if (changed && !cancelled) void qc.invalidateQueries({ queryKey: [KEY] });
        }
      } catch {
        /* non-fatal: the next tick retries, and the file is unaffected either way */
      } finally {
        runningRef.current = false;
      }
    };

    void run(); // immediately, so a just-finished recording resolves without a wait
    const t = setInterval(() => void run(), REFETCH_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [inFlight, qc]);
}
