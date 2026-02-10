'use client';

import type { FilterState } from '@/types';

interface FiltersBarProps {
  filters: FilterState;
  onQuickFilter: (days: number | 'all') => void;
  onDateFromChange: (date: string | null) => void;
  onDateToChange: (date: string | null) => void;
  activeQuickFilter: number | 'all';
}

export default function FiltersBar({
  filters,
  onQuickFilter,
  onDateFromChange,
  onDateToChange,
  activeQuickFilter,
}: FiltersBarProps) {
  const quickFilters: Array<{ label: string; value: number | 'all' }> = [
    { label: '7 Days', value: 7 },
    { label: '30 Days', value: 30 },
    { label: 'All Time', value: 'all' },
  ];

  return (
    <div className="flex items-center gap-3 mb-6 flex-wrap">
      <div className="flex items-center gap-2">
        <label className="text-[13px] text-tt-muted font-medium">Period:</label>
        <div className="flex gap-1">
          {quickFilters.map((f) => (
            <button
              key={f.value}
              onClick={() => onQuickFilter(f.value)}
              className={`px-3 py-1.5 rounded-full border text-xs cursor-pointer transition-all ${
                activeQuickFilter === f.value
                  ? 'bg-tt-cyan text-black border-tt-cyan font-semibold'
                  : 'border-tt-border text-tt-muted hover:bg-tt-cyan hover:text-black hover:border-tt-cyan'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>
      <div className="flex items-center gap-2">
        <label className="text-[13px] text-tt-muted font-medium">From:</label>
        <input
          type="date"
          value={filters.dateFrom || ''}
          onChange={(e) => onDateFromChange(e.target.value || null)}
          className="bg-tt-input-bg border border-tt-input-border text-tt-text px-2.5 py-1.5 rounded-lg text-[13px] focus:outline-none focus:border-tt-cyan"
        />
      </div>
      <div className="flex items-center gap-2">
        <label className="text-[13px] text-tt-muted font-medium">To:</label>
        <input
          type="date"
          value={filters.dateTo || ''}
          onChange={(e) => onDateToChange(e.target.value || null)}
          className="bg-tt-input-bg border border-tt-input-border text-tt-text px-2.5 py-1.5 rounded-lg text-[13px] focus:outline-none focus:border-tt-cyan"
        />
      </div>
    </div>
  );
}
