'use client';

import { useCallback, useEffect, useState } from 'react';

// Roster badge state — a thin client over the EXISTING /api/admin/badges endpoints (GET list, POST
// issue, PATCH revoke). This is a second entry point onto that logic, not a second implementation:
// issue/reissue hit the same routes BadgeAdmin uses. Reissue = revoke the active badge then issue a
// fresh one (the same two calls BadgeAdmin makes), so the old printed code dies immediately.
export interface ActiveBadge {
  id: string;
  code: string;
}
type BadgeRow = { id: string; employee_id: string; code: string; active: boolean };

export function useBadges() {
  const [byEmployee, setByEmployee] = useState<Record<string, ActiveBadge>>({});

  const reload = useCallback(async () => {
    const res = await fetch('/api/admin/badges', { cache: 'no-store' });
    if (!res.ok) return;
    const j = (await res.json().catch(() => ({}))) as { badges?: BadgeRow[] };
    const map: Record<string, ActiveBadge> = {};
    for (const b of j.badges ?? []) if (b.active) map[b.employee_id] = { id: b.id, code: b.code };
    setByEmployee(map);
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  const issue = useCallback(async (employeeId: string) => {
    const res = await fetch('/api/admin/badges', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employee_id: employeeId }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'Could not issue badge');
    await reload();
  }, [reload]);

  // Revoke the current badge, then issue a new one — same sequence as BadgeAdmin's Reissue.
  const reissue = useCallback(async (employeeId: string, badgeId: string) => {
    const r1 = await fetch('/api/admin/badges', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ badge_id: badgeId }),
    });
    if (!r1.ok) throw new Error((await r1.json().catch(() => ({}))).error ?? 'Could not revoke badge');
    await issue(employeeId);
  }, [issue]);

  return { byEmployee, issue, reissue, reload };
}
