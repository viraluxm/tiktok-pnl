'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { createClient } from '@/lib/supabase/client';
import { removeFromRoster } from '@/lib/rosterRemoval';
import type { Employee } from '@/types';
import { useUser } from './useUser';

export interface EmployeeInput {
  name: string;
  role: string;
  status: Employee['status'];
  hourly_rate: number;
  hire_date: string | null;
  probation_end_date: string | null;
  // Only meaningful when role === 'fulfillment'; null otherwise. The DB check constraint
  // (migration 121) accepts NULL | picker | packer | flex and rejects anything else.
  fulfillment_track: Employee['fulfillment_track'];
}

export function useEmployees() {
  const { user } = useUser();
  const queryClient = useQueryClient();
  const supabase = createClient();

  const query = useQuery<Employee[]>({
    queryKey: ['employees', user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('employees')
        .select('*')
        .order('name', { ascending: true });
      if (error) throw error;
      return data || [];
    },
  });

  const addEmployee = useMutation({
    mutationFn: async (input: EmployeeInput) => {
      const { data, error } = await supabase
        .from('employees')
        .insert({ ...input, user_id: user!.id })
        .select('*')
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['employees'] }),
  });

  const updateEmployee = useMutation({
    mutationFn: async ({ id, ...fields }: { id: string } & Partial<EmployeeInput>) => {
      const { data, error } = await supabase
        .from('employees')
        .update({ ...fields, updated_at: new Date().toISOString() })
        .eq('id', id)
        .select('*')
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['employees'] }),
  });

  // Taking someone off the roster ARCHIVES them (status -> 'former'); it does not delete the
  // row. A row delete is impossible for anyone who has hosted a show — the ON DELETE SET NULL
  // on live_session_host_segments.host_id makes Postgres attempt an UPDATE the append-only
  // trigger refuses with HOST_SEGMENT_IMMUTABLE — and for everyone else it would cascade away
  // their shifts, time-clock entries and pay history. See src/lib/rosterRemoval.ts.
  const archiveEmployee = useMutation({
    mutationFn: (id: string) => removeFromRoster(supabase, id),
    onSuccess: () => {
      // Shift rows are untouched, but the weekly grid and every assignment picker filter on
      // status, so their derived views change.
      queryClient.invalidateQueries({ queryKey: ['employees'] });
      queryClient.invalidateQueries({ queryKey: ['shifts'] });
    },
  });

  return {
    employees: query.data || [],
    isLoading: query.isLoading,
    addEmployee,
    updateEmployee,
    archiveEmployee,
  };
}
