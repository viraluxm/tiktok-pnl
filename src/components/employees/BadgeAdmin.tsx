'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useEmployees } from '@/hooks/useEmployees';

interface Badge {
  id: string;
  employee_id: string;
  code: string;
  active: boolean;
  issued_at: string;
  revoked_at: string | null;
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
  const [kioskAccounts, setKioskAccounts] = useState<{ id: string; email: string | null; stores: string[]; banned: boolean }[]>([]);
  const [reveal, setReveal] = useState<{ id: string; password: string } | null>(null);

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

  const loadKioskAccounts = useCallback(async () => {
    const res = await fetch('/api/admin/kiosk-session', { method: 'GET' });
    const j = (await res.json().catch(() => ({}))) as { accounts?: { id: string; email: string | null; stores: string[]; banned: boolean }[] };
    setKioskAccounts(res.ok && Array.isArray(j.accounts) ? j.accounts : []);
  }, []);

  useEffect(() => {
    void loadBadges();
    void loadKiosk();
    void loadKioskAccounts();
  }, [loadBadges, loadKiosk, loadKioskAccounts]);

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

  // Rolling the kiosk out means issuing ~40 badges. One click per person made that a chore
  // nobody would finish, which is part of why the kiosk sat unused. Sequential rather than
  // parallel so a mid-run failure names the person it stopped on and the successes before it
  // still stand — the route is idempotent per employee, so a re-run only fills the gaps.
  const issueAllMissing = async () => {
    const missing = activeEmployees.filter((e) => !activeByEmployee.get(e.id));
    if (missing.length === 0) return;
    if (!confirm(`Issue a badge to ${missing.length} employee${missing.length === 1 ? '' : 's'} who have none?`)) return;

    setBusy(true);
    setError(null);
    let issued = 0;
    for (const e of missing) {
      const res = await fetch('/api/admin/badges', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ employee_id: e.id }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setError(`Stopped at ${e.name}: ${j.error ?? 'could not issue badge'}. ${issued} issued before this — run again to finish the rest.`);
        break;
      }
      issued += 1;
    }
    setBusy(false);
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

