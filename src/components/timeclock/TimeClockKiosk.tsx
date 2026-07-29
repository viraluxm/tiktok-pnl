'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useUser } from '@/hooks/useUser';
import { useTimeClock, type KioskEmployee } from '@/hooks/useTimeClock';
import {
  isActionAllowed,
  friendlyClockError,
  clockErrorToken,
  type TimeClockAction,
} from '@/lib/timeclock';
import LiveClock from './LiveClock';
import ExitKioskButton from './ExitKioskButton';

// After this long with no interaction on a non-home screen, return to the home screen so
// the kiosk never sits on a half-finished punch showing someone's name.
const IDLE_MS = 30_000;

// ─── icons (inline; the app uses no icon library) ───────────────────────────
const iconProps = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  className: 'w-11 h-11 sm:w-12 sm:h-12',
};
const ClockInIcon = () => (
  <svg viewBox="0 0 24 24" {...iconProps}><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" /><polyline points="10 17 15 12 10 7" /><line x1="15" y1="12" x2="3" y2="12" /></svg>
);
const BreakIcon = () => (
  <svg viewBox="0 0 24 24" {...iconProps}><path d="M18 8h1a4 4 0 0 1 0 8h-1" /><path d="M2 8h16v9a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4Z" /><line x1="6" y1="2" x2="6" y2="4" /><line x1="10" y1="2" x2="10" y2="4" /><line x1="14" y1="2" x2="14" y2="4" /></svg>
);
const ResumeIcon = () => (
  <svg viewBox="0 0 24 24" {...iconProps}><circle cx="12" cy="12" r="9" /><polygon points="10 8 16 12 10 16 10 8" /></svg>
);
const ClockOutIcon = () => (
  <svg viewBox="0 0 24 24" {...iconProps}><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><polyline points="16 17 21 12 16 7" /><line x1="21" y1="12" x2="9" y2="12" /></svg>
);

interface ActionMeta {
  action: TimeClockAction;
  label: string;
  ring: string;
  text: string;
  glow: string;
  icon: ReactNode;
  pickHeading: string;
  emptyMsg: string;
}

// Static class strings (Tailwind can't see dynamically-built names).
const ACTIONS: ActionMeta[] = [
  { action: 'clock_in', label: 'Clock In', ring: 'border-tt-green/60', text: 'text-tt-green', glow: 'bg-tt-green/10', icon: <ClockInIcon />, pickHeading: "Who's clocking in?", emptyMsg: 'Everyone is already clocked in.' },
  { action: 'start_break', label: 'Start Break', ring: 'border-tt-yellow/60', text: 'text-tt-yellow', glow: 'bg-tt-yellow/10', icon: <BreakIcon />, pickHeading: "Who's starting a break?", emptyMsg: 'No one is currently working.' },
  { action: 'end_break', label: 'End Break', ring: 'border-tt-cyan/60', text: 'text-tt-cyan', glow: 'bg-tt-cyan/10', icon: <ResumeIcon />, pickHeading: "Who's ending a break?", emptyMsg: 'No one is currently on a break.' },
  { action: 'clock_out', label: 'Clock Out', ring: 'border-tt-magenta/60', text: 'text-tt-magenta', glow: 'bg-tt-magenta/10', icon: <ClockOutIcon />, pickHeading: "Who's clocking out?", emptyMsg: 'No one is currently working.' },
];
const META = (a: TimeClockAction) => ACTIONS.find((m) => m.action === a)!;

function confirmPrompt(action: TimeClockAction, name: string): string {
  switch (action) {
    case 'clock_in': return `Clock in as ${name}?`;
    case 'start_break': return `Start a break for ${name}?`;
    case 'end_break': return `End ${name}'s break?`;
    case 'clock_out': return `Clock out ${name}?`;
  }
}
function successMessage(action: TimeClockAction, name: string): string {
  switch (action) {
    case 'clock_in': return `${name} is clocked in.`;
    case 'start_break': return `Break started for ${name}.`;
    case 'end_break': return `Welcome back, ${name}.`;
    case 'clock_out': return `${name} is clocked out. Have a good one!`;
  }
}
function titleCaseRole(role: string): string {
  return role ? role.charAt(0).toUpperCase() + role.slice(1) : '';
}

type Screen =
  | { name: 'home' }
  | { name: 'pick'; action: TimeClockAction }
  | { name: 'confirm'; action: TimeClockAction; employee: KioskEmployee }
  | { name: 'result'; ok: boolean; message: string };

