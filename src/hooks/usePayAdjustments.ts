'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { createClient } from '@/lib/supabase/client';
import type { PayAdjustment, PayAdjustmentCalculationType } from '@/types';
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
//   • HOW MUCH         a PAIR of CHECK constraints, one per calculation type, each requiring its
//                      own column to be present and positive AND the other to be NULL. A row that
//                      is half flat and half hourly — or neither — cannot exist, so nothing
//                      downstream has to cope with one.
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

/**
 * What the form collects. EXACTLY ONE of `amount_cents` / `rate_cents_per_hour` is set, and the
 * other is explicitly NULL rather than omitted — see the write below for why that matters.
 */
export interface BonusFields {
  calculation_type: PayAdjustmentCalculationType;
  /** FLAT: integer cents, > 0. NULL on an hourly bonus. */
  amount_cents: number | null;
  /** HOURLY: integer cents per payable hour, > 0. NULL on a flat bonus. */
  rate_cents_per_hour: number | null;
  description: string | null;
}

export interface BonusInput extends BonusFields {
  employee_id: string;
  /** Canonical period boundaries, straight from payPeriodFor(). Never hand-built. */
  period_start: string;
  period_end: string;
}

/**
 * THE SHAPE THE DATABASE WILL ACCEPT, built in one place from a type and a value.
 *
 * Both columns are ALWAYS named, one of them as null. Leaving the unused column out of an UPDATE
 * would leave whatever was there before in place, and the CHECK constraints would then reject the
 * row — or, worse on an INSERT, a future default could fill it. Being explicit costs nothing and
 * means the "exactly one of these two" rule is expressed identically on the way in and in the
 * schema. (A type change is not offered in the edit form — see BonusPanel — so in practice an
 * update rewrites the same pair it read, but the write does not depend on that.)
 */
export function bonusColumns(fields: BonusFields) {
  const hourly = fields.calculation_type === 'hourly';
  return {
    kind: 'bonus' as const,
    calculation_type: fields.calculation_type,
    amount_cents: hourly ? null : fields.amount_cents,
    rate_cents_per_hour: hourly ? fields.rate_cents_per_hour : null,
    description: fields.description,
  };
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
          ...bonusColumns(input),
        })
        .select('*')
        .single();
      if (error) throw new Error(bonusWriteErrorMessage(error));
      return data as PayAdjustment;
    },
    onSuccess: refetchAll,
  });

  // The FIGURE and the reason only. employee_id, the period and the CALCULATION TYPE are not
  // editable: moving a bonus to another person or another pay period is not a correction, it is a
  // different bonus — and so is turning $2.00 from a one-off payment into a per-hour rate worth
  // seventy times as much. Each is delete-and-re-add, which leaves an honest created_at behind
  // instead of silently restating history. (The write below is still shaped by bonusColumns, so it
  // sets both money columns explicitly and cannot leave a half-converted row behind.)
  const updateBonus = useMutation({
    mutationFn: async ({ id, ...fields }: { id: string } & BonusFields) => {
      const { calculation_type, ...patch } = bonusColumns(fields);
      void calculation_type; // never changed by an edit; named here only to keep it out of the patch
      const { data, error } = await supabase
        .from('employee_pay_adjustments')
        .update(patch)
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
  if (raw.includes('employee_pay_adjustments_flat_shape')) return 'A flat bonus needs an amount of more than $0.00.';
  if (raw.includes('employee_pay_adjustments_hourly_shape')) return 'An hourly bonus needs a per-hour rate of more than $0.00.';
  if (raw.includes('employee_pay_adjustments_amount_sane')) return 'That amount is too large to be a bonus.';
  if (raw.includes('employee_pay_adjustments_rate_sane')) return 'That is too large to be a per-hour bonus rate.';
  if (raw.includes('employee_pay_adjustments_calculation_type_check')) return 'A bonus must be either a flat amount or an hourly rate.';
  if (raw.includes('employee_pay_adjustments_period_canonical')) return 'That is not a real pay period. Reopen the Pay tab and try again.';
  if (raw.includes('employee_pay_adjustments_description_len')) return 'That reason is too long — keep it under 120 characters.';
  if (raw.includes('employee_pay_adjustments_employee_fk')) return 'That employee is not on your roster.';
  if (raw.includes('employee_pay_adjustments_kind_check')) return 'Only bonuses can be added here.';
  // RLS refusals arrive as this, and "row-level security policy" is not a sentence anyone wants.
  if (error?.code === '42501' || raw.includes('row-level security')) return 'You do not have access to change this bonus.';
  return 'Could not save that bonus. Try again.';
}
