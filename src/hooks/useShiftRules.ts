'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { createClient } from '@/lib/supabase/client';
import type { ShiftRule, ShiftException, ShiftExceptionType } from '@/types';
import { pastInstancesToMaterialize } from '@/lib/employees';
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
    queryClient.invalidateQueries({ queryKey: ['shifts'] }); // freeze may have added rows
  };

  // PRE-MUTATION FREEZE (the app-side guard that makes delete/deactivate immediate,
  // without waiting up to a day for the cron). Materializes the rule's PAST recurring
  // days into real `shifts` rows BEFORE the destructive change, so worked history
  // survives. Must run while the rule is still ACTIVE (the generator skips inactive
  // rules) — callers invoke it before flipping active=false / deleting. Idempotent:
  // the partial unique index + ignoreDuplicates make re-runs (and cron overlap) no-ops.
  async function freezeRulePast(ruleId: string): Promise<void> {
    const { data: rule } = await supabase.from('shift_rules').select('*').eq('id', ruleId).single();
    if (!rule) return; // already gone — nothing to freeze
    const { data: exs } = await supabase.from('shift_exceptions').select('*').eq('rule_id', ruleId);
    const { data: existing } = await supabase.from('shifts').select('date').eq('source_rule_id', ruleId);
    const materialized = new Set((existing ?? []).map((s) => `${ruleId}|${s.date as string}`));

    const instances = pastInstancesToMaterialize([rule as ShiftRule], (exs ?? []) as ShiftException[], materialized);
    if (instances.length === 0) return;

    const rows = instances.map((i) => ({
      user_id: user!.id,
      employee_id: i.employee_id,
      date: i.date,
      start_time: i.start_time,
      end_time: i.end_time,
      store_id: (rule as ShiftRule).store_id ?? null,
      source_rule_id: ruleId,
    }));
    const { error } = await supabase
      .from('shifts')
      .upsert(rows, { onConflict: 'employee_id,date,source_rule_id', ignoreDuplicates: true });
    if (error) throw error;
  }

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
      // Deactivating stops future generation AND would erase past projected hours —
      // freeze them first. (Reactivating adds nothing to protect, so no freeze.)
      if (!active) await freezeRulePast(id);
      const { error } = await supabase
        .from('shift_rules')
        .update({ active, updated_at: new Date().toISOString() })
        .eq('id', id);
      if (error) throw error;
    },
    onSuccess: invalidate,
  });

  // Deleting a rule stops FUTURE generation and (via FK) cascades its exceptions. Past
  // worked days are FROZEN into real `shifts` rows first (freezeRulePast), and the
  // shifts→rule FK is ON DELETE SET NULL, so those rows survive the delete as plain
  // one-off shifts. This is what stops the history-loss bug at the source.
  const deleteRule = useMutation({
    mutationFn: async (id: string) => {
      await freezeRulePast(id);
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
