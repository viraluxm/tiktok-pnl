'use client';

import type { FilterState } from '@/types';
import DatePicker from './DatePicker';

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
    { label: 'Today', value: 0 },
    { label: 'Yesterday', value: 1 },
    { label: '7 Days', value: 7 },
    { label: '30 Days', value: 30 },
  ];

  return (
    <div className="flex items-center gap-4 mb-8 flex-wrap">
      <div className="flex items-center gap-2">
        <label className="text-[13px] text-tt-muted font-medium">Period:</label>
        <div className="flex gap-1">
          {quickFilters.map((f) => (
            <button
              key={String(f.value)}
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
      <DatePicker
        dateFrom={filters.dateFrom}
        dateTo={filters.dateTo}
        onDateFromChange={onDateFromChange}
        onDateToChange={onDateToChange}
      />
    </div>
  );
}
