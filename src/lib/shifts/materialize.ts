import { createAdminClient } from '@/lib/supabase/admin';
import { pastInstancesToMaterialize } from '@/lib/employees';
import type { ShiftRule, ShiftException } from '@/types';

// RECURRING-SHIFT MATERIALIZATION — shared core (verified logic; the cron and any manual
// trigger call this SAME path). Freezes every ACTIVE rule's PAST (date < today) recurring
// days into real `shifts` rows so worked history survives deletion/deactivation/edit of
// the rule. Additive + idempotent: the partial unique index (migration 055) + ON CONFLICT
// DO NOTHING make re-runs (and freeze/cron overlap) no-ops.
//
// Scope: ACTIVE rules only. Deactivation is covered by the app-side pre-mutation freeze
// (which runs while the rule is still active). A rule deactivated by direct SQL without
// that freeze is the same accepted residual gap as a direct-SQL delete — see the cron
// route comment.
//
// "Past" is strict (date < today): today's in-progress day stays a live projection,
// owned by the generator until it becomes past. Exactly-once is guaranteed by the
// generator excluding any (rule,date) that has a row here.

export interface MaterializeResult {
  dry_run: boolean;
  rules_scanned: number;
  would_materialize_count: number;
  would_materialize: { employee_id: string; rule_id: string; date: string; start_time: string; end_time: string }[];
  materialized: number;
}

export async function materializePastShifts(opts: { write: boolean }): Promise<MaterializeResult> {
  const write = opts.write;
  const admin = createAdminClient();

  const { data: ruleRows, error: rErr } = await admin
    .from('shift_rules')
    .select('*')
    .eq('active', true);
  if (rErr) throw new Error(`shift_rules read failed: ${rErr.message}`);
  const rules = (ruleRows ?? []) as ShiftRule[];

  if (rules.length === 0) {
    return { dry_run: !write, rules_scanned: 0, would_materialize_count: 0, would_materialize: [], materialized: 0 };
  }

  const ruleIds = rules.map((r) => r.id);

  // Exceptions for these rules (so 'skip' days are never materialized and 'modified'
  // days materialize with their overridden hours).
  const { data: exRows, error: eErr } = await admin
    .from('shift_exceptions')
    .select('*')
    .in('rule_id', ruleIds);
  if (eErr) throw new Error(`shift_exceptions read failed: ${eErr.message}`);
  const exceptions = (exRows ?? []) as ShiftException[];

  // Already-materialized (rule,date) pairs — the idempotency/exclusion set.
  const { data: existing, error: xErr } = await admin
    .from('shifts')
    .select('source_rule_id, date')
    .in('source_rule_id', ruleIds);
  if (xErr) throw new Error(`shifts read failed: ${xErr.message}`);
  const materialized = new Set(
    (existing ?? []).map((s) => `${s.source_rule_id as string}|${s.date as string}`),
  );

  // Compute strictly-past, non-skipped, not-yet-frozen instances (shared pure logic).
  const instances = pastInstancesToMaterialize(rules, exceptions, materialized);

  // Rows carry user_id + store_id from their rule (admin client bypasses RLS).
  const ruleById = new Map(rules.map((r) => [r.id, r]));
  const rows = instances.map((i) => {
    const rule = ruleById.get(i.rule_id)!;
    return {
      user_id: rule.user_id,
      employee_id: i.employee_id,
      date: i.date,
      start_time: i.start_time,
      end_time: i.end_time,
      store_id: rule.store_id ?? null,
      source_rule_id: i.rule_id,
    };
  });

  let inserted = 0;
  if (write && rows.length) {
    // ON CONFLICT DO NOTHING against idx_shifts_materialized_unique — safe re-runs.
    const { data, error } = await admin
      .from('shifts')
      .upsert(rows, { onConflict: 'employee_id,date,source_rule_id', ignoreDuplicates: true })
      .select('id');
    if (error) throw new Error(`materialize upsert failed: ${error.message}`);
    inserted = data?.length ?? 0;
  }

  return {
    dry_run: !write,
    rules_scanned: rules.length,
    would_materialize_count: rows.length,
    would_materialize: instances,
    materialized: write ? inserted : 0,
  };
}
