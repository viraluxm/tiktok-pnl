'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { parseNav, formatNav, type NavState } from './navState';

export { parseNav, formatNav } from './navState';
export type { NavState, Tab, Segment } from './navState';

// Navigation is client-side through the History API (no server round trip per tap): Next's App
// Router keeps useSearchParams in sync with pushState/replaceState. Tab and segment changes PUSH
// (back returns to the previous tab); week and day selection REPLACE (a tap on a day is not a
// history entry anyone wants to back through).

function readLocation(): NavState {
  if (typeof window === 'undefined') return { tab: 'home', seg: 'mine', week: null, day: null, period: null };
  return parseNav(new URLSearchParams(window.location.search));
}

/**
 * The portal's navigation state, read from and written to the URL. `initial` is the server-parsed
 * state for the first render (so SSR and the first client paint agree); afterwards the URL wins.
 */
export function usePortalNav(initial: NavState) {
  const [state, setState] = useState<NavState>(initial);
  // The latest committed state, for `go` to build on. Kept in a ref so the History API call happens
  // in the event handler itself — never inside a setState updater, which React runs during render
  // (Next's router listens to pushState and would then update mid-render).
  const latest = useRef(state);
  useEffect(() => { latest.current = state; }, [state]);

  useEffect(() => {
    const onPop = () => setState(readLocation());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const go = useCallback((patch: Partial<NavState>, mode: 'push' | 'replace' = 'push') => {
    const next: NavState = { ...latest.current, ...patch };
    // Leaving Schedule resets its segment; changing week clears an explicit day.
    if (patch.tab && patch.tab !== 'schedule' && !patch.seg) next.seg = 'mine';
    if (patch.week !== undefined && patch.day === undefined) next.day = null;
    // Leaving Hours drops the historical period, so returning to it lands on the current one.
    if (patch.tab && patch.tab !== 'hours' && patch.period === undefined) next.period = null;
    const url = `${window.location.pathname}${formatNav(next)}`;
    if (mode === 'push') window.history.pushState(null, '', url);
    else window.history.replaceState(null, '', url);
    latest.current = next;
    setState(next);
  }, []);

  return { nav: state, go };
}
