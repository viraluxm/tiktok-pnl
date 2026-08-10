'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { createClient } from '@/lib/supabase/client';
import { useUser } from './useUser';

// Active schedule-link tokens for the roster, keyed by employee_id. Read under the admin's own
// session (RLS: employee_access_tokens is user_id-scoped, so this returns only the owner's tokens).
// Mint/revoke go through the admin-gated API route (server enforces app_metadata.role === 'admin').

export interface ScheduleLink {
  id: string;
  employee_id: string;
  token: string;
  created_at: string;
}

// The public link base. Always the production URL (these get texted to employees), overridable via
// NEXT_PUBLIC_APP_URL. Mirrors tokenLink() on the server.
const LINK_BASE = (process.env.NEXT_PUBLIC_APP_URL || 'https://lensed.io').replace(/\/$/, '');
export function scheduleLinkUrl(token: string): string {
  return `${LINK_BASE}/s/${token}`;
}

export function useScheduleLinks() {
  const { user } = useUser();
  const queryClient = useQueryClient();
  const supabase = createClient();

  const query = useQuery<Record<string, ScheduleLink>>({
    queryKey: ['schedule_links', user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('employee_access_tokens')
        .select('id, employee_id, token, created_at')
        .eq('active', true);
      if (error) throw error;
      const byEmployee: Record<string, ScheduleLink> = {};
      // At most one active token per employee (the mint route revokes prior ones); if two ever
      // exist, keep the newest so Copy is deterministic.
      for (const t of (data ?? []) as ScheduleLink[]) {
        const prev = byEmployee[t.employee_id];
        if (!prev || t.created_at > prev.created_at) byEmployee[t.employee_id] = t;
      }
      return byEmployee;
    },
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['schedule_links'] });

  // Mint (also acts as regenerate — the route revokes any prior active token first). Returns the
  // full URL for immediate clipboard copy.
  const mint = useMutation({
    mutationFn: async (employeeId: string): Promise<{ url: string }> => {
      const res = await fetch('/api/admin/schedule/tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ employeeId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not create link');
      return { url: data.link as string };
    },
    onSuccess: invalidate,
  });

  const revoke = useMutation({
    mutationFn: async (tokenId: string) => {
      const res = await fetch('/api/admin/schedule/tokens', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tokenId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not revoke link');
    },
    onSuccess: invalidate,
  });

  return { byEmployee: query.data ?? {}, isLoading: query.isLoading, mint, revoke };
}
