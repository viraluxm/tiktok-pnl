// URL state for the portal — the PURE half (types + parse/format), importable from the server page
// as well as the client. The hook that binds it to the History API lives in nav.ts ('use client').
//
// Tabs, the schedule segment, the week and the selected day all live in the query string so a
// reload, a back-swipe or a share-with-self keeps the employee's place — and so the token never has
// to move out of the path it already lives in.

import { isValidDateISO, mondayOf } from '@/lib/schedule/portalModel';

export type Tab = 'home' | 'schedule' | 'requests' | 'hours';
export type Segment = 'mine' | 'team' | 'open';

export interface NavState {
  tab: Tab;
  seg: Segment;
  /** Monday of the shown week (Schedule and Home strip), or null = this week */
  week: string | null;
  /** selected day on the strip, or null = default */
  day: string | null;
  /**
   * On Hours: the START of a PAST pay period being read, or null = the current one. In the URL so
   * a back-swipe out of a historical period returns to the list rather than leaving the app.
   * Validated again on the server — this only decides which window the screen asks for.
   */
  period: string | null;
}

const TABS: Tab[] = ['home', 'schedule', 'requests', 'hours'];
const SEGS: Segment[] = ['mine', 'team', 'open'];

export function parseNav(params: URLSearchParams): NavState {
  const tab = params.get('tab');
  const seg = params.get('seg');
  const week = params.get('week');
  const day = params.get('day');
  const period = params.get('period');
  // Legacy links: ?view=team from the previous portal still lands on Team.
  const legacyTeam = params.get('view') === 'team';
  return {
    tab: (TABS as string[]).includes(tab ?? '') ? (tab as Tab) : legacyTeam ? 'schedule' : 'home',
    seg: (SEGS as string[]).includes(seg ?? '') ? (seg as Segment) : legacyTeam ? 'team' : 'mine',
    week: isValidDateISO(week) ? mondayOf(week) : null,
    day: isValidDateISO(day) ? day : null,
    // NOT snapped to a Monday: a pay-period start is a specific boundary of the biweekly cycle, and
    // the server refuses any date that is not one. Keeping it verbatim lets that refusal be the
    // single rule rather than having the client quietly round to a different period.
    period: isValidDateISO(period) ? period : null,
  };
}

export function formatNav(state: NavState): string {
  const p = new URLSearchParams();
  if (state.tab !== 'home') p.set('tab', state.tab);
  if (state.tab === 'schedule' && state.seg !== 'mine') p.set('seg', state.seg);
  if (state.week) p.set('week', state.week);
  if (state.day) p.set('day', state.day);
  if (state.tab === 'hours' && state.period) p.set('period', state.period);
  const s = p.toString();
  return s ? `?${s}` : '';
}
