'use client';

import {
  formatTimeRange12,
  groupDayEntriesByRole,
  isProbation,
  parseYMD,
  type DayEntry,
  type RoleGroupKey,
  type WeekShiftCard,
} from '@/lib/weeklySchedule';

function roleText(key: RoleGroupKey): string {
  return key === 'host' ? 'text-tt-cyan' : key === 'fulfillment' ? 'text-tt-magenta-soft' : 'text-tt-muted';
}
function roleDot(key: RoleGroupKey): string {
  return key === 'host' ? 'bg-tt-cyan' : key === 'fulfillment' ? 'bg-tt-magenta-soft' : 'bg-tt-muted';
}

function longDate(iso: string): string {
  return parseYMD(iso).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

// Day-detail panel: every shift for a day, grouped by role, each clickable to open the
// shift actions. Also offers Add Shift for the day. Probation badges appear here (not in
// the compact month cell).
export default function DayShiftDetailsModal({
  date,
  entries,
  onClose,
  onAddDay,
  onOpenCard,
}: {
  date: string;
  entries: DayEntry[];
  onClose: () => void;
  onAddDay: (date: string) => void;
  onOpenCard: (card: WeekShiftCard) => void;
}) {
  const groups = groupDayEntriesByRole(entries);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-tt-card border border-tt-border rounded-2xl p-6 w-full max-w-md mx-4 shadow-2xl max-h-[80vh] overflow-y-auto" role="dialog" aria-modal="true">
        <div className="flex items-start justify-between mb-4">
          <h3 className="text-base font-semibold text-tt-text">{longDate(date)}</h3>
          <button onClick={onClose} aria-label="Close" className="text-tt-muted hover:text-tt-text transition-colors p-1">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {groups.length === 0 ? (
          <p className="text-sm text-tt-muted py-4">No shifts scheduled.</p>
        ) : (
          <div className="space-y-4">
            {groups.map((g) => (
              <div key={g.key}>
                <div className={`text-[11px] font-bold uppercase tracking-wide mb-2 flex items-center gap-1.5 ${roleText(g.key)}`}>
                  <span className={`inline-block w-2 h-2 rounded-full ${roleDot(g.key)}`} aria-hidden />
                  {g.label}
                </div>
                <div className="space-y-1.5">
                  {g.entries.map(({ employee, card }) => (
                    <button
                      key={card.id}
                      type="button"
                      onClick={() => onOpenCard(card)}
                      className="w-full flex items-center justify-between gap-3 px-3 py-2 rounded-lg bg-white/5 hover:bg-white/10 transition-colors text-left"
                    >
                      <span className="flex items-center gap-2 min-w-0">
                        <span className="text-[13px] text-tt-text truncate">{employee.name}</span>
                        {isProbation(employee) && (
                          <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded bg-tt-yellow/15 text-tt-yellow shrink-0">Probation</span>
                        )}
                      </span>
                      <span className="text-[12px] tabular-nums text-tt-muted shrink-0">
                        {formatTimeRange12(card.start_time, card.end_time)}
                        {card.isOvernight && <span title="Overnight — ends next day"> 🌙</span>}
                        {card.isFrozen && <span className="ml-1 text-[9px] px-1 py-0.5 rounded bg-tt-cyan/15 text-tt-cyan">logged</span>}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="pt-5">
          <button
            onClick={() => onAddDay(date)}
            className="w-full py-2.5 rounded-xl text-sm font-semibold bg-tt-cyan text-black hover:bg-tt-cyan/90 transition-colors"
          >
            + Add shift this day
          </button>
        </div>
      </div>
    </div>
  );
}
