'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useEmployees } from '@/hooks/useEmployees';
import { code128ToSvg } from '@/lib/barcode/code128';

interface Badge {
  id: string;
  employee_id: string;
  code: string;
  active: boolean;
  issued_at: string;
  revoked_at: string | null;
}

function escapeHtml(s: string): string {
  return s.replace(/[<>&"']/g, (c) =>
    c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '&' ? '&amp;' : c === '"' ? '&quot;' : '&#39;',
  );
}

// Owner-facing badge administration: issue / revoke per employee, print a badge sheet, and a
// one-time "Enable kiosk" provisioning of the internal kiosk token. Runs under the owner session;
// all writes go through /api/admin/* server routes (the client never mutates employee_badges
// directly). Employees come from useEmployees (owner's own-row RLS) purely to label rows.
export default function BadgeAdmin() {
  const { employees } = useEmployees();
  const [badges, setBadges] = useState<Badge[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [kioskActive, setKioskActive] = useState<boolean | null>(null);

  const loadBadges = useCallback(async () => {
    setError(null);
    const res = await fetch('/api/admin/badges', { method: 'GET' });
    const j = (await res.json().catch(() => ({}))) as { badges?: Badge[]; error?: string };
    if (!res.ok) {
      setError(j.error ?? 'Could not load badges.');
      return;
    }
    setBadges(Array.isArray(j.badges) ? j.badges : []);
  }, []);

  const loadKiosk = useCallback(async () => {
    const res = await fetch('/api/admin/kiosk-tokens', { method: 'GET' });
    const j = (await res.json().catch(() => ({}))) as { active?: boolean };
    setKioskActive(res.ok ? !!j.active : null);
  }, []);

  useEffect(() => {
    void loadBadges();
    void loadKiosk();
  }, [loadBadges, loadKiosk]);

  const activeByEmployee = useMemo(() => {
    const m = new Map<string, Badge>();
    for (const b of badges) if (b.active) m.set(b.employee_id, b);
    return m;
  }, [badges]);

  const activeEmployees = useMemo(
    () => employees.filter((e) => e.status === 'active'),
    [employees],
  );

  const issue = async (employeeId: string) => {
    setBusy(true);
    setError(null);
    const res = await fetch('/api/admin/badges', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employee_id: employeeId }),
    });
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    setBusy(false);
    if (!res.ok) {
      setError(j.error ?? 'Could not issue badge.');
      return;
    }
    await loadBadges();
  };

  const revoke = async (badgeId: string) => {
    setBusy(true);
    setError(null);
    const res = await fetch('/api/admin/badges', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ badge_id: badgeId }),
    });
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    setBusy(false);
    if (!res.ok) {
      setError(j.error ?? 'Could not revoke badge.');
      return;
    }
    await loadBadges();
  };

  const enableKiosk = async () => {
    setBusy(true);
    setError(null);
    const res = await fetch('/api/admin/kiosk-tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    setBusy(false);
    if (!res.ok) {
      setError(j.error ?? 'Could not enable kiosk.');
      return;
    }
    await loadKiosk();
  };

  const printSheet = () => {
    const cards = activeEmployees
      .map((emp) => {
        const b = activeByEmployee.get(emp.id);
        if (!b) return '';
        return (
          `<div style="display:inline-block;margin:10px;padding:10px;border:1px solid #ccc;border-radius:8px;text-align:center;page-break-inside:avoid;">` +
          `<div style="font-family:sans-serif;font-size:15px;font-weight:600;margin-bottom:6px;">${escapeHtml(emp.name)}</div>` +
          code128ToSvg(b.code, { caption: b.code, moduleWidth: 2, barHeight: 60 }) +
          `</div>`
        );
      })
      .join('');
    const w = window.open('', '_blank');
    if (!w) return;
    w.document.write(`<!doctype html><html><head><title>Employee badges</title></head><body>${cards}</body></html>`);
    w.document.close();
    w.focus();
    w.print();
  };

  const hasAnyActiveBadge = activeByEmployee.size > 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-gray-900">Employee badges</h1>
        <button
          onClick={printSheet}
          disabled={!hasAnyActiveBadge}
          className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 disabled:opacity-50"
        >
          Print badge sheet
        </button>
      </div>

      <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 text-sm">
        <span className="font-medium text-gray-700">Kiosk: </span>
        {kioskActive === null ? (
          <span className="text-gray-500">checking…</span>
        ) : kioskActive ? (
          <span className="text-emerald-700">enabled</span>
        ) : (
          <span className="text-gray-600">
            not enabled{' '}
            <button onClick={enableKiosk} disabled={busy} className="ml-2 rounded-md bg-gray-900 px-3 py-1 text-white disabled:opacity-50">
              Enable kiosk
            </button>
          </span>
        )}
      </div>

      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm font-medium text-red-700">{error}</p>}

      <ul className="divide-y divide-gray-200 rounded-lg border border-gray-200">
        {activeEmployees.map((emp) => {
          const b = activeByEmployee.get(emp.id);
          return (
            <li key={emp.id} className="flex items-center justify-between gap-4 px-4 py-3">
              <div>
                <p className="font-medium text-gray-900">{emp.name}</p>
                <p className="text-sm text-gray-500">{emp.role}</p>
              </div>
              <div className="flex items-center gap-3">
                {b ? (
                  <>
                    <code className="rounded bg-gray-100 px-2 py-1 font-mono text-sm text-gray-800">{b.code}</code>
                    <button onClick={() => revoke(b.id)} disabled={busy} className="text-sm font-medium text-red-600 disabled:opacity-50">
                      Revoke
                    </button>
                    <button
                      onClick={async () => { await revoke(b.id); await issue(emp.id); }}
                      disabled={busy}
                      className="text-sm font-medium text-gray-700 disabled:opacity-50"
                    >
                      Reissue
                    </button>
                  </>
                ) : (
                  <button onClick={() => issue(emp.id)} disabled={busy} className="rounded-md bg-gray-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50">
                    Issue badge
                  </button>
                )}
              </div>
            </li>
          );
        })}
        {activeEmployees.length === 0 && <li className="px-4 py-6 text-center text-gray-500">No active employees.</li>}
      </ul>
    </div>
  );
}
