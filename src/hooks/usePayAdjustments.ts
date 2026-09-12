'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { createClient } from '@/lib/supabase/client';
import type { PayAdjustment } from '@/types';
import { useUser } from './useUser';

// BONUS / INCENTIVE PAY — the only read and write path for `employee_pay_adjustments` (150).
//
// SCOPED TO ONE PAY PERIOD, exactly like useShifts. The Pay tab already knows which period it is
// showing; a bonus belongs to a period and to nothing else, so the query filters on the period's
// own canonical boundaries rather than fetching a person's whole history and narrowing later.
//
// ─── WHY THIS IS A PLAIN POSTGREST WRITE AND NOT AN RPC ─────────────────────────────────────────
// useShifts routes its INSERT through lensed_create_manual_worked_shift because a second payable
// row over time already paid is a real hazard that a client-side "check then insert" cannot close.
// A bonus has no such hazard — several bonuses in one period is the REQUIREMENT, not a race — so
// the smallest correct thing is a direct write with the database enforcing every rule:
//
//   • WHO OWNS IT      `user_id` DEFAULTS to auth.uid() in SQL, so nothing below ever sends an
//                      owner id. RLS `with check (auth.uid() = user_id)` refuses any other value,
//                      so even a hand-forged request cannot write into another tenant.
//   • WHOSE EMPLOYEE   a COMPOSITE foreign key (employee_id, user_id) → employees (id, user_id).
//                      Postgres itself refuses a bonus that pairs this owner with another tenant's
//                      employee — RLS alone would not, because RLS only constrains user_id.
//   • HOW MUCH         `amount_cents > 0` and a $1,000,000 cap, as CHECK constraints.
//   • WHICH PERIOD     a CHECK pins (period_start, period_end) to the real biweekly cycle, so an
//                      off-cycle window is refused rather than becoming money no period displays.
//
// Every one of those is server-side and none of them is a UI rule. The forms below validate too,
// but only so the manager gets a sentence instead of a Postgres error.
//
// ─── NO OPTIMISTIC PAYROLL MATH ─────────────────────────────────────────────────────────────────
// Each mutation invalidates and refetches. Nothing here patches a cached list or adds a number to
// a total locally: the statement is rebuilt from what the database actually holds, which is the
// same discipline the shift editor follows and the reason a failed write can never leave a total
// on screen that nobody owes.

export interface BonusInput {
  employee_id: string;
  /** Canonical period boundaries, straight from payPeriodFor(). Never hand-built. */
  period_start: string;
  period_end: string;
  /** Integer cents, > 0. The form converts once, in dollarsToCents(). */
  amount_cents: number;
  description: string | null;
}

/**
 * Bonus rows for ONE pay period, across the whole roster.
 *
 * The Pay tab needs every employee's bonuses to total the tiles, and Pay Details needs one
 * person's; both read this one list, which is why it is not keyed by employee.
 */
export function usePayAdjustments(periodStart: string | null, periodEnd: string | null) {
  const { user } = useUser();
  const queryClient = useQueryClient();
  const supabase = createClient();

  // The period is part of the key, so moving to the previous period refetches rather than
  // showing the period you just left.
  const queryKey = ['pay_adjustments', user?.id, periodStart, periodEnd];

  const query = useQuery<PayAdjustment[]>({
    queryKey,
    enabled: !!user && !!periodStart && !!periodEnd,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('employee_pay_adjustments')
        .select('*')
        // RLS already scopes this to the caller; the period filter is what narrows it.
        .eq('period_start', periodStart as string)
        .eq('period_end', periodEnd as string)
        .order('created_at', { ascending: true });
      if (error) throw error;
      return (data || []) as PayAdjustment[];
    },
  });

  // Every mutation ends the same way: throw away what we think we know and read it back.
  const refetchAll = () => queryClient.invalidateQueries({ queryKey: ['pay_adjustments'] });

  const addBonus = useMutation({
    mutationFn: async (input: BonusInput) => {
      const { data, error } = await supabase
        .from('employee_pay_adjustments')
        // `user_id` IS ABSENT ON PURPOSE — the column defaults to auth.uid(). A client that cannot
        // name an owner cannot name the wrong one.
        .insert({
          employee_id: input.employee_id,
          period_start: input.period_start,
          period_end: input.period_end,
          kind: 'bonus',
          amount_cents: input.amount_cents,
          description: input.description,
        })
        .select('*')
        .single();
      if (error) throw new Error(bonusWriteErrorMessage(error));
      return data as PayAdjustment;
    },
    onSuccess: refetchAll,
  });

  // Amount and reason only. employee_id and the period are NOT editable: moving a bonus to another
  // person or another pay period is not a correction, it is a different bonus — delete and re-add,
  // which leaves an honest created_at behind instead of silently restating history.
  const updateBonus = useMutation({
    mutationFn: async ({ id, amount_cents, description }: {
      id: string; amount_cents: number; description: string | null;
    }) => {
      const { data, error } = await supabase
        .from('employee_pay_adjustments')
        .update({ amount_cents, description })
        .eq('id', id)
        .select('*')
        .single();
      if (error) throw new Error(bonusWriteErrorMessage(error));
      return data as PayAdjustment;
    },
    onSuccess: refetchAll,
  });

  const deleteBonus = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('employee_pay_adjustments').delete().eq('id', id);
      if (error) throw new Error(bonusWriteErrorMessage(error));
    },
    onSuccess: refetchAll,
  });

  return {
    adjustments: query.data || [],
    isLoading: query.isLoading,
    addBonus,
    updateBonus,
    deleteBonus,
  };
}

/** Tokens in, sentences out — a raw Postgres error never reaches a manager. */
export function bonusWriteErrorMessage(error: { message?: string; code?: string } | null): string {
  const raw = error?.message ?? '';
  if (raw.includes('employee_pay_adjustments_amount_positive')) return 'A bonus has to be more than $0.00.';
  if (raw.includes('employee_pay_adjustments_amount_sane')) return 'That amount is too large to be a bonus.';
  if (raw.includes('employee_pay_adjustments_period_canonical')) return 'That is not a real pay period. Reopen the Pay tab and try again.';
  if (raw.includes('employee_pay_adjustments_description_len')) return 'That reason is too long — keep it under 120 characters.';
  if (raw.includes('employee_pay_adjustments_employee_fk')) return 'That employee is not on your roster.';
  if (raw.includes('employee_pay_adjustments_kind_check')) return 'Only bonuses can be added here.';
  // RLS refusals arrive as this, and "row-level security policy" is not a sentence anyone wants.
  if (error?.code === '42501' || raw.includes('row-level security')) return 'You do not have access to change this bonus.';
  return 'Could not save that bonus. Try again.';
}