  // Disable the kiosk — stops punching immediately (revokes the active token). Does NOT end the
  // tablet session; that's Kill session.
  const disableKiosk = async () => {
    setBusy(true);
    setError(null);
    const res = await fetch('/api/admin/kiosk-tokens', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active: false }),
    });
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    setBusy(false);
    if (!res.ok) {
      setError(j.error ?? 'Could not disable kiosk.');
      return;
    }
    await loadKiosk();
  };

  // Kill (ban + rotate) / Rotate password / Unban the kiosk (timeclock) account. A new password
  // comes back once for kill/rotate; Rotate stays available so a missed reveal can't brick it.
  const kioskSession = async (action: 'kill' | 'rotate' | 'unban', accountId: string) => {
    setBusy(true);
    setError(null);
    setReveal(null);
    const res = await fetch('/api/admin/kiosk-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, account_id: accountId }),
    });
    const j = (await res.json().catch(() => ({}))) as { error?: string; password?: string };
    setBusy(false);
    if (!res.ok) {
      setError(j.error ?? 'Action failed.');
      return;
    }
    if (j.password) setReveal({ id: accountId, password: j.password });
    await loadKioskAccounts();
  };

  // Photo capture (part of the badge-setup flow): server-mediated upload → employees.photo_path.
  const uploadPhoto = async (employeeId: string, file: File) => {
    setBusy(true);
    setError(null);
    const form = new FormData();
    form.append('file', file);
    const res = await fetch(`/api/admin/employees/${employeeId}/photo`, { method: 'POST', body: form });
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    setBusy(false);
    if (!res.ok) setError(j.error ?? 'Could not upload photo.');
  };

  // Print sheet is built server-side with headshots inlined as data-URIs (no signed-URL expiry race);
  // anyone without a photo gets an initials monogram.
  const printSheet = async () => {
    setError(null);
    const res = await fetch('/api/admin/badges/print-sheet', { method: 'POST' });
    if (!res.ok) {
      setError('Could not build the badge sheet.');
      return;
    }
    const html = await res.text();
    const w = window.open('', '_blank');
    if (!w) return;
    w.document.write(html);
    w.document.close();
    w.focus();
    w.print();
  };

  const hasAnyActiveBadge = activeByEmployee.size > 0;
  const missingBadgeCount = activeEmployees.filter((e) => !activeByEmployee.get(e.id)).length;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-tt-text">Employee badges</h1>
        <button
          onClick={printSheet}
          disabled={!hasAnyActiveBadge}
          className="rounded-lg border border-tt-border px-4 py-2 text-sm font-medium text-tt-text disabled:opacity-50"
        >
          Print badge sheet
        </button>
        <button
          onClick={issueAllMissing}
          disabled={busy || missingBadgeCount === 0}
          title={missingBadgeCount === 0 ? 'Everyone active already has a badge' : undefined}
          className="rounded-lg bg-tt-cyan px-4 py-2 text-sm font-medium text-black disabled:opacity-50"
        >
          {missingBadgeCount === 0
            ? 'All staff have badges'
            : `Issue badges to ${missingBadgeCount} without one`}
        </button>
      </div>

      <div className="space-y-3 rounded-lg border border-tt-border bg-tt-card/[0.03] p-4 text-sm">
        <div className="flex items-center gap-3">
          <span className="font-medium text-tt-text">Kiosk:</span>
          {kioskActive === null ? (
            <span className="text-tt-muted">checking…</span>
          ) : kioskActive ? (
            <>
              <span className="font-medium text-emerald-700">enabled</span>
              <button onClick={disableKiosk} disabled={busy} className="ml-auto rounded-md border border-red-300 px-3 py-1 font-medium text-red-700 disabled:opacity-50">
                Disable kiosk
              </button>
            </>
          ) : (
            <>
              <span className="font-medium text-tt-muted">disabled</span>
              <button onClick={enableKiosk} disabled={busy} className="ml-auto rounded-md bg-tt-cyan px-3 py-1 font-medium text-white disabled:opacity-50">
                Enable kiosk
              </button>
            </>
          )}
        </div>

        {kioskActive === false && (
          <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-amber-800">
            <p className="font-medium">Punching disabled — but the tablet session is still active.</p>
            <p className="mt-0.5">
              Ban and rotate the timeclock user to actually end it (Kill session below).{' '}
              <a className="underline" target="_blank" rel="noreferrer"
                href="https://github.com/viraluxm/tiktok-pnl/blob/main/docs/operations/kiosk-time-clock-runbook.md">
                Revoke runbook
              </a>
            </p>
          </div>
        )}

        <div className="border-t border-tt-border pt-3">
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-tt-muted">Kiosk tablets — each killed independently</p>
          {kioskAccounts.length === 0 ? (
            <p className="text-xs text-tt-muted">No kiosk accounts yet. Create one in Team → “Time clock kiosk”.</p>
          ) : (
            <ul className="space-y-2">
              {kioskAccounts.map((a) => (
                <li key={a.id} className="rounded-md border border-tt-border bg-tt-card p-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-tt-text">{a.email ?? a.id}</span>
                    {a.banned && <span className="rounded bg-red-100 px-1.5 py-0.5 text-[11px] font-medium text-red-700">killed</span>}
                    <div className="ml-auto flex gap-2">
                      <button onClick={() => kioskSession('kill', a.id)} disabled={busy} className="rounded-md bg-red-600 px-2.5 py-1 text-xs font-medium text-white disabled:opacity-50">Kill (ban + rotate)</button>
                      <button onClick={() => kioskSession('rotate', a.id)} disabled={busy} className="rounded-md border border-tt-border px-2.5 py-1 text-xs font-medium text-tt-text disabled:opacity-50">Rotate</button>
                      <button onClick={() => kioskSession('unban', a.id)} disabled={busy || !a.banned} className="rounded-md border border-tt-border px-2.5 py-1 text-xs font-medium text-tt-text disabled:opacity-50">Unban</button>
                    </div>
                  </div>
                  {reveal?.id === a.id && (
                    <div className="mt-2 rounded-md border border-tt-border bg-tt-card/[0.03] px-2 py-1.5">
                      <p className="text-[11px] text-tt-muted">New password — shown once. Sign the tablet back in; Rotate again if you miss it.</p>
                      <code className="mt-0.5 block break-all font-mono text-xs text-tt-text">{reveal.password}</code>
                      <button onClick={() => setReveal(null)} className="mt-0.5 text-[11px] text-tt-muted underline">Dismiss</button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm font-medium text-red-700">{error}</p>}

      <ul className="divide-y divide-[rgba(255,255,255,0.06)] rounded-lg border border-tt-border">
        {activeEmployees.map((emp) => {
          const b = activeByEmployee.get(emp.id);
          return (
            <li key={emp.id} className="flex items-center justify-between gap-4 px-4 py-3">
              <div>
                <p className="font-medium text-tt-text">{emp.name}</p>
                <p className="text-sm text-tt-muted">{emp.role}</p>
              </div>
              <div className="flex items-center gap-3">
                <label className="cursor-pointer text-sm font-medium text-tt-muted hover:text-tt-text">
                  {(emp as { photo_path?: string | null }).photo_path ? 'Photo ✓' : 'Add photo'}
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) void uploadPhoto(emp.id, f);
                      e.currentTarget.value = '';
                    }}
                  />
                </label>
                {b ? (
                  <>
                    <code className="rounded bg-white/10 px-2 py-1 font-mono text-sm text-tt-text">{b.code}</code>
                    <button onClick={() => revoke(b.id)} disabled={busy} className="text-sm font-medium text-red-600 disabled:opacity-50">
                      Revoke
                    </button>
                    <button
                      onClick={async () => { await revoke(b.id); await issue(emp.id); }}
                      disabled={busy}
                      className="text-sm font-medium text-tt-text disabled:opacity-50"
                    >
                      Reissue
                    </button>
                  </>
                ) : (
                  <button onClick={() => issue(emp.id)} disabled={busy} className="rounded-md bg-tt-cyan px-3 py-1.5 text-sm font-medium text-black disabled:opacity-50">
                    Issue badge
                  </button>
                )}
              </div>
            </li>
          );
        })}
        {activeEmployees.length === 0 && <li className="px-4 py-6 text-center text-tt-muted">No active employees.</li>}
      </ul>
    </div>
  );
}
