'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { createClient } from '@/lib/supabase/client';
import type { ShiftRule, ShiftException, ShiftExceptionType } from '@/types';
import { useUser } from './useUser';

export interface ShiftRuleInput {
  employee_id: string;
  days_of_week: number[];
  start_time: string;
  end_time: string;
  start_date: string;
  active?: boolean;
}

export interface ExceptionInput {
  rule_id: string;
  date: string;
  type: ShiftExceptionType;
  modified_start?: string | null;
  modified_end?: string | null;
}

// Recurring-shift rules + their per-date exceptions. Rules are NOT date-filtered
// here — instances are generated client-side per the selected period (see
// generateRecurringShifts), so the whole rule/exception set is fetched.
export function useShiftRules() {
  const { user } = useUser();
  const queryClient = useQueryClient();
  const supabase = createClient();

  const rulesQuery = useQuery<ShiftRule[]>({
    queryKey: ['shift_rules', user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('shift_rules')
        .select('*')
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data || [];
    },
  });

  const exceptionsQuery = useQuery<ShiftException[]>({
    queryKey: ['shift_exceptions', user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data, error } = await supabase.from('shift_exceptions').select('*');
      if (error) throw error;
      return data || [];
    },
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['shift_rules'] });
    queryClient.invalidateQueries({ queryKey: ['shift_exceptions'] });
  };

  const addRule = useMutation({
    mutationFn: async (input: ShiftRuleInput) => {
      const { data, error } = await supabase
        .from('shift_rules')
        .insert({ active: true, ...input, user_id: user!.id })
        .select('*')
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: invalidate,
  });

  const toggleRuleActive = useMutation({
    mutationFn: async ({ id, active }: { id: string; active: boolean }) => {
      const { error } = await supabase
        .from('shift_rules')
        .update({ active, updated_at: new Date().toISOString() })
        .eq('id', id);
      if (error) throw error;
    },
    onSuccess: invalidate,
  });

  // Deleting a rule cascades its exceptions (FK) and stops FUTURE generation.
  // It never touches the one-off `shifts` table; past pay already derived stands.
  const deleteRule = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('shift_rules').delete().eq('id', id);
      if (error) throw error;
    },
    onSuccess: invalidate,
  });

  // Skip or modify a single generated instance. Upsert on (rule_id, date) so
  // re-skipping / re-modifying the same date replaces the prior exception.
  const upsertException = useMutation({
    mutationFn: async (input: ExceptionInput) => {
      const row = {
        user_id: user!.id,
        rule_id: input.rule_id,
        date: input.date,
        type: input.type,
        modified_start: input.type === 'modified' ? input.modified_start ?? null : null,
        modified_end: input.type === 'modified' ? input.modified_end ?? null : null,
      };
      const { error } = await supabase
        .from('shift_exceptions')
        .upsert(row, { onConflict: 'rule_id,date' });
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['shift_exceptions'] }),
  });

  // Remove an exception for a (rule, date) — un-skip ("restore") or un-modify
  // ("revert to the rule's default"). No-op if none exists.
  const deleteException = useMutation({
    mutationFn: async ({ rule_id, date }: { rule_id: string; date: string }) => {
      const { error } = await supabase
        .from('shift_exceptions')
        .delete()
        .eq('rule_id', rule_id)
        .eq('date', date);
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['shift_exceptions'] }),
  });

  return {
    rules: rulesQuery.data || [],
    exceptions: exceptionsQuery.data || [],
    isLoading: rulesQuery.isLoading || exceptionsQuery.isLoading,
    addRule,
    toggleRuleActive,
    deleteRule,
    upsertException,
    deleteException,
  };
}
