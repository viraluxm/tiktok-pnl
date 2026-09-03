'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useUser } from './useUser';

const KEY = 'employee-override-pins';

/**
 * Which employees can authorise a pick override.
 *
 * The browser only ever learns WHO has a PIN, never what it is — the hash stays server-side.
 * Having a PIN is itself the authorisation, so this set is the list of leads; there is no
 * separate role flag, and employees.role is deliberately left alone because it feeds payroll.
 */
export function useOverridePins() {
  const { user } = useUser();
  const qc = useQueryClient();

  const query = useQuery<Set<string>>({
    queryKey: [KEY, user?.id],
    enabled: !!user,
    queryFn: async () => {
      const res = await fetch('/api/admin/employees/override-pins');
      if (!res.ok) throw new Error('Failed to load override PINs');
      const json = await res.json();
      return new Set<string>(json.employee_ids ?? []);
    },
    staleTime: 60_000,
  });

  const setPin = useMutation({
    // pin: null clears it, which is how override authority is revoked.
    mutationFn: async ({ employeeId, pin }: { employeeId: string; pin: string | null }) => {
      const res = await fetch(`/api/admin/employees/${employeeId}/override-pin`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'Failed to save PIN');
      return json;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: [KEY] }),
  });

  return { hasPin: query.data ?? new Set<string>(), isLoading: query.isPending, setPin };
}
