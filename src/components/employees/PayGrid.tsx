'use client';

import type { Employee } from '@/types';
import { titleCase } from './shared';
import PersonAvatar from './weekly/PersonAvatar';

// Pay as person tiles. The number is the thing you are here to read, so it is the largest text on
// the tile; hours sit under it as the working that produced it, and the scheduled figure is
// smaller still — it is context, and it is NOT what anyone is paid.
//
// THE HEADLINE IS TOTAL OWED, which is worked pay plus any bonus. A tile that showed worked pay
// while Pay Details showed a larger total would be the worst of both: two numbers for one cheque,
// and the smaller one on the screen a manager actually pays from. When someone has no bonus,
// `totalOwed` IS `pay` and the tile is exactly the tile it always was.
//
// THIS FILE COMPUTES NEITHER FIGURE. Both arrive already worked out by the Pay tab: the period's
// payroll total for this person, added to their bonus by totalOwedOf() in the statement model —
// the same function buildPayStatement uses, so a tile and a Pay Details panel cannot disagree.

export interface PayTile {
  employee: Employee;
  hours: number;
  /** Bonus pay for this person in this period. 0 when there is none. */
  bonusTotal: number;
  /** Worked pay + bonusTotal, already added by totalOwedOf(). The headline figure. */
  totalOwed: number;
  scheduled: number;
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
        const { employee, hours, bonusTotal, totalOwed, scheduled } = tile;
        const unpaid = totalOwed === 0;
        return (
          <button
            key={employee.id}
            type="button"
            onClick={() => onOpen(tile)}
            aria-label={`Pay details for ${employee.name}`}
            className={`flex flex-col items-center rounded-xl border border-tt-border bg-white/[0.02] p-3 text-center transition-colors hover:border-tt-cyan/40 hover:bg-tt-card-hover ${unpaid ? 'opacity-55' : ''}`}
          >
            <PersonAvatar name={employee.name} state="confirmed" size="lg" />
            <span className="mt-2 w-full truncate text-[13px] font-semibold text-tt-text" title={employee.name}>
              {employee.name}
            </span>
            <span className="text-[10px] text-tt-muted">{titleCase(employee.role)}</span>

            {/* The headline. */}
            <span className={`mt-2 text-xl font-bold tabular-nums ${unpaid ? 'text-tt-muted' : 'text-tt-green'}`}>
              {fmt(totalOwed)}
            </span>

            {/* One quiet line, only when there is a bonus, so the headline is never a number the
                manager cannot account for. Absent otherwise — the grid does not change shape. */}
            {bonusTotal > 0 && (
              <span className="mt-0.5 text-[10px] tabular-nums text-tt-cyan">
                incl. {fmt(bonusTotal)} bonus
              </span>
            )}

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
