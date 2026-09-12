'use client';

import { useEffect, useMemo, useState } from 'react';
import MemberNav from '@/components/member/MemberNav';
import { DROP_CAP } from '@/lib/schedule/drops';
import { toTimecardEntry, type TimecardShiftRow } from '@/lib/schedule/timecardModel';
import { payrollTeamOfRole, type PayrollTeam } from '@/lib/employees';
import { dowShort, fmtDuration, fmtTimeLA, laDateOf } from '@/lib/schedule/portalModel';

// Member 'team' scope — READ-ONLY roster / schedule / performance under the bare (station) layout.
// NO pay (no rates, no pay owed), NO edit actions, NO shift confirm, NO token mint. Fed by the
// owner-scoped /api/member/team routes and their children (host-performance returns counts
// only — no cost). NOTE: do not write the glob form of that path here — a bare '/*' reads as
// an unterminated block comment to the source-scanning tests.

interface Employee { id: string; name: string | null; role: string | null; status: string | null; hire_date: string | null; probation_end_date: string | null; store_id: string | null }
interface HostAgg { asp7_n: number; asp7_hits: number; be14_n: number; be14_below: number }
interface LiveSession { host_id: string | null; status: string | null; started_at: string | null; ended_at: string | null }
interface ShiftInstance { id: string; employee_id: string | null; shift_date: string | null; starts_at: string | null; ends_at: string | null; status: string | null; source: string | null }
// The shift shape toTimecardEntry needs, with the nullability the API actually returns. Rows
// missing an identity or a start are dropped below rather than coerced.
type Shift = Partial<TimecardShiftRow> & { id: string; employee_id: string | null; date: string | null; start_time: string | null }
interface DropRow { employee_id: string; drops: number; excused: number; releases: number; claims: number }

const fmtDate = (iso: string | null) => {
  if (!iso) return '—';
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : iso;
};
const fmtDateTime = (iso: string | null) => {
  if (!iso) return '—';
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : iso;
};
const pct = (num: number, den: number) => (den <= 0 ? null : (num / den) * 100);
const fmtPct = (v: number | null) => (v == null ? '—' : `${v.toFixed(0)}%`);
// Hours are NOT computed here. toTimecardEntry is the same derivation the employee timecard uses,
// and it calls paidShiftHours + clockedShiftHours from employees.ts verbatim — so what a manager
// reads on this page is what payroll pays. This page previously subtracted its own wall-clock
// times, which ignored both the punch instants and migration 137's approved_minutes and so
// disagreed with Pay on exactly the time-clock rows a manager comes here to check.
//
// Returns null for a materialized PLAN row (source_rule_id set) — a plan is not worked time — and
// for a row too incomplete to place on the clock.
function timecardRow(s: Shift, team: PayrollTeam) {
  if (!s.employee_id || !s.date || !s.start_time) return null;
  return toTimecardEntry({
    id: s.id,
    employee_id: s.employee_id,
    date: s.date,
    start_time: s.start_time,
    end_time: s.end_time ?? null,
    source: s.source ?? 'manual',
    source_rule_id: s.source_rule_id ?? null,
    confirmed_at: s.confirmed_at ?? null,
    break_minutes: s.break_minutes ?? 0,
    clock_in_at: s.clock_in_at ?? null,
    clock_out_at: s.clock_out_at ?? null,
    auto_closed: s.auto_closed ?? false,
    approved_minutes: s.approved_minutes ?? null,
  }, team);
}

// The one-line status a manager needs: why a row is not simply "done".
function statusOf(e: NonNullable<ReturnType<typeof timecardRow>>): { text: string; tone: string } | null {
  if (e.state === 'in_progress') return { text: 'In progress', tone: 'text-tt-green' };
  if (e.state === 'auto_closed') return { text: 'Auto-closed — verify the clock-out', tone: 'text-tt-yellow' };
  if (e.state === 'awaiting_confirmation') return { text: 'Awaiting approval', tone: 'text-tt-yellow' };
  return e.source === 'manual' ? { text: 'Manager entry', tone: 'text-tt-muted' } : null;
}

