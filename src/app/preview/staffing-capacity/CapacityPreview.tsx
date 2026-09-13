'use client';

import { useMemo, useState } from 'react';
import StaffingCapacityPanel from '@/components/employees/StaffingCapacityPanel';
import ShiftRequestsPanel, { type ShiftRequestRow } from '@/components/employees/ShiftRequestsPanel';
import { laTodayISO } from '@/lib/schedule/timezone';
import { fmtCalendarDate, fmtTimeRangeLA } from '@/lib/schedule/format';
import { staffedOfLabel, staffingLabel } from '@/lib/schedule/capacity';
import { applyMutation, initialWorld, payloadFor, type Mutate, type PreviewWorld } from './fixtures';

// The interactive half of /preview/staffing-capacity. ZERO NETWORK: the panel is rendered with its
// preview props, so its React Query call is disabled and every edit is a pure world transition.

const REQUESTERS = ['Juan Perez', 'Adriana Cole'];

export default function CapacityPreview() {
  const today = laTodayISO();
  const [world, setWorld] = useState<PreviewWorld>(() => initialWorld(today));
  const [decided, setDecided] = useState<Set<string>>(new Set());
  const data = useMemo(() => payloadFor(world, today), [world, today]);
  const hostCapacity = data.teamDefaults.find((t) => t.team === 'host')?.capacity ?? null;

  // The two pending requests point at the first two nights that still have room, so approving one
  // in the preview visibly drops that block's availability by one.
  const openNights = data.days.flatMap((d) => d.blocks).filter((s) => s.available > 0);
  const requests: ShiftRequestRow[] = REQUESTERS.flatMap((name, i) => {
    const s = openNights[i] ?? openNights[0];
    const id = `r${i + 1}`;
    if (!s || decided.has(id)) return [];
    return [{
      request_id: id, employee_name: name, team: 'host',
      // The label comes from the block the request actually points at, not a fixed string.
      block_label: s.label,
      shift_date: s.date, starts_at: s.starts_at, ends_at: s.ends_at,
      staffed: s.staffed, capacity: s.capacity, available: s.available, closed: s.closed,
    }];
  });

  const headline = data.days.flatMap((d) => d.blocks).slice(0, 8);

  return (
    <div className="min-h-dvh bg-tt-bg text-tt-text">
      <div className="sticky top-0 z-50 border-b border-tt-border bg-[rgba(15,15,15,0.95)] px-3 py-2 backdrop-blur-xl">
        <div className="mx-auto flex max-w-4xl flex-wrap items-center gap-2">
          <span className="mr-1 text-[10px] font-bold uppercase tracking-wider text-tt-magenta">Preview</span>
          <span className="text-[11px] text-tt-muted">Manager · Staffing capacity</span>
          {/* Both states of the thing under review, one click apart. */}
          <button
            type="button"
            onClick={() => setWorld((w) => applyMutation(w, { op: 'teamCapacity', team: 'host', capacity: hostCapacity == null ? 10 : null }))}
            className="ml-auto rounded-full bg-white/[0.06] px-3 py-1.5 text-xs font-semibold text-tt-text transition-colors hover:bg-white/10"
          >{hostCapacity == null ? 'Set Live Host capacity to 10' : 'Clear Live Host capacity'}</button>
          <button
            type="button" onClick={() => { setWorld(initialWorld(today)); setDecided(new Set()); }}
            className="rounded-full bg-white/[0.06] px-3 py-1.5 text-xs font-semibold text-tt-muted transition-colors hover:bg-white/10 hover:text-tt-text"
          >Reset</button>
        </div>
      </div>

      <main className="mx-auto max-w-3xl space-y-4 px-4 py-6">
        <div>
          <h1 className="text-xl font-semibold">Staffing capacity</h1>
          <p className="mt-1 text-sm text-tt-muted">
            The real <code className="text-tt-text">StaffingCapacityPanel</code> and{' '}
            <code className="text-tt-text">ShiftRequestsPanel</code> the Team → Shifts tab mounts, driven by an
            in-memory world. Ten Live Host setups, the scenarios the feature has to get right.
          </p>
        </div>

        {/* A flat read of what the panel is showing, so the numbers can be checked at a glance. */}
        <div className="overflow-x-auto rounded-[14px] border border-tt-border bg-tt-card/60">
          <table className="w-full min-w-[420px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-tt-border text-left text-[11px] uppercase tracking-wide text-tt-muted">
                <th className="px-4 py-2 font-medium">Day</th>
                <th className="px-4 py-2 font-medium">Block</th>
                <th className="px-4 py-2 font-medium">Scheduled</th>
                <th className="px-4 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {headline.map((s) => (
                <tr key={`${s.block_id}|${s.date}`} className="border-b border-[rgba(255,255,255,0.04)]">
                  <td className="whitespace-nowrap px-4 py-2 text-tt-muted">{fmtCalendarDate(s.date)}</td>
                  <td className="whitespace-nowrap px-4 py-2 tabular-nums text-tt-text">{fmtTimeRangeLA(s.starts_at, s.ends_at)}</td>
                  <td className="whitespace-nowrap px-4 py-2 tabular-nums text-tt-text">{staffedOfLabel(s)}</td>
                  <td className="whitespace-nowrap px-4 py-2 text-tt-text">
                    {staffingLabel(s)}{s.custom ? <span className="ml-2 text-tt-muted">Custom capacity</span> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <ShiftRequestsPanel
          previewRequests={requests}
          onPreviewAct={(id) => setDecided((prev) => new Set(prev).add(id))}
        />

        <StaffingCapacityPanel
          previewData={data}
          onPreviewMutate={(m: Mutate) => setWorld((w) => applyMutation(w, m))}
        />
      </main>
    </div>
  );
}
