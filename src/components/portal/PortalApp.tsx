'use client';

import { useEffect, useMemo, useState } from 'react';
import type { AvailableItem, PortalShift, PortalTeamShift } from '@/lib/schedule/portalTypes';
import { actionCount } from '@/lib/schedule/portalModel';
import { useSnapshot } from './PortalProvider';
import { usePortalNav, type NavState, type Tab } from './nav';
import { HomeScreen } from './HomeScreen';
import { ScheduleScreen, PickupSheet } from './ScheduleScreen';
import { RequestsScreen } from './RequestsScreen';
import { TimecardScreen } from './TimecardScreen';
import { ShiftSheet } from './ShiftSheet';
import { TradeFlow } from './TradeFlow';
import { Sheet, FactBox, Button, Skeleton, ErrorState, Avatar } from './ui';
import { HomeIcon, CalendarIcon, InboxIcon } from './icons';
import { fmtRangeLA, fmtShortDate, relativeDayLabel, roleLabel, fmtHours } from '@/lib/schedule/portalModel';

// The employee app shell: three destinations (Home · Schedule · Requests), a fixed bottom bar on
// phones that becomes a top bar from md up, and the sheets that any screen can open.

const NAV: { tab: Tab; label: string; Icon: typeof HomeIcon }[] = [
  { tab: 'home', label: 'Home', Icon: HomeIcon },
  { tab: 'schedule', label: 'Schedule', Icon: CalendarIcon },
  { tab: 'requests', label: 'Requests', Icon: InboxIcon },
];

