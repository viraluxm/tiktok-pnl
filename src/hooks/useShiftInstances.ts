'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { createClient } from '@/lib/supabase/client';
import type { ShiftInstance } from '@/types';
import { useUser } from './useUser';

// Materialized schedule instances for the period — used by confirm-time validation to resolve a
// scheduled span (precedence #1: an instance knows about CLAIMS). RLS is user_id-scoped, so the
// manager's own session returns their instances. Never a pay input.
export function useShiftInstances(dateFrom: string | null, dateTo: string | null) {
  const { user } = useUser();
  const queryClient = useQueryClient();
  const supabase = createClient();

  const query = useQuery<ShiftInstance[]>({
    queryKey: ['shift_instances', user?.id, dateFrom, dateTo],
    enabled: !!user,
    queryFn: async () => {
      let q = supabase.from('shift_instances').select('*');
      if (dateFrom) q = q.gte('shift_date', dateFrom);
      if (dateTo) q = q.lte('shift_date', dateTo);
      const { data, error } = await q;
      if (error) throw error;
      return data || [];
    },
  });

  // REMOVE a one-time scheduled shift. Routed through the admin DELETE endpoint rather than a
  // browser `.delete()` on purpose: every eligibility condition (one-off, still scheduled, still
  // in the future, no open punch, no worked shift that day) is enforced server-side, and a
  // client-side delete would make the button the only gate. Matches how createScheduled posts.
  //
  // The server's message is already manager-readable (SHIFT_REMOVAL_MESSAGES), so it is surfaced
  // verbatim. Invalidate by PREFIX so every cached date range drops the row at once — no
  // optimistic update, no hand-spliced caches, same convention as every sibling mutation.
  const removeInstance = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch('/api/admin/schedule/instances', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? 'Could not remove this shift.');
      }
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['shift_instances'] }),
  });

  return { instances: query.data || [], isLoading: query.isLoading, removeInstance };
}
