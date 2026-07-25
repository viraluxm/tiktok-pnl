'use client';

import {
  formatTimeRange12,
  groupDayEntriesByRole,
  overflowSplit,
  parseYMD,
  MONTH_CELL_MAX_ENTRIES,
  type DayEntry,
  type RoleGroupKey,
  type WeekShiftCard,
} from '@/lib/weeklySchedule';

// Role treatments. Color is always paired with the group's text heading, so it is never
// the sole identifier. Kept subtle: an accent left-border + a faint tinted block.
function roleText(key: RoleGroupKey): string {
  return key === 'host' ? 'text-tt-cyan' : key === 'fulfillment' ? 'text-tt-magenta-soft' : 'text-tt-muted';
}
function roleDot(key: RoleGroupKey): string {
  return key === 'host' ? 'bg-tt-cyan' : key === 'fulfillment' ? 'bg-tt-magenta-soft' : 'bg-tt-muted';
}
// Section block: accent border + faint tint, distinct per role but not heavy.
function roleBlock(key: RoleGroupKey): string {
  return key === 'host'
    ? 'border-l-tt-cyan/70 bg-tt-cyan/[0.06]'
    : key === 'fulfillment'
      ? 'border-l-tt-magenta-soft/70 bg-tt-magenta-soft/[0.06]'
      : 'border-l-tt-muted/60 bg-white/[0.04]';
}

function dayNum(iso: string): number {
  return parseYMD(iso).getUTCDate();
}

// One month-grid day cell. Empty-space click → Add Shift (date preselected); the day
// number and "+N more" → day-detail modal; an entry → that shift's actions.
export default function MonthlyDayCell({
  date,
  inMonth,
  isToday,
  entries,
  onAddDay,
  onOpenDay,
  onOpenCard,
}: {
  date: string;
  inMonth: boolean;
  isToday: boolean;
  entries: DayEntry[];
  onAddDay: (date: string) => void;
  onOpenDay: (date: string) => void;
  onOpenCard: (card: WeekShiftCard) => void;
}) {
  const { visible, more } = overflowSplit(entries.length, MONTH_CELL_MAX_ENTRIES);
  const shown = entries.slice(0, visible);
  const groups = groupDayEntriesByRole(shown);

  return (
    <div
      onClick={() => onAddDay(date)}
      title="Click to add a shift"
      className={`min-h-[116px] p-2 flex flex-col gap-1.5 text-left align-top border-r border-b border-[rgba(255,255,255,0.04)] cursor-pointer transition-colors hover:bg-white/[0.03] ${
        inMonth ? '' : 'bg-black/20'
      }`}
    >
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onOpenDay(date); }}
          className={`text-[11px] tabular-nums rounded px-1 leading-5 min-w-5 text-center transition-colors ${
            isToday
              ? 'bg-tt-cyan text-black font-bold'
              : inMonth
                ? 'text-tt-text hover:bg-white/10'
                : 'text-tt-muted/60 hover:bg-white/10'
          }`}
          aria-label={`View ${date}`}
        >
          {dayNum(date)}
        </button>
      </div>

      <div className="flex flex-col gap-1.5 overflow-hidden">
        {groups.map((g) => (
          <div key={g.key} className={`rounded-md border-l-2 ${roleBlock(g.key)} pl-1.5 pr-1 py-1`}>
            <div className={`text-[8px] font-bold uppercase tracking-wider ${roleText(g.key)} flex items-center gap-1 mb-1`}>
              <span className={`inline-block w-1.5 h-1.5 rounded-full ${roleDot(g.key)}`} aria-hidden />
              {g.label}
            </div>
            <div className="space-y-1">
              {g.entries.map(({ employee, card }) => (
                <button
                  key={card.id}
                  type="button"
                  onClick={(e) => { e.stopPropagation(); onOpenCard(card); }}
                  title={`${employee.name} · ${formatTimeRange12(card.start_time, card.end_time)}${card.isOvernight ? ' (overnight)' : ''}`}
                  className="group/entry block w-full text-left leading-snug truncate"
                >
                  <span className="text-[10.5px] font-semibold text-tt-text group-hover/entry:text-tt-cyan transition-colors">{employee.name}</span>
                  <span className="text-[9.5px] text-tt-muted"> · {formatTimeRange12(card.start_time, card.end_time)}</span>
                  {card.isOvernight && <span title="Overnight — ends next day"> 🌙</span>}
                  {card.isOpen && <span className="text-[9.5px] text-tt-yellow"> ·open</span>}
                </button>
              ))}
            </div>
          </div>
        ))}

        {more > 0 && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onOpenDay(date); }}
            className="text-[10px] font-semibold text-tt-cyan hover:underline text-left pl-1"
          >
            +{more} more
          </button>
        )}
      </div>
    </div>
  );
}
