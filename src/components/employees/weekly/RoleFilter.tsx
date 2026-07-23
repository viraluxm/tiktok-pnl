'use client';

import type { RoleFilterValue } from '@/lib/weeklySchedule';

const OPTIONS: { value: RoleFilterValue; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'host', label: 'Live Hosts' },
  { value: 'fulfillment', label: 'Fulfillment' },
];

// Segmented All / Live Hosts / Fulfillment filter, matching the app's existing pill toggles.
export default function RoleFilter({
  value,
  onChange,
}: {
  value: RoleFilterValue;
  onChange: (v: RoleFilterValue) => void;
}) {
  return (
    <div className="flex gap-1 bg-white/5 rounded-lg p-0.5" role="group" aria-label="Filter by role">
      {OPTIONS.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          aria-pressed={value === o.value}
          className={`px-3 py-1.5 rounded-md text-xs font-semibold transition-colors ${
            value === o.value ? 'bg-white/10 text-tt-text' : 'text-tt-muted hover:text-tt-text'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
