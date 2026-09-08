'use client';

import type { Employee } from '@/types';
import { titleCase } from './shared';
import PersonAvatar from './weekly/PersonAvatar';

// Pay as person tiles. The number is the thing you are here to read, so it is the largest text on
// the tile; hours sit under it as the working that produced it, and the scheduled figure is
// smaller still — it is context, and it is NOT what anyone is paid.

export interface PayTile {
  employee: Employee;
  hours: number;
  pay: number;
  scheduled: number;
  /** Records in this period that need a manager's eye. 0 = nothing to look at. */
  reviewCount: number;
}

export default function PayGrid({
  rows, fmt, fmtHours, emptyMessage, onOpen,
}: {
  rows: PayTile[];
  fmt: (n: number) => string;
  fmtHours: (n: number) => string;
  emptyMessage: string;
  /** Opens this person's Pay Details. */
  onOpen: (tile: PayTile) => void;
}) {
  if (rows.length === 0) {
    return <div className="px-5 py-12 text-center text-sm text-tt-muted">{emptyMessage}</div>;
  }

  return (
    <div className="grid grid-cols-2 gap-2.5 p-5 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
      {rows.map((tile) => {
        const { employee, hours, pay, scheduled, reviewCount } = tile;
        const unpaid = pay === 0;
        return (
          <button
            key={employee.id}
            type="button"
            onClick={() => onOpen(tile)}
            aria-label={`Pay details for ${employee.name}`}
            className={`relative flex flex-col items-center rounded-xl border border-tt-border bg-white/[0.02] p-3 text-center transition-colors hover:border-tt-cyan/40 hover:bg-tt-card-hover ${unpaid ? 'opacity-55' : ''}`}
          >
            {/* The count is the point of the badge, but colour alone is not the signal — the tile
                also reads out in its aria-label above. */}
            {reviewCount > 0 && (
              <span
                title={`${reviewCount} ${reviewCount === 1 ? 'record needs' : 'records need'} review`}
                className="absolute right-2 top-2 rounded-md bg-tt-yellow/15 px-1.5 py-0.5 text-[9.5px] font-bold tabular-nums text-tt-yellow"
              >
                {reviewCount}
              </span>
            )}
            <PersonAvatar name={employee.name} state="confirmed" size="lg" />
            <span className="mt-2 w-full truncate text-[13px] font-semibold text-tt-text" title={employee.name}>
              {employee.name}
            </span>
            <span className="text-[10px] text-tt-muted">{titleCase(employee.role)}</span>

            {/* The headline. */}
            <span className={`mt-2 text-xl font-bold tabular-nums ${unpaid ? 'text-tt-muted' : 'text-tt-green'}`}>
              {fmt(pay)}
            </span>

            <span className="mt-0.5 text-[11px] tabular-nums text-tt-text">{fmtHours(hours)} paid</span>
            <span className="text-[10px] tabular-nums text-tt-muted">
              {scheduled > 0 ? `${fmtHours(scheduled)} scheduled` : 'no schedule'}
            </span>
            <span className="mt-1 text-[9.5px] tabular-nums text-tt-muted/60">{fmt(employee.hourly_rate)}/hr</span>
            <span className="mt-1.5 text-[10px] font-semibold text-tt-cyan">View pay details</span>
          </button>
        );
      })}
    </div>
  );
}