export default function TimeClockKiosk() {
  const { user } = useUser();
  const { employees, isLoading, isError, stateOf, refetchState, punch } = useTimeClock();
  const [screen, setScreen] = useState<Screen>({ name: 'home' });
  const [submitting, setSubmitting] = useState(false);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const goHome = useCallback(() => setScreen({ name: 'home' }), []);

  const armIdle = useCallback(() => {
    if (idleTimer.current) clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => setScreen({ name: 'home' }), IDLE_MS);
  }, []);

  // Inactivity reset on the pick/confirm screens.
  useEffect(() => {
    if (screen.name === 'pick' || screen.name === 'confirm') {
      armIdle();
      return () => {
        if (idleTimer.current) clearTimeout(idleTimer.current);
      };
    }
    if (idleTimer.current) clearTimeout(idleTimer.current);
  }, [screen, armIdle]);

  // Auto-return from the result screen (errors linger a little longer so they can be read).
  useEffect(() => {
    if (screen.name !== 'result') return;
    const id = setTimeout(goHome, screen.ok ? 2200 : 3600);
    return () => clearTimeout(id);
  }, [screen, goHome]);

  const handleConfirm = useCallback(
    async (action: TimeClockAction, employee: KioskEmployee) => {
      if (submitting) return; // hard guard against a double tap
      setSubmitting(true);
      try {
        await punch.mutateAsync({ action, employeeId: employee.id });
        setScreen({ name: 'result', ok: true, message: successMessage(action, employee.name) });
      } catch (err) {
        const token = clockErrorToken(err);
        // Uncertain / rejected: refresh the authoritative state before the next attempt.
        refetchState();
        // A retried clock-out that finds nothing open is benign ("already recorded"), not a failure.
        const benign = action === 'clock_out' && token === 'NOT_CLOCKED_IN';
        setScreen({ name: 'result', ok: benign, message: friendlyClockError(token, employee.name, action) });
      } finally {
        setSubmitting(false);
      }
    },
    [submitting, punch, refetchState],
  );

  const onPointerDown = () => {
    if (screen.name === 'pick' || screen.name === 'confirm') armIdle();
  };

  return (
    <div
      onPointerDown={onPointerDown}
      className="fixed inset-0 z-40 bg-tt-bg text-tt-text flex flex-col overflow-hidden pt-safe pb-safe pl-safe pr-safe"
    >
      {/* top bar */}
      <div className="flex items-center justify-between px-6 py-4 shrink-0">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 bg-gradient-to-br from-tt-cyan to-[#4F46E5] rounded-lg" />
          <span className="text-sm font-semibold text-tt-muted tracking-wide">Time Clock</span>
        </div>
        {screen.name !== 'home' && (
          <button
            type="button"
            onClick={goHome}
            className="text-sm text-tt-muted hover:text-tt-text border border-tt-border rounded-lg px-3 py-1.5"
          >
            ← Back
          </button>
        )}
      </div>

      {/* main */}
      <div className="flex-1 min-h-0 flex flex-col items-center justify-center px-6 pb-6 overflow-y-auto">
        {isLoading ? (
          <div className="w-9 h-9 bg-gradient-to-br from-tt-cyan to-[#4F46E5] rounded-[10px] animate-pulse" />
        ) : isError ? (
          <p className="text-tt-red text-lg">Couldn&apos;t load the time clock. Check the connection and try again.</p>
        ) : screen.name === 'home' ? (
          <HomeScreen onPick={(action) => setScreen({ name: 'pick', action })} />
        ) : screen.name === 'pick' ? (
          <PickScreen
            action={screen.action}
            employees={employees}
            eligible={(e) => isActionAllowed(stateOf(e.id), screen.action)}
            onChoose={(employee) => setScreen({ name: 'confirm', action: screen.action, employee })}
          />
        ) : screen.name === 'confirm' ? (
          <ConfirmScreen
            action={screen.action}
            employee={screen.employee}
            submitting={submitting || punch.isPending}
            onConfirm={() => handleConfirm(screen.action, screen.employee)}
            onCancel={goHome}
          />
        ) : (
          <ResultScreen ok={screen.ok} message={screen.message} onDismiss={goHome} />
        )}
      </div>

      {/* exit control (corner) */}
      <div className="absolute bottom-4 left-4 pl-safe pb-safe">
        <ExitKioskButton user={user} />
      </div>
    </div>
  );
}

