'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { createClient } from '@/lib/supabase/client';
import type { Shift } from '@/types';
import { useUser } from './useUser';

export interface ShiftInput {
  employee_id: string;
  date: string;
  start_time: string;
  end_time: string;
}

// Shifts for the selected pay period (dateFrom/dateTo). Nulls fetch all shifts.
export function useShifts(dateFrom: string | null, dateTo: string | null) {
  const { user } = useUser();
  const queryClient = useQueryClient();
  const supabase = createClient();

  const query = useQuery<Shift[]>({
    queryKey: ['shifts', user?.id, dateFrom, dateTo],
    enabled: !!user,
    queryFn: async () => {
      let q = supabase
        .from('shifts')
        .select('*')
        .order('date', { ascending: false })
        .order('start_time', { ascending: true });
      if (dateFrom) q = q.gte('date', dateFrom);
      if (dateTo) q = q.lte('date', dateTo);
      const { data, error } = await q;
      if (error) throw error;
      return data || [];
    },
  });

  const addShift = useMutation({
    mutationFn: async (input: ShiftInput) => {
      const { data, error } = await supabase
        .from('shifts')
        .insert({ ...input, user_id: user!.id })
        .select('*')
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['shifts'] }),
  });

  const deleteShift = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('shifts').delete().eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['shifts'] }),
  });

  return {
    shifts: query.data || [],
    isLoading: query.isLoading,
    addShift,
    deleteShift,
  };
}
