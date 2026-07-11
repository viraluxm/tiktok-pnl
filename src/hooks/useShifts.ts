'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { createClient } from '@/lib/supabase/client';
import type { Shift } from '@/types';
import { useUser } from './useUser';

export interface ShiftInput {
  employee_id: string;
  date: string;
  start_time: string;
  end_time: string | null; // null = save as an OPEN shift (in progress)
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

  // Authoritative open-shift set for the guard: ALL open shifts (null end_time),
  // NOT scoped to the pay period — an open shift started before the current period
  // must still block a second one. RLS scopes to the user.
  const openQuery = useQuery<Shift[]>({
    queryKey: ['shifts', 'open', user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('shifts')
        .select('*')
        .is('end_time', null)
        .order('date', { ascending: false });
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
      if (error) {
        // Partial unique index idx_shifts_one_open_per_employee (migration 052) — the
        // server-side backstop for "one open shift per employee".
        if (error.code === '23505') {
          throw new Error('This person already has an open shift — end it first.');
        }
        throw error;
      }
      return data;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['shifts'] }),
  });

  // Close an open shift: set its end_time. Validation (end > start) is enforced by the
  // caller before this runs.
  const endShift = useMutation({
    mutationFn: async ({ id, end_time }: { id: string; end_time: string }) => {
      const { data, error } = await supabase
        .from('shifts')
        .update({ end_time })
        .eq('id', id)
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
    openShifts: openQuery.data || [],
    isLoading: query.isLoading,
    addShift,
    endShift,
    deleteShift,
  };
}
