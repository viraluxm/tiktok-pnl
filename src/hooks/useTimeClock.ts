'use client';

import { useCallback, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { createClient } from '@/lib/supabase/client';
import type { EmployeeTimeEntry } from '@/types';
import { attendanceStateOf, type AttendanceState, type TimeClockAction } from '@/lib/timeclock';
import { useUser } from './useUser';

// A deliberately minimal employee shape for the kiosk. It selects ONLY non-sensitive
// columns — no hourly_rate / pay data ever reaches the kiosk client.
export interface KioskEmployee {
  id: string;
  name: string;
  role: string;
  status: string;
}

export interface PunchResult {
  entry_id: string | null;
  status: string;
  shift_id: string | null;
}

// Maps each kiosk action to its server RPC (defined in migration 071). These RPCs are the
// ONLY write path: the browser sends just the employee id — never a user_id, timestamp,
// source, or confirmation state (those are all server-generated).
const RPC_BY_ACTION: Record<TimeClockAction, string> = {
  clock_in: 'lensed_clock_in',
  start_break: 'lensed_start_break',
  end_break: 'lensed_end_break',
  clock_out: 'lensed_clock_out',
};

export function useTimeClock() {
  const { user } = useUser();
  const queryClient = useQueryClient();
  const supabase = createClient();

  // Active employees only, non-sensitive columns only.
  const employeesQuery = useQuery<KioskEmployee[]>({
    queryKey: ['timeclock', 'employees', user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('employees')
        .select('id, name, role, status')
        .eq('status', 'active')
        .order('name', { ascending: true });
      if (error) throw error;
      return (data || []) as KioskEmployee[];
    },
  });

  // All OPEN work sessions for the account (RLS scopes to the caller). `status` distinguishes
  // working vs on_break, so we don't need to fetch break rows to know the state.
  const openEntriesQuery = useQuery<EmployeeTimeEntry[]>({
    queryKey: ['timeclock', 'state', user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('employee_time_entries')
        .select('*')
        .is('clocked_out_at', null);
      if (error) throw error;
      return (data || []) as EmployeeTimeEntry[];
    },
  });

  const openByEmployee = useMemo(() => {
    const m = new Map<string, EmployeeTimeEntry>();
    for (const e of openEntriesQuery.data || []) m.set(e.employee_id, e);
    return m;
  }, [openEntriesQuery.data]);

  const stateOf = useCallback(
    (employeeId: string): AttendanceState => attendanceStateOf(openByEmployee.get(employeeId)),
    [openByEmployee],
  );

  // One mutation, parameterised by action. On success it refreshes the kiosk state and —
  // because clock-out writes a `shifts` row — the shifts/pay caches too, so the manager's
  // Shifts view picks the new (unconfirmed) shift up immediately.
  const punch = useMutation<PunchResult, Error, { action: TimeClockAction; employeeId: string }>({
    mutationFn: async ({ action, employeeId }) => {
      const { data, error } = await supabase.rpc(RPC_BY_ACTION[action], {
        p_employee_id: employeeId,
      });
      if (error) throw new Error(error.message); // message is a stable token (see friendlyClockError)
      return data as PunchResult;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['timeclock'] });
      queryClient.invalidateQueries({ queryKey: ['shifts'] });
    },
  });

  return {
    employees: employeesQuery.data ?? [],
    isLoading: employeesQuery.isLoading || openEntriesQuery.isLoading,
    isError: employeesQuery.isError || openEntriesQuery.isError,
    openByEmployee,
    stateOf,
    refetchState: openEntriesQuery.refetch,
    punch,
  };
}
