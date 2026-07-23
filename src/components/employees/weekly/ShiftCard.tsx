'use client';

import type { RoleGroupKey, WeekShiftCard } from '@/lib/weeklySchedule';

// Role tint for a card. Color is never the ONLY signal — every card also carries a text
// type label (One-off / Recurring / Open …) and times.
function tintClasses(roleKey: RoleGroupKey, isOpen: boolean): string {
  if (isOpen) return 'border-l-tt-yellow bg-tt-yellow/10 hover:bg-tt-yellow/15';
  switch (roleKey) {
    case 'host':
      return 'border-l-tt-cyan bg-tt-cyan/10 hover:bg-tt-cyan/15';
    case 'fulfillment':
      return 'border-l-tt-magenta-soft bg-tt-magenta-soft/10 hover:bg-tt-magenta-soft/15';
    default:
      return 'border-l-tt-muted bg-white/5 hover:bg-white/10';
  }
}

function hm(t: string): string {
  return t.slice(0, 5);
}

function Pill({ tone, children }: { tone: 'cyan' | 'yellow' | 'muted' | 'red'; children: React.ReactNode }) {
  const cls = {
    cyan: 'bg-tt-cyan/15 text-tt-cyan',
    yellow: 'bg-tt-yellow/15 text-tt-yellow',
    muted: 'bg-tt-muted/15 text-tt-muted',
    red: 'bg-tt-red/15 text-tt-red',
  }[tone];
  return <span className={`text-[9px] font-semibold px-1.5 py-0.5 rounded ${cls}`}>{children}</span>;
}

// One shift, rendered inside a day cell. Clicking opens the actions/editor.
export default function ShiftCard({
  card,
  roleKey,
  onClick,
}: {
  card: WeekShiftCard;
  roleKey: RoleGroupKey;
  onClick: () => void;
}) {
  const typeLabel = card.isOpen
    ? 'Open shift'
    : card.kind === 'recurring'
      ? card.isFrozen
        ? 'Recurring (logged)'
        : 'Recurring'
      : 'One-off';

  return (
    <button
      type="button"
      onClick={onClick}
      title={typeLabel}
      className={`w-full text-left border-l-[3px] rounded-md px-2 py-1.5 transition-colors cursor-pointer ${tintClasses(roleKey, card.isOpen)}`}
    >
      <div className="flex items-center justify-between gap-1">
        <span className="text-[11px] font-semibold text-tt-text tabular-nums">
          {hm(card.start_time)}<span className="text-tt-muted">–</span>{card.isOpen ? <span className="text-tt-yellow">now</span> : hm(card.end_time as string)}
        </span>
        <span className="text-[10px] tabular-nums text-tt-muted">
          {card.isOpen ? '—' : `${card.hours.toFixed(2)}h`}
        </span>
      </div>

      <div className="mt-1 flex flex-wrap items-center gap-1">
        {/* Type label — always present, never color-only. */}
        <span className="text-[9px] font-medium text-tt-muted">{typeLabel}</span>
        {card.isOvernight && <Pill tone="muted">🌙 +1d</Pill>}
        {card.isOpen && <Pill tone="yellow">No end time</Pill>}
        {card.modified && <Pill tone="yellow">Modified</Pill>}
      </div>
    </button>
  );
}
