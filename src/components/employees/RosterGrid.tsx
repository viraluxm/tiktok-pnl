'use client';

import { useMemo } from 'react';
import type { Employee } from '@/types';
import { titleCase } from './shared';
import PersonAvatar from './weekly/PersonAvatar';

// The roster as a grid of people rather than a nine-column table. At 41 employees the table
// needed horizontal scrolling and wrapped its headers onto three lines; the details it carried
// are per-person facts, not things you scan across rows, so they moved into the detail overlay.
//
// Grouped by role because "who are my hosts" and "who is on fulfillment" is the question the
// roster is usually opened to answer.

// Status is carried by a dot AND by dimming, never by colour alone.
function statusDot(status: string): string {
  return status === 'active' ? 'bg-tt-green'
    : status === 'probation' ? 'bg-tt-yellow'
      : 'bg-tt-muted';
}

export default function RosterGrid({
  employees,
  isLoading,
  onOpen,
}: {
  employees: Employee[];
  isLoading: boolean;
  onOpen: (e: Employee) => void;
}) {
  const groups = useMemo(() => {
    const key = (e: Employee) => (e.role ?? '').trim().toLowerCase();
    const out: { label: string; list: Employee[] }[] = [];
    for (const [k, label] of [['host', 'Live Hosts'], ['fulfillment', 'Fulfillment']] as const) {
      const list = employees.filter((e) => key(e) === k);
      if (list.length) out.push({ label, list });
    }
    const rest = employees.filter((e) => !['host', 'fulfillment'].includes(key(e)));
    if (rest.length) out.push({ label: 'Other', list: rest });
    return out;
  }, [employees]);

  if (employees.length === 0) {
    return (
      <div className="px-5 py-12 text-center text-sm text-tt-muted">
        {isLoading ? 'Loading…' : 'No employees yet — add your first team member'}
      </div>
    );
  }

  return (
    <div className="space-y-5 p-5">
      {groups.map((g) => (
        <div key={g.label}>
          <div className="mb-2 flex items-baseline gap-2">
            <span className="text-[10px] font-bold uppercase tracking-wider text-tt-muted">{g.label}</span>
            <span className="text-[10px] tabular-nums text-tt-muted/60">{g.list.length}</span>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
            {g.list.map((e) => (
              <button
                key={e.id}
                type="button"
                onClick={() => onOpen(e)}
                title={`${e.name} — ${titleCase(e.role)}`}
                className={`flex flex-col items-center rounded-xl border border-tt-border bg-white/[0.02] p-3 text-center transition-colors hover:border-tt-cyan/40 hover:bg-tt-card-hover ${
                  e.status === 'former' ? 'opacity-50' : ''
                }`}
              >
                <PersonAvatar name={e.name} state="confirmed" size="lg" />
                <span className="mt-2 w-full truncate text-[13px] font-semibold text-tt-text">{e.name}</span>
                <span className="mt-0.5 flex items-center gap-1 text-[10px] text-tt-muted">
                  <span className={`inline-block h-1.5 w-1.5 rounded-full ${statusDot(e.status)}`} aria-hidden />
                  {e.status === 'active' ? titleCase(e.role) : titleCase(e.status)}
                </span>
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
