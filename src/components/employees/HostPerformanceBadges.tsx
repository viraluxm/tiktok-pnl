'use client';

import type { HostAgg } from '@/hooks/useHostPerformance';

// Minimum attributed auctions (per window) before a badge shows a percentage.
// Below this, a badge reads "No data yet" / "Building…" and NEVER the red
// probation state — a thin sample must not trigger probation.
const MIN_AUCTIONS = 40;

// Below-break-even rate at/above which the host is in the performance-probation
// state (red). A const so it's trivial to tune.
// TODO: this may become store-relative later (Snore baseline ~12% vs
// lots-of-steals ~8%), rather than one global 20% line.
const PROBATION_THRESHOLD = 0.20;
const BE_GREEN_MAX = 0.12; // below this = healthy (green); [0.12, 0.20) = amber

// ASP-goal hit rate at/above which the host clears the bonus bar (green).
const ASP_BONUS_BAR = 0.35;

type Tone = 'green' | 'amber' | 'red' | 'neutral';

const TONE_CLASS: Record<Tone, string> = {
  green: 'bg-tt-green/15 text-tt-green',
  amber: 'bg-tt-yellow/15 text-tt-yellow',
  red: 'bg-tt-red/15 text-tt-red',
  neutral: 'bg-tt-muted/15 text-tt-muted',
};

function Badge({ text, tone, title }: { text: string; tone: Tone; title: string }) {
  return (
    <span title={title} className={`inline-block text-[10px] font-semibold px-2 py-1 rounded-md tabular-nums ${TONE_CLASS[tone]}`}>
      {text}
    </span>
  );
}

function pct(n: number): string {
  return `${(n * 100).toFixed(0)}%`;
}

// "No data yet" when nothing is attributed; "Building…" once some auctions have
// accrued but the window is still under MIN_AUCTIONS.
function thinLabel(n: number): string {
  return n === 0 ? 'No data yet' : 'Building…';
}

export function AspHitBadge({ agg }: { agg?: HostAgg }) {
  const title = 'Bonus bar 35% (team baseline ~30%)';
  const n = agg?.asp7_n ?? 0;
  if (n < MIN_AUCTIONS) return <Badge text={thinLabel(n)} tone="neutral" title={title} />;
  const rate = (agg!.asp7_hits) / n;
  return <Badge text={pct(rate)} tone={rate >= ASP_BONUS_BAR ? 'green' : 'neutral'} title={title} />;
}

export function BelowBreakEvenBadge({ agg }: { agg?: HostAgg }) {
  const title = 'Probation trigger 20%';
  const n = agg?.be14_n ?? 0;
  // Guard: thin sample never shows a percentage and NEVER the red probation state.
  if (n < MIN_AUCTIONS) return <Badge text={thinLabel(n)} tone="neutral" title={title} />;
  const rate = (agg!.be14_below) / n;
  const tone: Tone = rate < BE_GREEN_MAX ? 'green' : rate < PROBATION_THRESHOLD ? 'amber' : 'red';
  return <Badge text={pct(rate)} tone={tone} title={title} />;
}