// ─── screens ────────────────────────────────────────────────────────────────

function HomeScreen({ onPick }: { onPick: (a: TimeClockAction) => void }) {
  return (
    <div className="w-full max-w-4xl flex flex-col items-center gap-10">
      <LiveClock size="lg" />
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-6 sm:gap-8">
        {ACTIONS.map((m) => (
          <button
            key={m.action}
            type="button"
            onClick={() => onPick(m.action)}
            className="group flex flex-col items-center gap-3 focus:outline-none"
          >
            <span
              className={`w-32 h-32 sm:w-40 sm:h-40 rounded-full border-4 ${m.ring} ${m.glow} ${m.text} flex items-center justify-center transition-transform group-active:scale-95 group-hover:scale-[1.03]`}
            >
              {m.icon}
            </span>
            <span className="text-base sm:text-lg font-semibold text-tt-text">{m.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function PickScreen({
  action,
  employees,
  eligible,
  onChoose,
}: {
  action: TimeClockAction;
  employees: KioskEmployee[];
  eligible: (e: KioskEmployee) => boolean;
  onChoose: (e: KioskEmployee) => void;
}) {
  const meta = META(action);
  const list = employees.filter(eligible);
  return (
    <div className="w-full max-w-3xl flex flex-col items-center gap-6">
      <h1 className={`text-2xl sm:text-3xl font-semibold ${meta.text}`}>{meta.pickHeading}</h1>
      {employees.length === 0 ? (
        <p className="text-tt-muted text-center">No active employees yet. Add them in the Team tab.</p>
      ) : list.length === 0 ? (
        <p className="text-tt-muted text-center">{meta.emptyMsg}</p>
      ) : (
        <div className="w-full grid grid-cols-2 sm:grid-cols-3 gap-3 sm:gap-4">
          {list.map((e) => (
            <button
              key={e.id}
              type="button"
              onClick={() => onChoose(e)}
              className="min-h-[72px] rounded-2xl border border-tt-border bg-tt-card hover:bg-tt-card-hover active:scale-[0.98] transition px-4 py-3 text-left"
            >
              <div className="text-lg font-semibold text-tt-text truncate">{e.name}</div>
              {e.role && <div className="text-xs text-tt-muted truncate">{titleCaseRole(e.role)}</div>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ConfirmScreen({
  action,
  employee,
  submitting,
  onConfirm,
  onCancel,
}: {
  action: TimeClockAction;
  employee: KioskEmployee;
  submitting: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const meta = META(action);
  return (
    <div className="w-full max-w-md flex flex-col items-center gap-8 text-center">
      <div className={`w-20 h-20 rounded-full border-4 ${meta.ring} ${meta.glow} ${meta.text} flex items-center justify-center`}>
        {meta.icon}
      </div>
      <div>
        <h1 className="text-2xl sm:text-3xl font-semibold text-tt-text">{confirmPrompt(action, employee.name)}</h1>
        <div className="mt-3">
          <LiveClock size="sm" showDate={false} showSeconds />
        </div>
      </div>
      <div className="flex w-full gap-3">
        <button
          type="button"
          onClick={onCancel}
          disabled={submitting}
          className="flex-1 min-h-[60px] rounded-2xl border border-tt-border text-tt-muted hover:text-tt-text text-lg font-semibold disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={submitting}
          className="flex-1 min-h-[60px] rounded-2xl bg-tt-cyan text-black text-lg font-semibold hover:bg-tt-cyan/90 active:scale-[0.98] transition disabled:opacity-60"
        >
          {submitting ? 'Saving…' : 'Confirm'}
        </button>
      </div>
    </div>
  );
}

function ResultScreen({ ok, message, onDismiss }: { ok: boolean; message: string; onDismiss: () => void }) {
  return (
    <button
      type="button"
      onClick={onDismiss}
      className="w-full max-w-md flex flex-col items-center gap-6 text-center focus:outline-none"
    >
      <span
        className={`w-24 h-24 rounded-full flex items-center justify-center ${
          ok ? 'bg-tt-green/15 text-tt-green' : 'bg-tt-red/15 text-tt-red'
        }`}
      >
        {ok ? (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" className="w-12 h-12"><polyline points="20 6 9 17 4 12" /></svg>
        ) : (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" className="w-12 h-12"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
        )}
      </span>
      <p className="text-2xl font-semibold text-tt-text">{message}</p>
      <p className="text-sm text-tt-muted">Tap anywhere to continue</p>
    </button>
  );
}
