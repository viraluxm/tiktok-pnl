'use client';

import { useState } from 'react';
import type { Employee } from '@/types';
import WeeklyShiftView from './WeeklyShiftView';
import MonthlyShiftCalendar from './MonthlyShiftCalendar';

// The Shifts → Calendar view: a Week / Month toggle over the two interactive calendars.
// Week = the detailed employee grid (unchanged); Month = the role-organized month calendar.
export default function CalendarView({ employees }: { employees: Employee[] }) {
  const [mode, setMode] = useState<'week' | 'month'>('week');
  return (
    <div className="space-y-4">
      <div className="flex justify-center">
        <div className="flex gap-1 bg-white/5 rounded-lg p-0.5" role="group" aria-label="Calendar view mode">
          {(['week', 'month'] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              aria-pressed={mode === m}
              className={`px-4 py-1.5 rounded-md text-xs font-semibold transition-colors ${
                mode === m ? 'bg-white/10 text-tt-text' : 'text-tt-muted hover:text-tt-text'
              }`}
            >
              {m === 'week' ? 'Week' : 'Month'}
            </button>
          ))}
        </div>
      </div>

      {mode === 'week' ? <WeeklyShiftView employees={employees} /> : <MonthlyShiftCalendar employees={employees} />}
    </div>
  );
}
