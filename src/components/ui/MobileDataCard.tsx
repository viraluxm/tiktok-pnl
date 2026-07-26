'use client';

import type { ReactNode } from 'react';

/**
 * MobileDataCard — a purely presentational card for rendering a table row as a
 * stacked card on phones (typically inside a `md:hidden` block, with the desktop
 * `<table>` kept behind `hidden md:block`).
 *
 * It contains NO business logic, data fetching, or calculations: every value and
 * handler is passed in by the caller. Use it where a generic card fits; pages are
 * free to render bespoke cards where that reads better.
 */
export interface MobileDataStat {
  label: ReactNode;
  value: ReactNode;
  /** span both columns (for a long value like a full listing name) */
  wide?: boolean;
}

interface MobileDataCardProps {
  /** leading visual — e.g. an <img> thumbnail or a number badge */
  thumbnail?: ReactNode;
  /** primary line (item / show / order name) */
  title: ReactNode;
  /** secondary line (host · store · date, seller SKU, etc.) */
  subtitle?: ReactNode;
  /** trailing status pill / chip */
  badge?: ReactNode;
  /** label/value pairs rendered in a 2-column grid */
  stats?: MobileDataStat[];
  /** action controls (buttons) — laid out full-width; taps don't trigger onClick */
  actions?: ReactNode;
  /** makes the whole card tappable (e.g. open detail). Nested action taps are isolated. */
  onClick?: () => void;
  /** visual selected state (e.g. row selection) */
  selected?: boolean;
  className?: string;
}

export default function MobileDataCard({
  thumbnail,
  title,
  subtitle,
  badge,
  stats,
  actions,
  onClick,
  selected = false,
  className = '',
}: MobileDataCardProps) {
  const interactive = typeof onClick === 'function';
  return (
    <div
      onClick={onClick}
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      onKeyDown={
        interactive
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onClick?.();
              }
            }
          : undefined
      }
      className={`w-full rounded-2xl border p-4 flex flex-col gap-3 transition-colors ${
        selected ? 'border-tt-cyan bg-tt-cyan/5' : 'border-tt-border bg-tt-card'
      } ${interactive ? 'cursor-pointer active:opacity-90' : ''} ${className}`}
    >
      <div className="flex items-start gap-3">
        {thumbnail && <div className="shrink-0">{thumbnail}</div>}
        <div className="min-w-0 flex-1">
          <div className="font-semibold text-tt-text break-words leading-tight">{title}</div>
          {subtitle && <div className="text-xs text-tt-muted mt-0.5 break-words">{subtitle}</div>}
        </div>
        {badge && <div className="shrink-0">{badge}</div>}
      </div>

      {stats && stats.length > 0 && (
        <div className="grid grid-cols-2 gap-x-4 gap-y-2">
          {stats.map((s, i) => (
            <div key={i} className={`min-w-0 ${s.wide ? 'col-span-2' : ''}`}>
              <div className="text-[11px] uppercase tracking-wide text-tt-muted">{s.label}</div>
              <div className="text-sm font-medium text-tt-text tabular-nums break-words">{s.value}</div>
            </div>
          ))}
        </div>
      )}

      {actions && (
        // Stop taps on the action row from also firing the card's onClick.
        <div onClick={(e) => e.stopPropagation()} className="flex flex-wrap gap-2 [&>*]:flex-1 [&>*]:min-h-[44px]">
          {actions}
        </div>
      )}
    </div>
  );
}
