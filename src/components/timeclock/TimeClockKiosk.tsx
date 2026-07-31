'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useUser } from '@/hooks/useUser';
import { useTimeClock, type KioskEmployee } from '@/hooks/useTimeClock';
import {
  isActionAllowed,
  friendlyClockError,
  clockErrorToken,
  teamOfRole,
  teamLabel,
  unavailableReason,
  TEAMS,
  type TimeClockAction,
  type TeamKey,
  type AttendanceState,
} from '@/lib/timeclock';
import LiveClock from './LiveClock';
import ExitKioskButton from './ExitKioskButton';
import { enterFullscreen, exitFullscreen, isFullscreen } from '@/lib/fullscreen';

// After this long with no interaction on a non-home screen, return to the home screen so
// the kiosk never sits on a half-finished punch showing someone's name.
const IDLE_MS = 30_000;

// ─── action icons (inline; the app uses no icon library) ────────────────────
const iconProps = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  className: 'w-11 h-11 sm:w-12 sm:h-12',
};
const ClockInIcon = () => (
  <svg viewBox="0 0 24 24" {...iconProps} aria-hidden="true"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" /><polyline points="10 17 15 12 10 7" /><line x1="15" y1="12" x2="3" y2="12" /></svg>
);
const BreakIcon = () => (
  <svg viewBox="0 0 24 24" {...iconProps} aria-hidden="true"><path d="M18 8h1a4 4 0 0 1 0 8h-1" /><path d="M2 8h16v9a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4Z" /><line x1="6" y1="2" x2="6" y2="4" /><line x1="10" y1="2" x2="10" y2="4" /><line x1="14" y1="2" x2="14" y2="4" /></svg>
);
const ResumeIcon = () => (
  <svg viewBox="0 0 24 24" {...iconProps} aria-hidden="true"><circle cx="12" cy="12" r="9" /><polygon points="10 8 16 12 10 16 10 8" /></svg>
);
const ClockOutIcon = () => (
  <svg viewBox="0 0 24 24" {...iconProps} aria-hidden="true"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><polyline points="16 17 21 12 16 7" /><line x1="21" y1="12" x2="9" y2="12" /></svg>
);

interface ActionMeta {
  action: TimeClockAction;
  label: string;
  ring: string;
  text: string;
  glow: string;
  icon: ReactNode;
}
const ACTIONS: ActionMeta[] = [
  { action: 'clock_in', label: 'Clock In', ring: 'border-tt-green/60', text: 'text-tt-green', glow: 'bg-tt-green/10', icon: <ClockInIcon /> },
  { action: 'start_break', label: 'Start Break', ring: 'border-tt-yellow/60', text: 'text-tt-yellow', glow: 'bg-tt-yellow/10', icon: <BreakIcon /> },
  { action: 'end_break', label: 'End Break', ring: 'border-tt-cyan/60', text: 'text-tt-cyan', glow: 'bg-tt-cyan/10', icon: <ResumeIcon /> },
  { action: 'clock_out', label: 'Clock Out', ring: 'border-tt-magenta/60', text: 'text-tt-magenta', glow: 'bg-tt-magenta/10', icon: <ClockOutIcon /> },
];
const META = (a: TimeClockAction) => ACTIONS.find((m) => m.action === a)!;

// ─── team icons (Lucide-shaped, inlined to avoid a new dependency) ──────────
const teamIconProps = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  className: 'w-8 h-8',
};
const MicIcon = () => ( // Lucide "mic" — Live Host
  <svg viewBox="0 0 24 24" {...teamIconProps} aria-hidden="true"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" /><path d="M19 10v2a7 7 0 0 1-14 0v-2" /><line x1="12" y1="19" x2="12" y2="22" /></svg>
);
const PackageIcon = () => ( // Lucide "package" — Fulfillment
  <svg viewBox="0 0 24 24" {...teamIconProps} aria-hidden="true"><path d="M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z" /><path d="M3.3 7 12 12l8.7-5" /><path d="M12 22V12" /></svg>
);
const UsersIcon = () => ( // Lucide "users" — Other
  <svg viewBox="0 0 24 24" {...teamIconProps} aria-hidden="true"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></svg>
);

