'use client';

import { useQuery } from '@tanstack/react-query';
import { useUser } from './useUser';
import type { SessionLite } from '@/lib/schedule/liveHours';

// Live-session intervals for computing host live-hours (display/review only). Fetched from the
// RLS-scoped server route; the pure lib (liveHoursForHostDate) does the per-day math client-side.
export function useHostLiveHours() {
  const { user } = useUser();

  const query = useQuery<SessionLite[]>({
    queryKey: ['host_live_sessions', user?.id],
    enabled: !!user,
    queryFn: async () => {
      const res = await fetch('/api/schedule/host-live-hours');
      if (!res.ok) throw new Error('Could not load live sessions');
      const data = await res.json();
      return (data.sessions ?? []) as SessionLite[];
    },
  });

  return { sessions: query.data ?? [] };
}