function NavBar({ tab, badge, go, variant }: { tab: Tab; badge: number; go: (p: Partial<NavState>) => void; variant: 'bottom' | 'top' }) {
  const active = tab === 'hours' ? 'home' : tab;
  return (
    <nav
      aria-label="Main"
      className={
        variant === 'bottom'
          ? 'fixed inset-x-0 bottom-0 z-40 border-t border-tt-border bg-[rgba(15,15,15,0.92)] pb-[env(safe-area-inset-bottom)] backdrop-blur-xl md:hidden'
          : 'hidden md:flex md:items-center md:gap-1 md:rounded-2xl md:bg-white/[0.06] md:p-1'
      }
    >
      <div className={variant === 'bottom' ? 'mx-auto grid max-w-md grid-cols-3' : 'flex gap-1'}>
        {NAV.map(({ tab: t, label, Icon }) => {
          const on = active === t;
          return (
            <button
              key={t}
              type="button"
              onClick={() => go({ tab: t })}
              aria-current={on ? 'page' : undefined}
              className={
                variant === 'bottom'
                  ? `relative flex min-h-[56px] flex-col items-center justify-center gap-0.5 px-2 pt-1.5 text-[11px] font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-tt-cyan/70 ${on ? 'text-tt-cyan' : 'text-tt-muted hover:text-tt-text'}`
                  : `relative flex min-h-10 items-center gap-2 rounded-xl px-4 text-sm font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-tt-cyan/70 ${on ? 'bg-white/10 text-tt-text' : 'text-tt-muted hover:text-tt-text'}`
              }
            >
              <span className="relative">
                <Icon size={variant === 'bottom' ? 22 : 18} />
                {t === 'requests' && badge > 0 && (
                  <span className="absolute -right-2 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-tt-cyan px-1 text-[10px] font-bold text-black" aria-label={`${badge} waiting for you`}>
                    {badge}
                  </span>
                )}
              </span>
              <span>{label}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}

export function PortalApp({ initialNav }: { initialNav: NavState }) {
  const { nav, go } = usePortalNav(initialNav);
  const snap = useSnapshot();
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  const [openShift, setOpenShift] = useState<PortalShift | null>(null);
  const [pick, setPick] = useState<AvailableItem | null>(null);
  const [coworker, setCoworker] = useState<{ s: PortalTeamShift; a: AvailableItem | null } | null>(null);
  const [trade, setTrade] = useState<{ start: PortalShift | null; prefer: string | null } | null>(null);

  // Keep the open sheet's shift fresh after a refetch (a Drop flips offer_state under it).
  const liveOpenShift = useMemo(() => {
    if (!openShift || !snap.data) return openShift;
    return snap.data.upcoming.find((s) => s.id === openShift.id) ?? openShift;
  }, [openShift, snap.data]);

  useEffect(() => { window.scrollTo({ top: 0 }); }, [nav.tab, nav.seg, nav.period]);

  if (snap.error && !snap.data) {
    return (
      <div className="mx-auto max-w-md px-4 pt-16">
        <ErrorState message={(snap.error as Error).message || 'Could not load your schedule.'} onRetry={() => snap.refetch()} busy={snap.isFetching} />
      </div>
    );
  }
  // NO DATA YET — for ANY reason, not only `isLoading`. React Query also reports fetchStatus
  // 'paused' (isLoading false, data undefined) when it decides it cannot fetch right now, and the
  // old `isLoading && !snap.data` guard fell straight through that into `snap.data!` and crashed
  // the whole app. Production seeds initialSnapshot from the server so it never saw this; the
  // preview route, which has no seed, crashed on load. The skeleton is the honest answer to
  // "nothing to show yet", whatever the reason — and `data` below is now non-null by narrowing,
  // not by assertion.
  if (!snap.data) {
    return (
      <div className="mx-auto max-w-md px-4 pt-8">
        <Skeleton className="h-4 w-32" /><Skeleton className="mt-2 h-8 w-64" />
        <Skeleton className="mt-8 h-40" /><Skeleton className="mt-6 h-16" /><Skeleton className="mt-8 h-20" />
      </div>
    );
  }
  const data = snap.data;
  const badge = actionCount(data);
  const goAvailable = () => go({ tab: 'schedule', seg: 'open' });

  return (
    <div className="portal-root min-h-dvh bg-tt-bg text-tt-text">
      <div className="mx-auto w-full max-w-md px-4 pb-[calc(env(safe-area-inset-bottom)+92px)] pt-[calc(env(safe-area-inset-top)+16px)] md:max-w-2xl md:px-6 md:pb-12 md:pt-6 lg:max-w-4xl">
        <div className="mb-6 hidden items-center justify-between md:flex">
          <div className="flex items-center gap-2.5">
            <Avatar name={data.employee.name} size="sm" />
            <span className="text-sm font-semibold text-tt-text">{data.employee.name}</span>
            <span className="text-sm text-tt-muted">· {roleLabel(data.employee.role)}</span>
          </div>
          <NavBar tab={nav.tab} badge={badge} go={go} variant="top" />
        </div>

        <main>
          {nav.tab === 'home' && (
            <HomeScreen snap={data} nav={nav} go={go} nowMs={nowMs} onOpenShift={setOpenShift} onOpenAvailable={goAvailable} />
          )}
          {nav.tab === 'schedule' && (
            <ScheduleScreen snap={data} nav={nav} go={go} nowMs={nowMs} onOpenShift={setOpenShift} onPick={setPick} onCoworker={(s, a) => setCoworker({ s, a })} />
          )}
          {nav.tab === 'requests' && <RequestsScreen snap={data} />}
          {nav.tab === 'hours' && <TimecardScreen snap={data} nav={nav} go={go} onBack={() => go({ tab: 'home' })} />}
        </main>
        {snap.isError && snap.data && (
          <p role="status" className="mt-6 text-center text-[12px] text-tt-muted">Showing the last loaded schedule — could not refresh.</p>
        )}
      </div>

      <NavBar tab={nav.tab} badge={badge} go={go} variant="bottom" />

      <ShiftSheet
        shift={liveOpenShift}
        todayISO={data.todayISO}
        nowMs={nowMs}
        open={!!openShift}
        onClose={() => setOpenShift(null)}
        onRequestTrade={(s) => setTrade({ start: s, prefer: null })}
      />
      <PickupSheet item={pick} today={data.todayISO} open={!!pick} onClose={() => setPick(null)} />
      {trade && (
        <TradeFlow
          open
          onClose={() => setTrade(null)}
          myShifts={data.upcoming}
          startShift={trade.start}
          preferCoworkerName={trade.prefer}
          todayISO={data.todayISO}
          nowMs={nowMs}
        />
      )}
      <Sheet open={!!coworker} onClose={() => setCoworker(null)} title={coworker?.s.name ?? ''}>
        {coworker && (
          <>
            <FactBox>
              <p className="text-[11px] font-semibold uppercase tracking-wider text-tt-muted">{relativeDayLabel(coworker.a?.shift_date ?? coworker.s.starts_at.slice(0, 10), data.todayISO)} · {fmtShortDate(coworker.a?.shift_date ?? coworker.s.starts_at.slice(0, 10))}</p>
              <p className="mt-0.5 text-2xl font-semibold tabular-nums tracking-tight text-tt-text">{fmtRangeLA(coworker.s.starts_at, coworker.s.ends_at)}</p>
              <p className="mt-0.5 text-[13px] text-tt-muted">{roleLabel(coworker.s.role)}{coworker.s.role ? ' · ' : ''}{fmtHours(coworker.s.hours)}</p>
            </FactBox>
            {coworker.s.offered && (
              <p className="mb-3 text-[13px] leading-snug text-tt-text">
                {coworker.s.name.split(' ')[0]} offered this shift. {coworker.a && !coworker.a.refusal && !coworker.a.requested ? 'You can request to pick it up; a manager approves.' : coworker.a?.requested ? 'You already requested it.' : coworker.a?.refusal ?? 'It is not open to you.'}
              </p>
            )}
            <div className="flex flex-col gap-2">
              {coworker.s.offered && coworker.a && !coworker.a.refusal && !coworker.a.requested && (
                <Button variant="primary" size="lg" full onClick={() => { const a = coworker.a; setCoworker(null); setPick(a); }}>Pick Up Shift</Button>
              )}
              {!coworker.s.offered && (
                <Button variant="quiet" size="lg" full onClick={() => { const name = coworker.s.name; setCoworker(null); setTrade({ start: null, prefer: name }); }}>
                  Trade one of my shifts with {coworker.s.name.split(' ')[0]}
                </Button>
              )}
              <Button variant="quiet" size="lg" full onClick={() => setCoworker(null)}>Close</Button>
            </div>
          </>
        )}
      </Sheet>
    </div>
  );
}
