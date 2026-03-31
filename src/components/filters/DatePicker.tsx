'use client';

import { useState, useRef, useEffect, useCallback } from 'react';

interface DatePickerProps {
  dateFrom: string | null;
  dateTo: string | null;
  onDateFromChange: (date: string | null) => void;
  onDateToChange: (date: string | null) => void;
}

function toShopDate(d: Date) {
  return d.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
}

function parseDate(str: string): Date {
  const [y, m, d] = str.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function formatDisplay(dateStr: string | null): string {
  if (!dateStr) return '—';
  const d = parseDate(dateStr);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function isSameDay(a: string, b: string) {
  return a === b;
}

const DAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export default function DatePicker({ dateFrom, dateTo, onDateFromChange, onDateToChange }: DatePickerProps) {
  const [open, setOpen] = useState(false);
  const [selecting, setSelecting] = useState<'from' | 'to'>('from');
  const [viewYear, setViewYear] = useState(() => {
    const ref = dateFrom ? parseDate(dateFrom) : new Date();
    return ref.getFullYear();
  });
  const [viewMonth, setViewMonth] = useState(() => {
    const ref = dateFrom ? parseDate(dateFrom) : new Date();
    return ref.getMonth();
  });
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  const prevMonth = useCallback(() => {
    setViewMonth((m) => {
      if (m === 0) { setViewYear((y) => y - 1); return 11; }
      return m - 1;
    });
  }, []);

  const nextMonth = useCallback(() => {
    setViewMonth((m) => {
      if (m === 11) { setViewYear((y) => y + 1); return 0; }
      return m + 1;
    });
  }, []);

  function handleDayClick(dateStr: string) {
    if (selecting === 'from') {
      onDateFromChange(dateStr);
      // If new from is after current to, reset to
      if (dateTo && dateStr > dateTo) {
        onDateToChange(dateStr);
      }
      setSelecting('to');
    } else {
      // If selected to is before from, swap
      if (dateFrom && dateStr < dateFrom) {
        onDateFromChange(dateStr);
        onDateToChange(dateFrom);
      } else {
        onDateToChange(dateStr);
      }
      setSelecting('from');
      setOpen(false);
    }
  }

  // Build calendar grid
  const firstDay = new Date(viewYear, viewMonth, 1).getDay();
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  const daysInPrevMonth = new Date(viewYear, viewMonth, 0).getDate();

  const cells: Array<{ day: number; dateStr: string; isCurrentMonth: boolean }> = [];

  // Previous month fill
  for (let i = firstDay - 1; i >= 0; i--) {
    const d = daysInPrevMonth - i;
    const m = viewMonth === 0 ? 11 : viewMonth - 1;
    const y = viewMonth === 0 ? viewYear - 1 : viewYear;
    cells.push({ day: d, dateStr: `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`, isCurrentMonth: false });
  }

  // Current month
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push({ day: d, dateStr: `${viewYear}-${String(viewMonth + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`, isCurrentMonth: true });
  }

  // Next month fill
  const remaining = 42 - cells.length;
  for (let d = 1; d <= remaining; d++) {
    const m = viewMonth === 11 ? 0 : viewMonth + 1;
    const y = viewMonth === 11 ? viewYear + 1 : viewYear;
    cells.push({ day: d, dateStr: `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`, isCurrentMonth: false });
  }

  const todayStr = toShopDate(new Date());

  function getDayClasses(dateStr: string, isCurrentMonth: boolean) {
    const isFrom = dateFrom && isSameDay(dateStr, dateFrom);
    const isTo = dateTo && isSameDay(dateStr, dateTo);
    const isInRange = dateFrom && dateTo && dateStr > dateFrom && dateStr < dateTo;
    const isToday = isSameDay(dateStr, todayStr);

    let base = 'w-9 h-9 text-[13px] rounded-lg transition-all cursor-pointer flex items-center justify-center relative ';

    if (!isCurrentMonth) {
      base += 'text-tt-muted/40 ';
    }

    if (isFrom || isTo) {
      base += 'bg-tt-cyan text-black font-semibold ';
    } else if (isInRange) {
      base += 'bg-tt-cyan/15 text-tt-cyan ';
    } else if (isToday) {
      base += 'ring-1 ring-tt-cyan/50 text-tt-cyan font-medium ';
    } else if (isCurrentMonth) {
      base += 'text-tt-text hover:bg-white/10 ';
    } else {
      base += 'hover:bg-white/5 ';
    }

    return base;
  }

  const displayLabel = dateFrom && dateTo
    ? isSameDay(dateFrom, dateTo)
      ? formatDisplay(dateFrom)
      : `${formatDisplay(dateFrom)} – ${formatDisplay(dateTo)}`
    : dateFrom
      ? `${formatDisplay(dateFrom)} – ...`
      : 'Select dates';

  return (
    <div className="relative" ref={ref}>
      {/* Trigger button */}
      <button
        onClick={() => { setOpen(!open); setSelecting('from'); }}
        className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-tt-border bg-tt-card text-[13px] text-tt-text hover:border-tt-border-hover transition-all cursor-pointer"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-tt-muted">
          <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
          <line x1="16" y1="2" x2="16" y2="6" />
          <line x1="8" y1="2" x2="8" y2="6" />
          <line x1="3" y1="10" x2="21" y2="10" />
        </svg>
        <span>{displayLabel}</span>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-tt-muted">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {/* Dropdown calendar */}
      {open && (
        <div className="absolute top-full left-0 mt-2 z-50 bg-[#1a1a1a] border border-tt-border rounded-xl shadow-2xl shadow-black/50 p-4 w-[300px] animate-fade-in">
          {/* Selecting indicator */}
          <div className="flex gap-2 mb-3">
            <button
              onClick={() => setSelecting('from')}
              className={`flex-1 text-center py-1.5 rounded-lg text-xs font-medium transition-all ${
                selecting === 'from' ? 'bg-tt-cyan/15 text-tt-cyan border border-tt-cyan/30' : 'text-tt-muted border border-transparent hover:text-tt-text'
              }`}
            >
              {dateFrom ? formatDisplay(dateFrom) : 'Start date'}
            </button>
            <span className="text-tt-muted self-center text-xs">→</span>
            <button
              onClick={() => setSelecting('to')}
              className={`flex-1 text-center py-1.5 rounded-lg text-xs font-medium transition-all ${
                selecting === 'to' ? 'bg-tt-cyan/15 text-tt-cyan border border-tt-cyan/30' : 'text-tt-muted border border-transparent hover:text-tt-text'
              }`}
            >
              {dateTo ? formatDisplay(dateTo) : 'End date'}
            </button>
          </div>

          {/* Month/year nav */}
          <div className="flex items-center justify-between mb-3">
            <button onClick={prevMonth} className="w-8 h-8 flex items-center justify-center rounded-lg text-tt-muted hover:bg-white/10 hover:text-tt-text transition-all cursor-pointer">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="15 18 9 12 15 6" /></svg>
            </button>
            <span className="text-[13px] font-semibold text-tt-text">
              {MONTHS[viewMonth]} {viewYear}
            </span>
            <button onClick={nextMonth} className="w-8 h-8 flex items-center justify-center rounded-lg text-tt-muted hover:bg-white/10 hover:text-tt-text transition-all cursor-pointer">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="9 18 15 12 9 6" /></svg>
            </button>
          </div>

          {/* Day headers */}
          <div className="grid grid-cols-7 mb-1">
            {DAYS.map((d) => (
              <div key={d} className="w-9 h-7 flex items-center justify-center text-[11px] text-tt-muted font-medium">
                {d}
              </div>
            ))}
          </div>

          {/* Day grid */}
          <div className="grid grid-cols-7">
            {cells.map((cell, i) => (
              <button
                key={i}
                onClick={() => handleDayClick(cell.dateStr)}
                className={getDayClasses(cell.dateStr, cell.isCurrentMonth)}
              >
                {cell.day}
              </button>
            ))}
          </div>

          {/* Footer */}
          <div className="flex justify-between mt-3 pt-3 border-t border-tt-border">
            <button
              onClick={() => {
                onDateFromChange(null);
                onDateToChange(null);
                setOpen(false);
              }}
              className="text-xs text-tt-muted hover:text-tt-red transition-colors cursor-pointer"
            >
              Clear
            </button>
            <button
              onClick={() => {
                const t = toShopDate(new Date());
                onDateFromChange(t);
                onDateToChange(t);
                setOpen(false);
              }}
              className="text-xs text-tt-cyan hover:text-tt-cyan/80 transition-colors cursor-pointer"
            >
              Today
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
