'use client';

import ShiftCard from './ShiftCard';
import { isProbation, type RoleGroupKey, type WeekCell, type WeekEmployeeModel, type WeekShiftCard } from '@/lib/weeklySchedule';

// A single day cell: stacked shift cards + an add affordance. Reused by the desktop grid
// row and the mobile day view.
export function DayCell({
  cell,
  roleKey,
  onAdd,
  onOpenCard,
}: {
  cell: WeekCell;
  roleKey: RoleGroupKey;
  onAdd: () => void;
  onOpenCard: (card: WeekShiftCard) => void;
}) {
  const hasCards = cell.cards.length > 0;
  return (
    <div className="min-h-[64px] p-1 flex flex-col gap-1">
      {cell.hasOverlap && (
        <span className="self-start text-[9px] font-semibold px-1.5 py-0.5 rounded bg-tt-red/15 text-tt-red" title="Two shifts overlap in time">
          ⚠ Overlap
        </span>
      )}
      {cell.cards.map((card) => (
        <ShiftCard key={card.id} card={card} roleKey={roleKey} onClick={() => onOpenCard(card)} />
      ))}
      {hasCards ? (
        <button
          type="button"
          onClick={onAdd}
          aria-label="Add another shift"
          className="mt-0.5 w-full text-[11px] text-tt-muted hover:text-tt-text rounded-md border border-dashed border-tt-border hover:border-tt-border-hover py-1 transition-colors"
        >
          + Add
        </button>
      ) : (
        <button
          type="button"
          onClick={onAdd}
          aria-label="Add a shift"
          className="flex-1 min-h-[52px] w-full rounded-md border border-dashed border-tt-border/60 text-tt-muted/60 hover:text-tt-text hover:border-tt-border-hover hover:bg-white/5 text-lg leading-none transition-colors"
        >
          +
        </button>
      )}
    </div>
  );
}

// Desktop grid row for one employee: name + 7 day cells + weekly total.
export default function WeeklyEmployeeRow({
  model,
  roleKey,
  onAddCell,
  onOpenCard,
}: {
  model: WeekEmployeeModel;
  roleKey: RoleGroupKey;
  onAddCell: (employeeId: string, date: string) => void;
  onOpenCard: (card: WeekShiftCard) => void;
}) {
  const { employee, cells, totalHours } = model;
  return (
    <div
      className="grid border-b border-[rgba(255,255,255,0.04)]"
      style={{ gridTemplateColumns: '160px repeat(7, minmax(120px, 1fr))' }}
    >
      <div className="px-3 py-2 flex flex-col justify-center border-r border-tt-border sticky left-0 bg-tt-card z-10">
        <div className="flex items-center gap-1.5">
          <span className="text-[13px] text-tt-text font-medium truncate">{employee.name}</span>
          {isProbation(employee) && (
            <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded bg-tt-yellow/15 text-tt-yellow shrink-0" title="On probation">
              Probation
            </span>
          )}
        </div>
        <span className="text-[11px] text-tt-muted tabular-nums mt-0.5">{totalHours.toFixed(2)} h</span>
      </div>
      {cells.map((cell) => (
        <div key={cell.date} className="border-r border-[rgba(255,255,255,0.04)] last:border-r-0">
          <DayCell cell={cell} roleKey={roleKey} onAdd={() => onAddCell(employee.id, cell.date)} onOpenCard={onOpenCard} />
        </div>
      ))}
    </div>
  );
}