// Restrained per-team accents, applied ONLY to the icon tile / avatar / hover border —
// never the whole card. Static class strings so Tailwind emits them.
interface TeamStyle {
  icon: ReactNode;
  iconWrap: string; // icon tile
  avatar: string; // employee initials avatar
  hoverBorder: string; // card hover border accent
}
const TEAM_STYLE: Record<TeamKey, TeamStyle> = {
  host: {
    icon: <MicIcon />,
    iconWrap: 'bg-[#8b5cf6]/15 text-[#a78bfa] ring-1 ring-inset ring-[#8b5cf6]/30',
    avatar: 'bg-[#8b5cf6]/15 text-[#a78bfa]',
    hoverBorder: 'hover:border-[#8b5cf6]/50',
  },
  fulfillment: {
    icon: <PackageIcon />,
    iconWrap: 'bg-tt-cyan/15 text-tt-cyan ring-1 ring-inset ring-tt-cyan/30',
    avatar: 'bg-tt-cyan/15 text-tt-cyan',
    hoverBorder: 'hover:border-tt-cyan/50',
  },
  other: {
    icon: <UsersIcon />,
    iconWrap: 'bg-[#818cf8]/15 text-[#a5b4fc] ring-1 ring-inset ring-[#818cf8]/30',
    avatar: 'bg-[#818cf8]/15 text-[#a5b4fc]',
    hoverBorder: 'hover:border-[#818cf8]/50',
  },
};

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
// Initials from a name: first + last word initials (e.g. "Maria Lopez" → "ML").
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// Colored pill that shows the chosen action at the top of the team/employee screens.
function ActionPill({ action }: { action: TimeClockAction }) {
  const m = META(action);
  return (
    <span className={`inline-flex items-center gap-2 rounded-full border-2 px-4 py-1.5 text-sm font-semibold ${m.ring} ${m.glow} ${m.text}`}>
      <span className="w-2 h-2 rounded-full bg-current" />
      {m.label}
    </span>
  );
}

type Screen =
  | { name: 'home' }
  | { name: 'team'; action: TimeClockAction }
  | { name: 'pick'; action: TimeClockAction; team: TeamKey }
  | { name: 'confirm'; action: TimeClockAction; team: TeamKey; employee: KioskEmployee }
  | { name: 'result'; ok: boolean; message: string };

