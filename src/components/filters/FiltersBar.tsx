'use client';

import type { FilterState } from '@/types';
import DatePicker from './DatePicker';

interface FiltersBarProps {
  filters: FilterState;
  onQuickFilter: (days: number | 'all') => void;
  onDateFromChange: (date: string | null) => void;
  onDateToChange: (date: string | null) => void;
  activeQuickFilter: number | 'all' | 'custom';
}

export default function FiltersBar({
  filters,
  onQuickFilter,
  onDateFromChange,
  onDateToChange,
  activeQuickFilter,
}: FiltersBarProps) {
  const quickFilters: Array<{ label: string; value: number | 'all' }> = [
    { label: 'Today', value: 0 },
    { label: 'Yesterday', value: 1 },
    { label: '7 Days', value: 7 },
    { label: '30 Days', value: 30 },
    // Lifetime = no lower bound (earliest data → now). Reuses the existing 'all'
    // path in useFilters, which clears dateFrom/dateTo (unbounded).
    { label: 'Lifetime', value: 'all' },
  ];

  return (
    <div className="flex items-center gap-3 md:gap-4 mb-4 md:mb-8 flex-wrap">
      <div className="flex items-center gap-2 min-w-0">
        <label className="text-[13px] text-tt-muted font-medium">Period:</label>
        <div className="flex flex-wrap gap-1.5">
          {quickFilters.map((f) => (
            <button
              key={String(f.value)}
              onClick={() => onQuickFilter(f.value)}
              className={`px-3 py-2 md:py-1.5 rounded-full border text-xs cursor-pointer transition-all ${
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
      <DatePicker
        dateFrom={filters.dateFrom}
        dateTo={filters.dateTo}
        onDateFromChange={onDateFromChange}
        onDateToChange={onDateToChange}
      />
    </div>
  );
}
