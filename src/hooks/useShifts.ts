'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { createClient } from '@/lib/supabase/client';
import type { Shift } from '@/types';
import { buildShiftEditPatch, type EditableShiftRow } from '@/lib/shifts/punchEdit';
import { manualWorkedErrorMessage } from '@/lib/shifts/manualWorked';
import { useUser } from './useUser';

export interface ShiftInput {
  employee_id: string;
  date: string;
  start_time: string;
  end_time: string | null; // null = save as an OPEN shift (in progress)
  /** Unpaid break. Omitted reads as 0 — the column is NOT NULL DEFAULT 0. */
  break_minutes?: number;
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

  // Create a MANUAL, PAYABLE worked shift — the Worked / Missed Punch correction.
  //
  // SERVER-AUTHORITATIVE, and deliberately no longer a plain insert. A direct
  // `.from('shifts').insert()` had no protection against creating a second payable row over time
  // the employee is already paid for: production carries 12 such overlapping pairs, every one a
  // manual row stacked on a real punch. A client-side "check then insert" cannot fix that —
  // PostgREST cannot express `INSERT … WHERE NOT EXISTS`, so two managers saving at once both read
  // "no conflict" and both write.
  //
  // lensed_create_manual_worked_shift (migration 131) takes a per-employee advisory lock, re-reads
  // the employee's worked intervals, refuses an OVERLAP (not a same-day collision — split shifts
  // stay legal) and inserts, all in one transaction. This is the ONLY client-side write that
  // creates a `shifts` row, so routing it here protects BOTH the day-card "Add Worked Time"
  // shortcut and the older Advanced "Worked / Missed Punch" lane at a single point.
  //
  // Scheduled shifts do NOT come through here — they are `shift_instances`, written by
  // useScheduleBulk, and are never payable.
  const addShift = useMutation({
    mutationFn: async (input: ShiftInput) => {
      // No `rpc-grants:` annotation here on purpose — that annotation is for DYNAMIC .rpc(expr)
      // calls only (see supabase/migrations/CONVENTIONS.md). This name is a literal, so
      // check-rpc-grants.mjs collects it directly.
      const { data, error } = await supabase.rpc('lensed_create_manual_worked_shift', {
        p_employee_id: input.employee_id,
        p_date: input.date,
        p_start_time: input.start_time,
        p_end_time: input.end_time,
        p_break_minutes: input.break_minutes ?? 0,
      });
      // Tokens in, sentences out — a raw Postgres error never reaches the manager.
      if (error) throw new Error(manualWorkedErrorMessage(error));
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
    mutationFn: async ({ id, start_time, end_time, break_minutes }: {
      id: string; start_time?: string; end_time?: string | null; break_minutes?: number;
    }) => {
      // Nothing to change → do not touch the row at all (see buildShiftEditPatch).
      if (start_time === undefined && end_time === undefined && break_minutes === undefined) return null;

      // break_minutes is read back for the same reason source/date are: the patch builder compares
      // the edit against what is STORED, so a break-only save can tell "unchanged" from "set to 0".
      const { data: row, error: readErr } = await supabase
        .from('shifts')
        .select('source, date, start_time, end_time, break_minutes')
        .eq('id', id)
        .single();
      if (readErr) throw readErr;

      // Which layer the correction lands in is decided in ONE place, unit-tested directly.
      const patch = buildShiftEditPatch(row as EditableShiftRow, { start_time, end_time, break_minutes });
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
  // The browser sends the shift id and, since migration 137, the APPROVED MINUTES; the RPC derives
  // the user from auth.uid(), verifies ownership + source='time_clock' + a closed linked entry +
  // no open break, then stamps confirmed_at = now(), confirmed_by = auth.uid() and the approved
  // duration in Postgres. A BEFORE UPDATE guard (070, widened by 137) blocks any direct write to
  // those columns, so this RPC is the ONLY way confirmation or approved hours can change. The
  // kiosk never calls it. Manual shifts ignore confirmation — pay unchanged.
  //
  // APPROVED MINUTES ARE PART OF THE SAME CALL on purpose. Confirming and approving must be one
  // transaction: a confirm that succeeded while a follow-up approval failed would leave the shift
  // payable at its CLOCKED span, which for a live host is the overpayment this change removes.
  // Undefined = not supplied (the RPC's argument defaults to null); the RPC refuses a host shift
  // that has no approved duration.
  const confirmShift = useMutation({
    mutationFn: async ({ id, confirmed, approvedMinutes }: { id: string; confirmed: boolean; approvedMinutes?: number | null }) => {
      // rpc-grants: lensed_confirm_time_clock_shift, lensed_unconfirm_time_clock_shift
      // (dynamic .rpc(fn) — annotation lets check-rpc-grants.mjs verify both grants.)
      const fn = confirmed
        ? 'lensed_confirm_time_clock_shift'
        : 'lensed_unconfirm_time_clock_shift';
      const args = confirmed
        ? { p_shift_id: id, p_approved_minutes: approvedMinutes ?? null }
        : { p_shift_id: id };
      const { data, error } = await supabase.rpc(fn, args);
      if (error) throw new Error(error.message); // message is a stable token (see confirmErrorMessage)
      return data;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['shifts'] }),
  });

  // PAYROLL-ONLY CORRECTION on an already-confirmed shift (migration 137). This is the answer to
  // "the punch is right but the payable duration is wrong" — the case that used to be fixed by
  // editing the punch. Attendance corrections still go through updateShift above; the two are
  // deliberately different actions with different targets.
  //
  // Passing null withdraws the approval and returns the shift to the legacy calculation.
  const setApprovedMinutes = useMutation({
    mutationFn: async ({ id, approvedMinutes }: { id: string; approvedMinutes: number | null }) => {
      // No `rpc-grants:` annotation needed — a literal name is collected directly by the checker.
      const { data, error } = await supabase.rpc('lensed_set_approved_minutes', {
        p_shift_id: id,
        p_approved_minutes: approvedMinutes,
      });
      if (error) throw new Error(error.message);
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
    setApprovedMinutes,
  };
}
