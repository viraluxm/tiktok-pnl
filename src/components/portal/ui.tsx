'use client';

import { useEffect, useId, useRef, type ReactNode } from 'react';
import { avatarHue, initialsOf } from '@/lib/schedule/calendarModel';
import { XIcon } from './icons';

// Portal UI primitives. Small, purpose-built, on Lensed's tokens (docs/DESIGN.md). The rule of the
// redesign is containment only where it buys hierarchy: rows are separated by hairlines and
// spacing, not boxed; the NextShift block and sheets are the only elevated surfaces on Home.

export function SectionLabel({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-2 flex items-baseline justify-between gap-3">
      <h2 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-tt-muted">{children}</h2>
      {action}
    </div>
  );
}

type ButtonVariant = 'primary' | 'quiet' | 'tinted' | 'danger' | 'outline';
const BTN: Record<ButtonVariant, string> = {
  primary: 'bg-tt-cyan text-black hover:bg-tt-cyan/90',
  quiet: 'bg-white/[0.06] text-tt-text hover:bg-white/10',
  tinted: 'bg-tt-cyan/15 text-tt-cyan hover:bg-tt-cyan/25',
  danger: 'bg-tt-red/15 text-tt-red hover:bg-tt-red/25',
  outline: 'border border-tt-border text-tt-text hover:bg-tt-card-hover',
};

export function Button({
  variant = 'quiet', size = 'md', full, busy, className = '', children, ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: 'sm' | 'md' | 'lg'; full?: boolean; busy?: boolean }) {
  const sz = size === 'sm' ? 'min-h-9 px-3 text-xs' : size === 'lg' ? 'min-h-12 px-4 text-base' : 'min-h-11 px-4 text-sm';
  return (
    <button
      type="button"
      {...rest}
      disabled={rest.disabled || busy}
      aria-busy={busy || undefined}
      className={`inline-flex items-center justify-center gap-2 rounded-xl font-semibold transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-tt-cyan/70 focus-visible:ring-offset-2 focus-visible:ring-offset-tt-bg disabled:cursor-not-allowed disabled:opacity-40 ${sz} ${full ? 'w-full' : ''} ${BTN[variant]} ${className}`}
    >
      {busy && <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden />}
      {children}
    </button>
  );
}

export function Avatar({ name, size = 'md', ring }: { name: string; size?: 'sm' | 'md' | 'lg'; ring?: 'offered' | 'me' | null }) {
  const cls = size === 'sm' ? 'h-7 w-7 text-[10px]' : size === 'lg' ? 'h-11 w-11 text-sm' : 'h-9 w-9 text-xs';
  const r = ring === 'offered' ? 'ring-2 ring-tt-yellow' : ring === 'me' ? 'ring-2 ring-tt-cyan' : '';
  return (
    <span
      className={`inline-flex shrink-0 select-none items-center justify-center rounded-full font-bold text-white ${cls} ${r}`}
      style={{ backgroundColor: `hsl(${avatarHue(name)}, 40%, 40%)` }}
      aria-hidden
    >
      {initialsOf(name)}
    </span>
  );
}

export function Segmented<T extends string>({
  value, onChange, options, label,
}: { value: T; onChange: (v: T) => void; options: { value: T; label: string; badge?: number }[]; label: string }) {
  return (
    <div role="tablist" aria-label={label} className="flex gap-1 rounded-xl bg-white/[0.06] p-1">
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() => onChange(o.value)}
            className={`relative flex min-h-10 flex-1 items-center justify-center gap-1.5 rounded-lg px-2 text-[13px] font-semibold transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-tt-cyan/70 ${on ? 'bg-white/10 text-tt-text shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)]' : 'text-tt-muted hover:text-tt-text'}`}
          >
            {o.label}
            {o.badge ? (
              <span className={`rounded-full px-1.5 text-[10px] font-bold leading-4 ${on ? 'bg-tt-cyan/25 text-tt-cyan' : 'bg-white/10 text-tt-muted'}`}>{o.badge}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

export function EmptyState({ title, body, action }: { title: string; body?: string; action?: ReactNode }) {
  return (
    <div className="rounded-2xl border border-dashed border-tt-border px-5 py-8 text-center">
      <p className="text-sm font-medium text-tt-text">{title}</p>
      {body && <p className="mt-1 text-[13px] text-tt-muted">{body}</p>}
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}

export function ErrorState({ message, onRetry, busy }: { message: string; onRetry?: () => void; busy?: boolean }) {
  return (
    <div role="alert" className="rounded-2xl border border-tt-red/30 bg-tt-red/[0.06] px-5 py-5 text-center">
      <p className="text-sm font-medium text-tt-text">{message}</p>
      {onRetry && (
        <div className="mt-3 flex justify-center">
          <Button variant="outline" size="sm" onClick={onRetry} busy={busy}>Try again</Button>
        </div>
      )}
    </div>
  );
}

export function Skeleton({ className = '' }: { className?: string }) {
  return <div aria-hidden className={`animate-pulse rounded-lg bg-white/[0.06] ${className}`} />;
}

export function InlineError({ children }: { children: ReactNode }) {
  return <p role="alert" className="rounded-lg bg-tt-red/10 px-3 py-2 text-[13px] text-tt-red">{children}</p>;
}

/**
 * Bottom sheet on phones, centred dialog from `sm:` up. Closes on backdrop tap and Escape, locks
 * body scroll while open, and moves focus into the panel so a keyboard/screen-reader user is not
 * left behind the overlay. Motion: a 220ms ease-out slide, disabled under prefers-reduced-motion
 * (globals.css .portal-sheet).
 */
export function Sheet({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: string; children: ReactNode; wide?: boolean }) {
  const id = useId();
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    const t = window.setTimeout(() => panel.current?.focus(), 30);
    return () => {
      document.body.style.overflow = prev;
      document.removeEventListener('keydown', onKey);
      window.clearTimeout(t);
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 sm:items-center sm:p-6" onClick={onClose}>
      <div
        ref={panel}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={id}
        onClick={(e) => e.stopPropagation()}
        className={`portal-sheet w-full ${wide ? 'sm:max-w-md' : 'sm:max-w-sm'} max-h-[88dvh] overflow-y-auto overscroll-contain rounded-t-[22px] border border-tt-border bg-[#171717] px-5 pb-[calc(env(safe-area-inset-bottom)+20px)] pt-3 shadow-2xl outline-none sm:rounded-[22px] sm:pb-5`}
      >
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-white/15 sm:hidden" aria-hidden />
        <div className="mb-3 flex items-start justify-between gap-3">
          <h2 id={id} className="text-base font-semibold text-tt-text">{title}</h2>
          <button
            type="button" onClick={onClose} aria-label="Close"
            className="-mr-2 -mt-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-tt-muted hover:bg-white/10 hover:text-tt-text focus:outline-none focus-visible:ring-2 focus-visible:ring-tt-cyan/70"
          >
            <XIcon size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** The inset "fact box" a sheet uses to restate WHICH shift it is about. */
export function FactBox({ children }: { children: ReactNode }) {
  return <div className="my-3 rounded-xl bg-white/[0.04] px-4 py-3">{children}</div>;
}
