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

  // Edit an existing one-off shift's start and/or end time. Only start_time/end_time are
  // touched — never source_rule_id — so this can never rewrite a materialized recurring
  // payroll row (the weekly grid only offers Edit on plain one-offs). Passing end_time:null
  // reopens a shift; validation is the caller's job (see validateShiftTimes).
  const updateShift = useMutation({
    mutationFn: async ({ id, start_time, end_time }: { id: string; start_time?: string; end_time?: string | null }) => {
      const patch: { start_time?: string; end_time?: string | null } = {};
      if (start_time !== undefined) patch.start_time = start_time;
      if (end_time !== undefined) patch.end_time = end_time;
      const { data, error } = await supabase
        .from('shifts')
        .update(patch)
        .eq('id', id)
        .select('*')
        .single();
      if (error) {
        // Same partial-unique-index backstop as addShift (one open shift per employee).
        if (error.code === '23505') {
          throw new Error('This person already has an open shift — end it first.');
        }
        throw error;
      }
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

  // Manager confirmation gate for TIME-CLOCK shifts — SERVER-AUTHORITATIVE (migration 071).
  // The browser sends ONLY the shift id; the RPC derives the user from auth.uid(), verifies
  // ownership + source='time_clock' + a closed linked entry + no open break, then stamps
  // confirmed_at = now() and confirmed_by = auth.uid() in Postgres. A BEFORE UPDATE guard
  // (070) blocks any direct write to those columns, so this RPC is the ONLY way confirmation
  // can change. The kiosk never calls it. Manual shifts ignore confirmation — pay unchanged.
  const confirmShift = useMutation({
    mutationFn: async ({ id, confirmed }: { id: string; confirmed: boolean }) => {
      // rpc-grants: lensed_confirm_time_clock_shift, lensed_unconfirm_time_clock_shift
      // (dynamic .rpc(fn) — annotation lets check-rpc-grants.mjs verify both grants.)
      const fn = confirmed
        ? 'lensed_confirm_time_clock_shift'
        : 'lensed_unconfirm_time_clock_shift';
      const { data, error } = await supabase.rpc(fn, { p_shift_id: id });
      if (error) throw new Error(error.message); // message is a stable token (see confirmErrorMessage)
      return data;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['shifts'] }),
  });

  return {
    shifts: query.data || [],
    openShifts: openQuery.data || [],
    isLoading: query.isLoading,
    addShift,
    endShift,
    updateShift,
    deleteShift,
    confirmShift,
  };
}
