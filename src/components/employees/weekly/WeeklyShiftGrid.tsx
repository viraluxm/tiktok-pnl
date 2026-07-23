'use client';

import WeeklyEmployeeRow, { DayCell } from './WeeklyEmployeeRow';
import {
  parseYMD,
  WEEKDAY_LABELS,
  type RoleFilterValue,
  type RoleGroupKey,
  type WeekGroupModel,
  type WeekShiftCard,
} from '@/lib/weeklySchedule';

const GRID_COLS = '160px repeat(7, minmax(120px, 1fr))';

// "6/29"
function mdLabel(iso: string): string {
  const d = parseYMD(iso);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}

// "Monday" for mobile day headers.
const FULL_WEEKDAY = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

function groupHours(group: WeekGroupModel): number {
  return group.employees.reduce((sum, e) => sum + e.totalHours, 0);
}

function GroupDot({ roleKey }: { roleKey: RoleGroupKey }) {
  const c = roleKey === 'host' ? 'bg-tt-cyan' : roleKey === 'fulfillment' ? 'bg-tt-magenta-soft' : 'bg-tt-muted';
  return <span className={`inline-block w-2 h-2 rounded-full ${c}`} aria-hidden />;
}

export default function WeeklyShiftGrid({
  groups,
  weekDates,
  todayISO,
  roleFilter,
  onAddCell,
  onOpenCard,
}: {
  groups: WeekGroupModel[];
  weekDates: string[];
  todayISO: string;
  roleFilter: RoleFilterValue;
  onAddCell: (employeeId: string, date: string) => void;
  onOpenCard: (card: WeekShiftCard) => void;
}) {
  const totalEmployees = groups.reduce((n, g) => n + g.employees.length, 0);
  const grandTotal = groups.reduce((sum, g) => sum + groupHours(g), 0);

  if (totalEmployees === 0) {
    return (
      <div className="bg-tt-card border border-tt-border rounded-[14px] backdrop-blur-xl px-6 py-16 text-center">
        <p className="text-sm text-tt-muted">
          {roleFilter === 'all'
            ? 'No active employees yet — add team members in the Roster tab.'
            : `No ${roleFilter === 'host' ? 'Live Hosts' : 'Fulfillment'} employees. Try the “All” filter or add one in Roster.`}
        </p>
      </div>
    );
  }

  return (
    <div className="bg-tt-card border border-tt-border rounded-[14px] backdrop-blur-xl overflow-hidden">
      {/* ── Desktop / tablet: employee rows × 7 day columns ───────────────────── */}
      <div className="hidden md:block overflow-x-auto">
        <div className="min-w-[900px]">
          {/* Day header */}
          <div className="grid border-b border-tt-border" style={{ gridTemplateColumns: GRID_COLS }}>
            <div className="px-3 py-2 text-[11px] text-tt-muted uppercase tracking-wide font-medium border-r border-tt-border sticky left-0 bg-tt-card z-10">
              Employee
            </div>
            {weekDates.map((iso, i) => {
              const isToday = iso === todayISO;
              return (
                <div
                  key={iso}
                  className={`px-2 py-2 text-center border-r border-[rgba(255,255,255,0.04)] last:border-r-0 ${isToday ? 'bg-tt-cyan/10' : ''}`}
                >
                  <div className={`text-[11px] font-semibold ${isToday ? 'text-tt-cyan' : 'text-tt-text'}`}>{WEEKDAY_LABELS[i]}</div>
                  <div className="text-[10px] text-tt-muted tabular-nums">{mdLabel(iso)}</div>
                </div>
              );
            })}
          </div>

          {groups.map((group) => (
            <div key={group.key}>
              {/* Role heading */}
              <div className="flex items-center justify-between px-3 py-2 bg-white/5 border-b border-tt-border">
                <div className="flex items-center gap-2">
                  <GroupDot roleKey={group.key} />
                  <span className="text-xs font-semibold text-tt-text uppercase tracking-wide">{group.label}</span>
                  <span className="text-[11px] text-tt-muted">({group.employees.length})</span>
                </div>
                <span className="text-[11px] text-tt-muted tabular-nums">{groupHours(group).toFixed(2)} h</span>
              </div>
              {group.employees.length === 0 ? (
                <div className="px-3 py-6 text-center text-xs text-tt-muted border-b border-[rgba(255,255,255,0.04)]">
                  No employees in this group.
                </div>
              ) : (
                group.employees.map((emp) => (
                  <WeeklyEmployeeRow
                    key={emp.employee.id}
                    model={emp}
                    roleKey={group.key}
                    onAddCell={onAddCell}
                    onOpenCard={onOpenCard}
                  />
                ))
              )}
            </div>
          ))}

          {/* Grand total */}
          <div className="grid" style={{ gridTemplateColumns: GRID_COLS }}>
            <div className="px-3 py-2 text-[12px] font-semibold text-tt-text border-r border-tt-border sticky left-0 bg-tt-card z-10">
              Week total
            </div>
            <div className="col-span-7 px-3 py-2 text-right text-[12px] font-semibold text-tt-text tabular-nums">
              {grandTotal.toFixed(2)} h
            </div>
          </div>
        </div>
      </div>

      {/* ── Mobile: day-by-day stacked ───────────────────────────────────────── */}
      <div className="md:hidden divide-y divide-tt-border">
        {weekDates.map((iso, dayIdx) => {
          const isToday = iso === todayISO;
          // Employees (per group) that have a shift this day.
          const dayGroups = groups
            .map((g) => ({
              ...g,
              employees: g.employees.filter((e) => e.cells[dayIdx].cards.length > 0),
            }))
            .filter((g) => g.employees.length > 0);
          return (
            <div key={iso} className="px-4 py-3">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-baseline gap-2">
                  <span className={`text-sm font-semibold ${isToday ? 'text-tt-cyan' : 'text-tt-text'}`}>{FULL_WEEKDAY[dayIdx]}</span>
                  <span className="text-[11px] text-tt-muted tabular-nums">{mdLabel(iso)}</span>
                  {isToday && <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded bg-tt-cyan/15 text-tt-cyan">Today</span>}
                </div>
                <button
                  type="button"
                  onClick={() => onAddCell('', iso)}
                  className="text-[11px] font-semibold text-tt-cyan hover:underline"
                >
                  + Add shift
                </button>
              </div>
              {dayGroups.length === 0 ? (
                <p className="text-xs text-tt-muted py-2">No shifts scheduled.</p>
              ) : (
                <div className="space-y-3">
                  {dayGroups.map((g) => (
                    <div key={g.key}>
                      <div className="flex items-center gap-1.5 mb-1">
                        <GroupDot roleKey={g.key} />
                        <span className="text-[10px] font-semibold text-tt-muted uppercase tracking-wide">{g.label}</span>
                      </div>
                      <div className="space-y-2">
                        {g.employees.map((emp) => (
                          <div key={emp.employee.id} className="grid grid-cols-[100px_1fr] gap-2 items-start">
                            <div className="text-[12px] text-tt-text pt-1 truncate">{emp.employee.name}</div>
                            <DayCell
                              cell={emp.cells[dayIdx]}
                              roleKey={g.key}
                              onAdd={() => onAddCell(emp.employee.id, iso)}
                              onOpenCard={onOpenCard}
                            />
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
        <div className="px-4 py-3 flex items-center justify-between">
          <span className="text-[12px] font-semibold text-tt-text">Week total</span>
          <span className="text-[12px] font-semibold text-tt-text tabular-nums">{grandTotal.toFixed(2)} h</span>
        </div>
      </div>
    </div>
  );
}
