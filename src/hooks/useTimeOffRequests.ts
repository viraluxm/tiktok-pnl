'use client';

import { useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useUser } from './useUser';
import type { TimeOffSpan } from '@/lib/schedule/timeOffConflict';

// The manager's time-off queue, as a shared TanStack query.
//
// WHY IT MOVED HERE. This was a `useState` + `fetch` + nonce inside TimeOffQueue.tsx with exactly
// one consumer (the month calendar). The schedule builder is now a second consumer, and two
// hand-rolled fetches would mean two requests, two copies of the same rows, and two things to
// remember to refresh after a decision. One cached query under a stable key gives every surface
// the same answer and one place to invalidate — the convention useShifts / useShiftInstances /
// useShiftRules already follow.
//
// SCOPE. The route returns every non-withdrawn request for the caller (RLS: own rows on user_id),
// NOT a date window. That is deliberate: the modal's "Decided" history needs the whole set
// anyway, the table is small (one row per request), and a range-keyed query would refetch on
// every week/month step in the builder while this one serves week navigation from cache. If it
// ever needs windowing, add `from`/`to` to the ROUTE and key the query by them — never a second
// fetch alongside this one.

export interface TimeOffRow extends TimeOffSpan {
  id: string;
  employee_id: string;
  start_date: string;
  end_date: string;
  reason: string | null;
  status: 'pending' | 'approved' | 'denied';
  decision_note: string | null;
  created_at: string;
  /** planned (scheduled/claimed) shifts inside the requested range — approving does NOT remove them */
  conflicts?: number;
}

/** The one key every time-off surface reads and invalidates. */
export const TIME_OFF_QUERY_KEY = 'time_off_requests';

export function useTimeOffRequests() {
  const { user } = useUser();
  const queryClient = useQueryClient();

  const query = useQuery<TimeOffRow[]>({
    queryKey: [TIME_OFF_QUERY_KEY, user?.id],
    enabled: !!user,
    queryFn: async () => {
      const res = await fetch('/api/admin/time-off');
      if (!res.ok) throw new Error('Failed to load time-off requests');
      const json = await res.json();
      return json.requests ?? [];
    },
  });

  // Called after a decision (approve / deny). Invalidated by PREFIX so every cached user scope
  // drops at once — the same convention as the mutations in useShiftInstances.
  const reload = useCallback(
    () => { void queryClient.invalidateQueries({ queryKey: [TIME_OFF_QUERY_KEY] }); },
    [queryClient],
  );

  const rows = query.data ?? [];
  return {
    rows,
    reload,
    isLoading: query.isLoading,
    pending: rows.filter((r) => r.status === 'pending'),
  };
}