type View = 'roster' | 'schedule' | 'performance';

export default function MemberStaffPage() {
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [hosts, setHosts] = useState<Record<string, HostAgg>>({});
  const [sessions, setSessions] = useState<LiveSession[]>([]);
  const [instances, setInstances] = useState<ShiftInstance[]>([]);
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [drops, setDrops] = useState<DropRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [view, setView] = useState<View>('roster');

  useEffect(() => {
    let alive = true; setLoading(true); setErr(null);
    const j = async (u: string) => { const r = await fetch(u); const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || `Failed (${r.status})`); return d; };
    Promise.all([
      j('/api/member/team/roster'),
      j('/api/member/team/host-performance').catch(() => ({ hosts: {} })),
      j('/api/member/team/host-live-hours').catch(() => ({ sessions: [] })),
      j('/api/member/team/shifts').catch(() => ({ shift_instances: [], shifts: [] })),
      j('/api/member/team/attendance').catch(() => ({ drops: [] })),
    ])
      .then(([r, hp, lh, sh, at]) => {
        if (!alive) return;
        setEmployees((r.employees ?? []) as Employee[]);
        setHosts((hp.hosts ?? {}) as Record<string, HostAgg>);
        setSessions((lh.sessions ?? []) as LiveSession[]);
        setInstances((sh.shift_instances ?? []) as ShiftInstance[]);
        setShifts((sh.shifts ?? []) as Shift[]);
        setDrops((at.drops ?? []) as DropRow[]);
      })
      .catch((e) => { if (alive) setErr((e as Error).message); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  const nameById = useMemo(() => { const m = new Map<string, string>(); for (const e of employees) m.set(e.id, e.name ?? e.id); return m; }, [employees]);
  // The payable figure is team-dependent (a stored approved_minutes pays for a live host and is
  // ignored for everyone else), so each row needs its own employee's role — read from the roster
  // this page already loads rather than added to the shifts query.
  const roleById = useMemo(() => { const m = new Map<string, string | null>(); for (const e of employees) m.set(e.id, e.role); return m; }, [employees]);
  // Worked-time rows, newest first. CLOCKED is the attendance record; APPROVED is what payroll
  // pays — after migration 137 they answer different questions (a live host's approved time is
  // normally shorter than their punch), so the table shows both rather than one number that
  // answers neither. Plan rows and unplaceable rows drop out in timecardRow, so the
  // table never counts a schedule projection as attendance. Sorted on the clock-in INSTANT rather
  // than the wall-clock date so an overnight punch sits where it actually happened.
  const timecardRows = useMemo(
    () =>
      shifts
        .map((shift) => ({ shift, entry: timecardRow(shift, payrollTeamOfRole(roleById.get(shift.employee_id ?? '') ?? null)) }))
        .filter((r): r is { shift: Shift; entry: NonNullable<typeof r.entry> } => r.entry != null)
        .sort((a, b) => Date.parse(b.entry.clock_in) - Date.parse(a.entry.clock_in)),
    [shifts, roleById],
  );
  const dropByEmp = useMemo(() => { const m = new Map<string, DropRow>(); for (const d of drops) m.set(d.employee_id, d); return m; }, [drops]);
  const liveHoursByHost = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of sessions) {
      if (!s.host_id || !s.started_at || !s.ended_at) continue;
      const ms = Date.parse(s.ended_at) - Date.parse(s.started_at);
      if (Number.isFinite(ms) && ms > 0) m.set(s.host_id, (m.get(s.host_id) ?? 0) + ms / 3600000);
    }
    return m;
  }, [sessions]);

  return (
    <main className="min-h-screen bg-tt-bg text-tt-text p-6 max-w-4xl mx-auto">
      <MemberNav active="team" />
      <div className="mb-5">
        <h1 className="text-2xl font-bold">Team</h1>
        <p className="mt-1 text-sm text-tt-muted">Roster, schedule, and host performance — read only. No pay.</p>
      </div>

      <div className="flex flex-wrap gap-1 mb-6">
        {(['roster', 'schedule', 'performance'] as const).map((v) => (
          <button key={v} onClick={() => setView(v)}
            className={`px-4 py-1.5 rounded-full text-xs font-medium capitalize transition-all ${view === v ? 'bg-tt-cyan text-black' : 'bg-tt-card-hover text-tt-muted hover:text-tt-text'}`}>
            {v}
          </button>
        ))}
      </div>

      {loading && <div className="text-lg text-tt-muted">Loading…</div>}
      {err && <div className="rounded-xl border-2 border-tt-red/50 bg-tt-red/10 px-4 py-3 text-tt-red font-semibold">{err}</div>}

      {!loading && !err && view === 'roster' && (
        <TableCard cols={['Name', 'Role', 'Status', 'Hired', 'Drops', 'ASP hit', 'Below BE']}>
          {employees.map((e) => {
            const hp = hosts[e.id];
            const d = dropByEmp.get(e.id);
            const asp = hp ? pct(hp.asp7_hits, hp.asp7_n) : null;
            const be = hp ? pct(hp.be14_below, hp.be14_n) : null;
            return (
              <tr key={e.id} className="border-b border-[rgba(255,255,255,0.04)]">
                <td className="px-3 py-2 text-[13px] text-tt-text">{e.name ?? '—'}</td>
                <td className="px-3 py-2 text-[13px] text-tt-muted capitalize">{e.role ?? '—'}</td>
                <td className={`px-3 py-2 text-[13px] ${e.status === 'active' ? 'text-tt-green' : 'text-tt-muted'}`}>{e.status ?? '—'}</td>
                <td className="px-3 py-2 text-[13px] text-tt-muted tabular-nums">{fmtDate(e.hire_date)}</td>
                <td className="px-3 py-2 text-[13px] tabular-nums">{d ? `${d.drops}/${DROP_CAP}${d.excused ? ` · ${d.excused} exc` : ''}` : '—'}</td>
                <td className="px-3 py-2 text-[13px] text-right tabular-nums">{hp && hp.asp7_n > 0 ? <span className={asp != null && asp >= 35 ? 'text-tt-green' : 'text-tt-muted'}>{fmtPct(asp)}</span> : <span className="text-tt-muted">—</span>}</td>
                <td className="px-3 py-2 text-[13px] text-right tabular-nums">{hp && hp.be14_n > 0 ? <span className={be != null && be >= 20 ? 'text-tt-red' : be != null && be >= 12 ? 'text-tt-yellow' : 'text-tt-green'}>{fmtPct(be)}</span> : <span className="text-tt-muted">—</span>}</td>
              </tr>
            );
          })}
          {employees.length === 0 && <tr><td colSpan={7} className="px-3 py-6 text-center text-tt-muted">No employees.</td></tr>}
        </TableCard>
      )}

      {!loading && !err && view === 'schedule' && (
        <div className="space-y-5">
          <Section title="Upcoming shifts">
            <TableCard cols={['Employee', 'Date', 'Time', 'Status']}>
              {instances.map((s) => (
                <tr key={s.id} className="border-b border-[rgba(255,255,255,0.04)]">
                  <td className="px-3 py-2 text-[13px] text-tt-text">{s.employee_id ? nameById.get(s.employee_id) ?? '—' : '—'}</td>
                  <td className="px-3 py-2 text-[13px] text-tt-muted tabular-nums">{fmtDate(s.shift_date)}</td>
                  <td className="px-3 py-2 text-[13px] text-tt-muted tabular-nums">{fmtDateTime(s.starts_at)} → {s.ends_at ? fmtDateTime(s.ends_at) : '—'}</td>
                  <td className="px-3 py-2 text-[13px] text-tt-muted capitalize">{s.status ?? '—'}</td>
                </tr>
              ))}
              {instances.length === 0 && <tr><td colSpan={4} className="px-3 py-6 text-center text-tt-muted">No upcoming shifts.</td></tr>}
            </TableCard>
          </Section>
          <Section title="Recent shifts (hours)">
            <TableCard cols={['Employee', 'Date', 'Clock in–out', 'Clocked', 'Approved', 'Status']}>
              {timecardRows.slice(0, 100).map(({ shift, entry }) => {
                const outDay = entry.clock_out ? laDateOf(entry.clock_out) : null;
                const crosses = outDay != null && outDay !== entry.date;
                const status = statusOf(entry);
                return (
                  <tr key={shift.id} className="border-b border-[rgba(255,255,255,0.04)]">
                    <td className="px-3 py-2 text-[13px] text-tt-text">{shift.employee_id ? nameById.get(shift.employee_id) ?? '—' : '—'}</td>
                    <td className="px-3 py-2 text-[13px] text-tt-muted tabular-nums">{fmtDate(entry.date)}</td>
                    <td className="px-3 py-2 text-[13px] text-tt-muted tabular-nums">
                      {fmtTimeLA(entry.clock_in)}–{entry.clock_out ? fmtTimeLA(entry.clock_out) : '—'}
                      {crosses && <span className="ml-1 text-[11px] font-medium text-tt-muted">{dowShort(outDay as string)}</span>}
                    </td>
                    <td className="px-3 py-2 text-[13px] text-right text-tt-muted tabular-nums">{entry.clock_out ? fmtDuration(entry.clocked_hours) : '—'}</td>
                    <td className="px-3 py-2 text-[13px] text-right tabular-nums">
                      {entry.clock_out == null ? '—' : entry.payable ? fmtDuration(entry.hours) : <span className="text-tt-yellow">—</span>}
                    </td>
                    <td className={`px-3 py-2 text-[12px] font-medium ${status?.tone ?? 'text-tt-muted'}`}>{status?.text ?? '—'}</td>
                  </tr>
                );
              })}
              {timecardRows.length === 0 && <tr><td colSpan={6} className="px-3 py-6 text-center text-tt-muted">No shifts.</td></tr>}
            </TableCard>
          </Section>
        </div>
      )}

      {!loading && !err && view === 'performance' && (
        <TableCard cols={['Host', 'ASP hit rate (7d)', 'Below break-even (14d)', 'Live hours']}>
          {Object.entries(hosts).map(([hostId, hp]) => {
            const asp = pct(hp.asp7_hits, hp.asp7_n);
            const be = pct(hp.be14_below, hp.be14_n);
            const hours = liveHoursByHost.get(hostId) ?? 0;
            return (
              <tr key={hostId} className="border-b border-[rgba(255,255,255,0.04)]">
                <td className="px-3 py-2 text-[13px] text-tt-text">{nameById.get(hostId) ?? hostId}</td>
                <td className="px-3 py-2 text-[13px] text-right tabular-nums">{hp.asp7_n > 0 ? `${fmtPct(asp)} (${hp.asp7_hits}/${hp.asp7_n})` : '—'}</td>
                <td className="px-3 py-2 text-[13px] text-right tabular-nums">{hp.be14_n > 0 ? `${fmtPct(be)} (${hp.be14_below}/${hp.be14_n})` : '—'}</td>
                <td className="px-3 py-2 text-[13px] text-right tabular-nums">{hours > 0 ? `${hours.toFixed(1)}h` : '—'}</td>
              </tr>
            );
          })}
          {Object.keys(hosts).length === 0 && <tr><td colSpan={4} className="px-3 py-6 text-center text-tt-muted">No attributed auctions yet.</td></tr>}
        </TableCard>
      )}
    </main>
  );
}

function TableCard({ cols, children }: { cols: string[]; children: React.ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-2xl border border-tt-border bg-tt-card">
      <table className="w-full border-collapse">
        <thead>
          <tr className="border-b border-tt-border">
            {cols.map((c, i) => (
              <th key={c} className={`px-3 py-2 text-[11px] text-tt-muted uppercase tracking-wide ${i === 0 ? 'text-left' : 'text-left'}`}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-tt-muted mb-2">{title}</div>
      {children}
    </div>
  );
}
