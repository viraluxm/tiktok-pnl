import { laWallTimeToUtc, addDaysISO } from './timezone';

// Host LIVE-session hours for one host on one Pacific day — a second signal beside clocked hours
// (display/review only, never pay). The hard requirement is distinguishing "no data" from "zero".
//
// Reliability (per the Phase-0 decision): an OBSERVED end is reliable, an INFERRED/cron end is not.
export const RELIABLE_END_SOURCES = new Set(['live_ended', 'manual_recovery', 'tab_closed']);
// (unreliable, excluded from the sum: 'auto_ender', 'cleanup_backfill', null — cron guesses,
//  where the 44.6h auto_ender session lives.)

export type LiveHoursState =
  | 'known' // reliable sessions → summed (union of wall-clock)
  | 'insufficient' // only unreliable sessions → not a number
  | 'not_attributed' // no host sessions, but NULL-host sessions exist that day (host may be on one)
  | 'zero'; // no host sessions and none unattributed → genuinely 0 (the only case zero means zero)

export interface LiveHoursResult {
  state: LiveHoursState;
  hours?: number; // when 'known'
  excludedUnreliable?: number; // when 'known' — unreliable host sessions left out of the sum
  unreliableCount?: number; // when 'insufficient'
}

export interface SessionLite {
  host_id: string | null;
  status: string; // 'ended' | 'live'
  started_at: string | null;
  ended_at: string | null;
  end_source: string | null;
}

// A session is USABLE only if ended with both instants. status='live' (orphan/in-progress) is
// excluded entirely — we never compute a duration against now() for a session nobody closed.
function usable(s: SessionLite): boolean {
  return s.status === 'ended' && !!s.started_at && !!s.ended_at;
}

// Merge overlapping [start,end] ms intervals and return total covered length (union, not sum) —
// so concurrent/overlapping sessions for one host never show more hours than the day holds.
function unionMs(intervals: [number, number][]): number {
  const sorted = intervals.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  let total = 0;
  let curStart: number | null = null;
  let curEnd = 0;
  for (const [a, b] of sorted) {
    if (curStart === null) {
      curStart = a;
      curEnd = b;
    } else if (a > curEnd) {
      total += curEnd - curStart; // flush the completed run
      curStart = a;
      curEnd = b;
    } else if (b > curEnd) {
      curEnd = b; // extend the current run
    }
  }
  if (curStart !== null) total += curEnd - curStart;
  return total;
}

export function liveHoursForHostDate(sessions: SessionLite[], hostId: string, dateISO: string): LiveHoursResult {
  const dayStart = laWallTimeToUtc(dateISO, '00:00').getTime();
  const dayEnd = laWallTimeToUtc(addDaysISO(dateISO, 1), '00:00').getTime(); // next Pacific midnight
  const intersectsDay = (s: SessionLite) =>
    usable(s) && Date.parse(s.started_at as string) < dayEnd && Date.parse(s.ended_at as string) > dayStart;

  const forHost = sessions.filter((s) => s.host_id === hostId && intersectsDay(s));
  const reliable = forHost.filter((s) => RELIABLE_END_SOURCES.has(s.end_source ?? ''));

  if (reliable.length > 0) {
    // Clip each reliable session to the Pacific day, then union.
    const clipped = reliable.map((s): [number, number] => [
      Math.max(Date.parse(s.started_at as string), dayStart),
      Math.min(Date.parse(s.ended_at as string), dayEnd),
    ]);
    return {
      state: 'known',
      hours: unionMs(clipped) / 3_600_000,
      excludedUnreliable: forHost.length - reliable.length,
    };
  }

  if (forHost.length > 0) {
    // Host has sessions that day, but all unreliable → not a trustworthy number.
    return { state: 'insufficient', unreliableCount: forHost.length };
  }

  // No sessions for this host that day. If any NULL-host session exists that day, the host may be
  // on one → "not attributed". Otherwise (everything attributed to others, or no sessions at all)
  // zero is a real finding.
  const nullHostThatDay = sessions.some((s) => s.host_id == null && intersectsDay(s));
  return nullHostThatDay ? { state: 'not_attributed' } : { state: 'zero' };
}

// Short display string for a resolved result (host time-clock rows).
export function formatLiveHours(r: LiveHoursResult): string {
  switch (r.state) {
    case 'known': {
      const h = (Math.round((r.hours ?? 0) * 10) / 10).toFixed(1);
      const ex = r.excludedUnreliable ? ` (${r.excludedUnreliable} excluded, unreliable end)` : '';
      const prefix = r.excludedUnreliable ? '≥' : '';
      return `live ${prefix}${h}h${ex}`;
    }
    case 'insufficient':
      return `live: insufficient data (${r.unreliableCount} session${r.unreliableCount === 1 ? '' : 's'}, unreliable end times)`;
    case 'not_attributed':
      return 'live: not attributed';
    case 'zero':
      return 'live 0.0h';
  }
}
