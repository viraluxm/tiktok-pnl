'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { fmtCalendarDate } from '@/lib/schedule/format';
import type { ScheduleEntry, ScheduleCounts, ScheduleRefusal } from '@/lib/schedule/schedulePlan';

// The one client mutation for planned shifts. Shared by the employee Schedule Builder and the
// day/crew modal so both hit POST /api/admin/schedule/instances/bulk and invalidate the same cache.
//
// Invalidation is by PREFIX: every `['shift_instances', …]` query — the month calendar, the
// builder's current and previous week, the roster summary — drops its data at once. No optimistic
// updates, no hand-spliced caches; same convention as every sibling mutation in this codebase.
export const SHIFT_INSTANCES_QUERY_PREFIX = ['shift_instances'] as const;

export interface ScheduleBulkInput {
  entries: ScheduleEntry[];
  dryRun?: boolean;
}

export type ScheduleBulkResult = ScheduleCounts & {
  ok: true;
  dryRun: boolean;
  /** Dates whose existing times this operation replaces / removes. */
  updatedDates: string[];
  removedDates: string[];
  /**
   * PER-ROW capacity refusals (157). These arrive on a SUCCESSFUL save: the days that fit were
   * written, and these are the ones that did not. Distinct from ScheduleRefusedError, which means
   * the planner refused and nothing at all was written.
   */
  refusals: ScheduleRefusal[];
};

/** Thrown when the server refuses one or more days (HTTP 409). Nothing was written. */
export class ScheduleRefusedError extends Error {
  refusals: ScheduleRefusal[];
  constructor(refusals: ScheduleRefusal[]) {
    super(summariseRefusals(refusals));
    this.name = 'ScheduleRefusedError';
    this.refusals = refusals;
  }
}

/**
 * THE PARTIAL-SAVE SENTENCE. Returns null when everything asked for was written.
 *
 * A capacity refusal (157) arrives on a SUCCESSFUL save: the days that fit are already in the
 * database and the ones that did not are not. So the manager must never see a bare success, and
 * must never see a bare failure either — both are lies about what is now on the schedule. This
 * says what landed, how much did not, and enough about the first casualty to act on it: WHO and
 * WHICH DAY. Anything more is a list nobody reads.
 *
 * `nameOf` is supplied by the caller because only it knows the crew it just scheduled. Without it
 * the sentence still names the day, which is the minimum a manager needs to find the row again.
 */
export function summarisePartialSave(
  result: Pick<ScheduleBulkResult, 'created' | 'updated' | 'refusals'>,
  nameOf?: (employeeId: string) => string | undefined,
): string | null {
  const refusals = result.refusals ?? [];
  if (refusals.length === 0) return null;
  const saved = (result.created ?? 0) + (result.updated ?? 0);
  const first = refusals[0];
  const who = nameOf?.(first.employeeId);
  const where = `${who ? `${who} on ` : ''}${fmtCalendarDate(first.date)}`;
  const more = refusals.length - 1;
  const head = saved > 0 ? `${saved} shift${saved === 1 ? '' : 's'} scheduled. ` : '';
  const tail = more > 0 ? `, plus ${more} more.` : '.';
  return `${head}${refusals.length} shift${refusals.length === 1 ? '' : 's'} could not be scheduled: ${where} is fully staffed${tail}`;
}

export function summariseRefusals(refusals: ScheduleRefusal[]): string {
  if (refusals.length === 0) return 'Some days could not be saved.';
  const first = refusals[0];
  const more = refusals.length - 1;
  return more > 0 ? `${first.date}: ${first.message} (+${more} more)` : `${first.date}: ${first.message}`;
}

export async function postScheduleBulk(input: ScheduleBulkInput): Promise<ScheduleBulkResult> {
  const res = await fetch('/api/admin/schedule/instances/bulk', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entries: input.entries, dryRun: input.dryRun === true }),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 409 && Array.isArray(data.refusals)) throw new ScheduleRefusedError(data.refusals);
  if (!res.ok) throw new Error(data.error ?? 'Could not save the schedule.');
  return {
    ...data,
    updatedDates: data.updatedDates ?? [],
    removedDates: data.removedDates ?? [],
    refusals: data.refusals ?? [],
  } as ScheduleBulkResult;
}

export function useScheduleBulk() {
  const queryClient = useQueryClient();
  const apply = useMutation({
    mutationFn: postScheduleBulk,
    onSuccess: (_result, vars) => {
      // A dry run wrote nothing, so there is nothing to refetch.
      if (vars.dryRun) return;
      queryClient.invalidateQueries({ queryKey: [...SHIFT_INSTANCES_QUERY_PREFIX] });
    },
  });
  return { apply };
}
