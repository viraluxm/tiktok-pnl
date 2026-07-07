'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { createClient } from '@/lib/supabase/client';
import type { Employee } from '@/types';
import { useUser } from './useUser';

export interface EmployeeInput {
  name: string;
  role: string;
  status: Employee['status'];
  hourly_rate: number;
  hire_date: string | null;
  probation_end_date: string | null;
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

  const deleteEmployee = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('employees').delete().eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      // Shifts cascade-delete in the DB; drop their cache too.
      queryClient.invalidateQueries({ queryKey: ['employees'] });
      queryClient.invalidateQueries({ queryKey: ['shifts'] });
    },
  });

  return {
    employees: query.data || [],
    isLoading: query.isLoading,
    addEmployee,
    updateEmployee,
    deleteEmployee,
  };
}