export default function TimeClockKiosk() {
  const { user } = useUser();
  const { employees, isLoading, isError, stateOf, refetchState, punch, openByEmployee } = useTimeClock();
  // "Still clocked in" warning: anyone punched in longer than this is likely a forgotten
  // clock-out. The reconciler auto-closes at TIME_CLOCK_MAX_OPEN_HOURS (default 16h) so pay is
  // never lost, but surfacing it here lets them fix it before it's flagged for review.
  const STILL_IN_WARN_HOURS = 12;
  const stillClockedIn = employees
    .map((e) => {
      const cin = openByEmployee.get(e.id)?.clocked_in_at;
      const hrs = cin ? (Date.now() - new Date(cin).getTime()) / 3_600_000 : 0;
      return { name: e.name, hrs };
    })
    .filter((x) => x.hrs >= STILL_IN_WARN_HOURS)
    .sort((a, b) => b.hrs - a.hrs);
  const [screen, setScreen] = useState<Screen>({ name: 'home' });
  const [submitting, setSubmitting] = useState(false);
  const [isFs, setIsFs] = useState(false);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const exitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Fullscreen reuses Shipping's mechanism. It is REQUESTED from the "Open Time Clock" click
  // (a user gesture in ShiftsView) and persists across the client-side navigation into this
  // route. Here we only (a) keep the "Full screen" fallback in sync with the real state — for
  // a direct visit to /dashboard/time-clock or a manual Esc — and (b) drop fullscreen when the
  // kiosk unmounts (leaving to the dashboard), mirroring ShippingTab's scan-mode cleanup.
  useEffect(() => {
    setIsFs(isFullscreen());
    const onChange = () => setIsFs(isFullscreen());
    document.addEventListener('fullscreenchange', onChange);
    document.addEventListener('webkitfullscreenchange', onChange);
    return () => {
      document.removeEventListener('fullscreenchange', onChange);
      document.removeEventListener('webkitfullscreenchange', onChange);
    };
  }, []);
  // Exit fullscreen only on a REAL route departure — never during React Strict Mode's dev
  // mount→unmount→remount cycle (which would drop the fullscreen we just entered from the
  // Open-Time-Clock click). We SCHEDULE the exit in cleanup and CANCEL it if the component
  // remounts synchronously (Strict Mode's setup runs again and clears the pending timer).
  // Intentional exits still go through Exit Kiosk (which calls exitFullscreen directly).
  useEffect(() => {
    if (exitTimer.current) {
      clearTimeout(exitTimer.current);
      exitTimer.current = null;
    }
    return () => {
      exitTimer.current = setTimeout(() => exitFullscreen(), 0);
    };
  }, []);

  const goHome = useCallback(() => setScreen({ name: 'home' }), []);

  // Back moves ONE step: pick → team → home; confirm → pick. (result/home have no Back.)
  const goBack = useCallback(() => {
    setScreen((s) => {
      switch (s.name) {
        case 'pick': return { name: 'team', action: s.action };
        case 'team': return { name: 'home' };
        case 'confirm': return { name: 'pick', action: s.action, team: s.team };
        default: return { name: 'home' };
      }
    });
  }, []);

  const armIdle = useCallback(() => {
    if (idleTimer.current) clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => setScreen({ name: 'home' }), IDLE_MS);
  }, []);

  // Inactivity reset on the multi-step selection screens.
  const midFlow = screen.name === 'team' || screen.name === 'pick' || screen.name === 'confirm';
  useEffect(() => {
    if (midFlow) {
      armIdle();
      return () => {
        if (idleTimer.current) clearTimeout(idleTimer.current);
      };
    }
    if (idleTimer.current) clearTimeout(idleTimer.current);
  }, [screen, midFlow, armIdle]);

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
        const benign = action === 'clock_out' && token === 'NOT_CLOCKED_IN';
        setScreen({ name: 'result', ok: benign, message: friendlyClockError(token, employee.name, action) });
      } finally {
        setSubmitting(false);
      }
    },
    [submitting, punch, refetchState],
  );

  const onPointerDown = () => {
    if (midFlow) armIdle();
  };

  return (
    <div
      onPointerDown={onPointerDown}
      className="fixed inset-0 z-[200] bg-tt-bg text-tt-text flex flex-col overflow-hidden pt-safe pb-safe pl-safe pr-safe"
    >
      {/* top bar — Back control only (right-aligned); no kiosk branding, so the action/team/
          employee content is the sole visual focus and stays centered below. */}
      <div className="flex items-center justify-end px-6 py-4 shrink-0">
        {midFlow && (
          <button
            type="button"
            onClick={goBack}
            className="inline-flex items-center gap-1.5 rounded-xl border border-tt-border-hover bg-tt-card-hover px-4 py-2.5 text-sm font-medium text-tt-muted hover:text-tt-text hover:bg-white/[0.06] active:scale-[0.98] transition-all duration-150 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-tt-cyan"
          >
            <span aria-hidden="true">←</span> Back
          </button>
        )}
      </div>

      {/* "Still clocked in" warning — forgotten clock-outs, before the reconciler flags them. */}
      {stillClockedIn.length > 0 && (
        <div className="mx-6 mb-2 shrink-0 rounded-xl border border-tt-yellow/40 bg-tt-yellow/10 px-4 py-2.5 text-sm text-tt-yellow" role="alert">
          ⚠ Still clocked in — remember to clock out:{' '}
          {stillClockedIn.map((x, i) => (
            <span key={x.name}>{i > 0 ? ', ' : ''}{x.name} ({Math.floor(x.hrs)}h)</span>
          ))}
        </div>
      )}

      {/* main */}
      <div className="flex-1 min-h-0 flex flex-col items-center justify-center px-6 pb-6 overflow-y-auto">
        {isLoading ? (
          <div className="w-9 h-9 bg-gradient-to-br from-tt-cyan to-[#4F46E5] rounded-[10px] animate-pulse" />
        ) : isError ? (
          <p className="text-tt-red text-lg">Couldn&apos;t load the time clock. Check the connection and try again.</p>
        ) : screen.name === 'home' ? (
          <HomeScreen onPick={(action) => setScreen({ name: 'team', action })} />
        ) : screen.name === 'team' ? (
          <TeamScreen
            action={screen.action}
            employees={employees}
            onChoose={(team) => setScreen({ name: 'pick', action: screen.action, team })}
          />
        ) : screen.name === 'pick' ? (
          <PickScreen
            action={screen.action}
            team={screen.team}
            employees={employees}
            stateOf={stateOf}
            onChoose={(employee) => setScreen({ name: 'confirm', action: screen.action, team: screen.team, employee })}
          />
        ) : screen.name === 'confirm' ? (
          <ConfirmScreen
            action={screen.action}
            team={screen.team}
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

      {/* fullscreen fallback — browser fullscreen needs a user gesture, so a direct visit or a
          manual Esc surfaces this; it hides once fullscreen is active. */}
      {!isFs && (
        <div className="absolute bottom-4 right-4 pr-safe pb-safe">
          <button
            type="button"
            onClick={() => enterFullscreen()}
            className="inline-flex items-center gap-2 rounded-lg border border-tt-border bg-tt-card-hover px-3 py-2 text-xs text-tt-muted hover:text-tt-text hover:bg-white/[0.06] cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-tt-cyan"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4" aria-hidden="true"><path d="M8 3H5a2 2 0 0 0-2 2v3" /><path d="M21 8V5a2 2 0 0 0-2-2h-3" /><path d="M3 16v3a2 2 0 0 0 2 2h3" /><path d="M16 21h3a2 2 0 0 0 2-2v-3" /></svg>
            Full screen
          </button>
        </div>
      )}
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
            className="group flex flex-col items-center gap-3 cursor-pointer focus-visible:outline-none"
          >
            <span
              className={`w-32 h-32 sm:w-40 sm:h-40 rounded-full border-4 ${m.ring} ${m.glow} ${m.text} flex items-center justify-center transition-transform group-active:scale-95 group-hover:scale-[1.03] group-focus-visible:ring-4 group-focus-visible:ring-tt-cyan`}
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

// Choose team: large elevated cards with an accent icon tile, name, member count, and a
// "Select →" affordance. Live Host + Fulfillment always; Other only when it has members.
function TeamScreen({
  action,
  employees,
  onChoose,
}: {
  action: TimeClockAction;
  employees: KioskEmployee[];
  onChoose: (team: TeamKey) => void;
}) {
  const activeByTeam: Record<TeamKey, number> = { host: 0, fulfillment: 0, other: 0 };
  for (const e of employees) activeByTeam[teamOfRole(e.role)] += 1;
  const teams = TEAMS.filter((t) => t.key !== 'other' || activeByTeam.other > 0);

  return (
    <div className="w-full max-w-4xl flex flex-col items-center gap-9">
      <div className="flex flex-col items-center gap-2 text-center">
        <ActionPill action={action} />
        <h1 className="mt-1 text-3xl sm:text-4xl font-semibold text-tt-text">Choose a team</h1>
        <p className="text-sm sm:text-base text-tt-muted">Select your department to find your name.</p>
      </div>
      <div className="flex flex-wrap justify-center gap-5 sm:gap-6">
        {teams.map((t) => {
          const s = TEAM_STYLE[t.key];
          const n = activeByTeam[t.key];
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => onChoose(t.key)}
              className={`group w-[300px] sm:w-[320px] min-h-[184px] rounded-2xl border border-tt-border bg-tt-card-hover shadow-lg shadow-black/30 p-6 flex flex-col items-start gap-4 cursor-pointer transition-all duration-200 hover:-translate-y-0.5 hover:bg-white/[0.06] hover:shadow-xl active:translate-y-0 active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-tt-cyan ${s.hoverBorder}`}
            >
              <span className={`w-16 h-16 rounded-2xl flex items-center justify-center ${s.iconWrap}`}>{s.icon}</span>
              <div className="flex-1">
                <div className="text-xl sm:text-2xl font-semibold text-tt-text">{t.label}</div>
                <div className="mt-0.5 text-sm text-tt-muted">{n} team member{n === 1 ? '' : 's'}</div>
              </div>
              <span className="inline-flex items-center gap-1 text-sm font-medium text-tt-muted group-hover:text-tt-text transition-colors">
                Select <span aria-hidden="true">→</span>
              </span>
            </button>
          );
        })}
      </div>
      {employees.length === 0 && (
        <p className="text-tt-muted text-center">No active employees yet. Add them in the Team tab.</p>
      )}
    </div>
  );
}

// Choose employee within the selected team. Valid employees are elevated cards with a
// team-accented initials avatar; invalid ones appear disabled with a short reason so nobody
// silently disappears. The server RPC remains the final authority.
function PickScreen({
  action,
  team,
  employees,
  stateOf,
  onChoose,
}: {
  action: TimeClockAction;
  team: TeamKey;
  employees: KioskEmployee[];
  stateOf: (id: string) => AttendanceState;
  onChoose: (e: KioskEmployee) => void;
}) {
  const s = TEAM_STYLE[team];
  const members = employees.filter((e) => teamOfRole(e.role) === team); // already active + name-sorted
  const valid = members.filter((e) => isActionAllowed(stateOf(e.id), action));
  const invalid = members.filter((e) => !isActionAllowed(stateOf(e.id), action));
  const gridCols = valid.length === 1 ? 'grid-cols-1 max-w-[420px] mx-auto' : 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3';

  return (
    <div className="w-full max-w-5xl flex flex-col items-center gap-7">
      <div className="flex flex-col items-center gap-2 text-center">
        <ActionPill action={action} />
        <h1 className="mt-1 text-3xl sm:text-4xl font-semibold text-tt-text">{teamLabel(team)}</h1>
        <p className="text-sm sm:text-base text-tt-muted">Tap your name to continue</p>
      </div>

      {members.length === 0 ? (
        <p className="text-tt-muted text-center">No active {teamLabel(team)} employees.</p>
      ) : (
        <div className="w-full flex flex-col gap-6">
          {valid.length > 0 ? (
            <div className={`grid ${gridCols} gap-4 w-full`}>
              {valid.map((e) => (
                <button
                  key={e.id}
                  type="button"
                  onClick={() => onChoose(e)}
                  className="group flex items-center gap-4 rounded-2xl border border-tt-border bg-tt-card-hover shadow-lg shadow-black/30 px-5 py-4 text-left cursor-pointer transition-all duration-200 hover:-translate-y-0.5 hover:bg-white/[0.06] hover:border-tt-border-hover hover:shadow-xl active:translate-y-0 active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-tt-cyan"
                >
                  <span className={`shrink-0 w-12 h-12 rounded-full flex items-center justify-center text-base font-semibold ${s.avatar}`} aria-hidden="true">
                    {initials(e.name)}
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className="block text-lg font-semibold text-tt-text truncate">{e.name}</span>
                    <span className="block text-xs text-tt-muted truncate">
                      {team === 'other' && e.role ? titleCaseRole(e.role) : teamLabel(team)}
                    </span>
                  </span>
                  <span className="shrink-0 text-tt-muted group-hover:text-tt-text transition-colors" aria-hidden="true">→</span>
                </button>
              ))}
            </div>
          ) : (
            <p className="text-tt-muted text-center">No one on this team can do that right now.</p>
          )}

          {invalid.length > 0 && (
            <div className="flex flex-col gap-3">
              <div className="text-[11px] uppercase tracking-wide text-tt-muted border-t border-tt-border pt-3">
                Unavailable for this action
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {invalid.map((e) => (
                  <div
                    key={e.id}
                    aria-disabled="true"
                    className="flex items-center gap-4 rounded-2xl border border-tt-border/50 bg-white/[0.02] px-5 py-4 opacity-60 cursor-not-allowed select-none"
                  >
                    <span className="shrink-0 w-12 h-12 rounded-full bg-white/5 text-tt-muted flex items-center justify-center text-base font-semibold" aria-hidden="true">
                      {initials(e.name)}
                    </span>
                    <span className="flex-1 min-w-0">
                      <span className="block text-lg font-semibold text-tt-muted truncate">{e.name}</span>
                      <span className="block text-xs text-tt-muted truncate">{unavailableReason(stateOf(e.id), action)}</span>
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ConfirmScreen({
  action,
  team,
  employee,
  submitting,
  onConfirm,
  onCancel,
}: {
  action: TimeClockAction;
  team: TeamKey;
  employee: KioskEmployee;
  submitting: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const s = TEAM_STYLE[team];
  return (
    <div className="w-full max-w-md flex flex-col items-center gap-6">
      <ActionPill action={action} />
      <div className="w-full rounded-2xl border border-tt-border bg-tt-card-hover shadow-lg shadow-black/30 p-8 flex flex-col items-center gap-6 text-center">
        <span className={`w-20 h-20 rounded-full flex items-center justify-center text-2xl font-semibold ${s.avatar}`} aria-hidden="true">
          {initials(employee.name)}
        </span>
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
            className="flex-1 min-h-[60px] rounded-2xl border border-tt-border text-tt-muted hover:text-tt-text hover:bg-white/[0.04] text-lg font-semibold disabled:opacity-50 cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-tt-cyan"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={submitting}
            className="flex-1 min-h-[60px] rounded-2xl bg-tt-cyan text-black text-lg font-semibold hover:bg-tt-cyan/90 active:scale-[0.98] transition disabled:opacity-60 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
          >
            {submitting ? 'Saving…' : 'Confirm'}
          </button>
        </div>
      </div>
    </div>
  );
}

function ResultScreen({ ok, message, onDismiss }: { ok: boolean; message: string; onDismiss: () => void }) {
  return (
    <button
      type="button"
      onClick={onDismiss}
      className="w-full max-w-md flex flex-col items-center gap-6 text-center cursor-pointer focus-visible:outline-none"
    >
      <span
        className={`w-24 h-24 rounded-full flex items-center justify-center ${
          ok ? 'bg-tt-green/15 text-tt-green' : 'bg-tt-red/15 text-tt-red'
        }`}
      >
        {ok ? (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" className="w-12 h-12" aria-hidden="true"><polyline points="20 6 9 17 4 12" /></svg>
        ) : (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" className="w-12 h-12" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
        )}
      </span>
      <p className="text-2xl font-semibold text-tt-text">{message}</p>
      <p className="text-sm text-tt-muted">Tap anywhere to continue</p>
    </button>
  );
}
