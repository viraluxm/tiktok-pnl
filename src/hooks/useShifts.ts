'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { createClient } from '@/lib/supabase/client';
import type { Shift } from '@/types';
import { buildShiftEditPatch, type EditableShiftRow } from '@/lib/shifts/punchEdit';
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

  // Edit an existing shift's start and/or end time. source_rule_id is never touched, so this
  // can never rewrite a materialized recurring payroll row. Passing end_time:null reopens a
  // shift (manual rows only — see below); validation is the caller's job (validateShiftTimes).
  //
  // WHICH COLUMN CARRIES THE CORRECTION — the load-bearing part:
  //   * source='time_clock' → the PUNCH INSTANTS. paidShiftHours reads clock_in_at/clock_out_at
  //     for these rows and (given migration 097's CHECK) can never fall through to the wall
  //     clock, so writing only start_time/end_time discarded the correction silently. The
  //     instants are now written too, with start_time/end_time kept in sync — other surfaces
  //     still render the wall clock, and a stale copy of it is exactly what hid this bug.
  //   * source='manual' → start_time/end_time only, unchanged. Manual rows carry NULL instants
  //     (097's CHECK does not apply to them) and paidShiftHours already reads their wall clock.
  //
  // The branch itself lives in buildShiftEditPatch (lib/shifts/punchEdit.ts) so it is decided
  // in exactly one place and unit-tested directly, including the DST/overnight conversion.
  //
  // `source` and `date` are read back from the ROW rather than taken from the caller: the
  // calendar's card model carries no `source` and can be stale, and getting this branch wrong
  // in either direction corrupts pay.
  const updateShift = useMutation({
    mutationFn: async ({ id, start_time, end_time }: { id: string; start_time?: string; end_time?: string | null }) => {
      // Nothing to change → do not touch the row at all (see buildShiftEditPatch).
      if (start_time === undefined && end_time === undefined) return null;

      const { data: row, error: readErr } = await supabase
        .from('shifts')
        .select('source, date, start_time, end_time')
        .eq('id', id)
        .single();
      if (readErr) throw readErr;

      // Which layer the correction lands in is decided in ONE place, unit-tested directly.
      const patch = buildShiftEditPatch(row as EditableShiftRow, { start_time, end_time });
      if (patch == null) return null;

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
