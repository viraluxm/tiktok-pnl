'use client';

import { useQuery } from '@tanstack/react-query';
import { createClient } from '@/lib/supabase/client';
import type { ShiftInstance } from '@/types';
import { useUser } from './useUser';

// Materialized schedule instances for the period — used by confirm-time validation to resolve a
// scheduled span (precedence #1: an instance knows about CLAIMS). RLS is user_id-scoped, so the
// manager's own session returns their instances. Read-only; never a pay input.
export function useShiftInstances(dateFrom: string | null, dateTo: string | null) {
  const { user } = useUser();
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

  return { instances: query.data || [], isLoading: query.isLoading };
}
