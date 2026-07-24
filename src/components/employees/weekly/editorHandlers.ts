import type { Employee } from '@/types';
import type { EditorHandlers } from './ShiftEditorModal';

// Minimal shape of a react-query mutation we call.
type Mutation<T> = { mutateAsync: (v: T) => Promise<unknown> };

// Build the shift-editor handlers (create / update / delete / modify-occurrence /
// skip-occurrence) from the existing useShifts + useShiftRules mutations. Shared by BOTH
// the weekly and monthly calendars so the mutation logic is defined exactly once.
export function makeEditorHandlers(p: {
  employees: Employee[];
  nameById: (id: string) => string;
  addShift: Mutation<{ employee_id: string; date: string; start_time: string; end_time: string | null }>;
  updateShift: Mutation<{ id: string; start_time?: string; end_time?: string | null }>;
  deleteShift: Mutation<string>;
  upsertException: Mutation<{
    rule_id: string;
    date: string;
    type: 'skip' | 'modified';
    modified_start?: string | null;
    modified_end?: string | null;
  }>;
}): EditorHandlers {
  return {
    employees: p.employees,
    nameById: p.nameById,
    onCreate: async (input) => {
      await p.addShift.mutateAsync(input);
    },
    onUpdate: async (id, patch) => {
      await p.updateShift.mutateAsync({ id, ...patch });
    },
    onDeleteOneOff: async (id) => {
      await p.deleteShift.mutateAsync(id);
    },
    onModifyOccurrence: async (ruleId, date, start, end) => {
      await p.upsertException.mutateAsync({ rule_id: ruleId, date, type: 'modified', modified_start: start, modified_end: end });
    },
    onSkipOccurrence: async (ruleId, date) => {
      await p.upsertException.mutateAsync({ rule_id: ruleId, date, type: 'skip' });
    },
  };
}
