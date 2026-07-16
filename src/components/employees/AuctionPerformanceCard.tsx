'use client';

import { useState } from 'react';
import { fmt } from '@/lib/calculations';
import { useAuctionPerformance } from '@/hooks/useAuctionPerformance';

// Team-wide auction performance card (read-only). Realized price comes from
// capture_events; ASP goal = break-even × 3. Host split is not shown yet —
// live_sessions.host_id is not populated — so this is a single team-wide rollup.

const STORE_OPTIONS: { label: string; value: string }[] = [
  { label: 'All', value: 'all' },
  { label: 'Snore', value: '1d71a4c9-16b1-45f2-858e-64b41c548e9e' },
  { label: 'Lots of Steals', value: 'afd1c76e-1d92-4c7d-9edf-0468ae7aa3df' },
];

const WINDOW_OPTIONS = [7, 14, 21, 30];

function pctStr(n: number | null | undefined): string {
  return n == null ? '—' : `${(n * 100).toFixed(1)}%`;
}

// Below-break-even tone, RELATIVE to the store's baseline (not one global number):
//   green  — below baseline (healthy)
//   amber  — at/near baseline, up to ~1.3× (watch)
//   red    — well above baseline, > 1.3× (accountability alarm)
function belowBeTone(rate: number, baseline: number): 'green' | 'amber' | 'red' {
  if (rate < baseline) return 'green';
  if (rate <= baseline * 1.3) return 'amber';
  return 'red';
}

const TONE: Record<'green' | 'amber' | 'red' | 'neutral', { value: string; ring: string }> = {
  green: { value: 'text-tt-green', ring: 'border-tt-green/30' },
  amber: { value: 'text-tt-yellow', ring: 'border-tt-yellow/30' },
  red: { value: 'text-tt-red', ring: 'border-tt-red/40' },
  neutral: { value: 'text-tt-text', ring: 'border-tt-border' },
};

function StatTile({
  label, value, count, tone = 'neutral', caption,
}: {
  label: string;
  value: string;
  count?: string;
  tone?: 'green' | 'amber' | 'red' | 'neutral';
  caption?: string;
}) {
  const t = TONE[tone];
  return (
    <div className={`flex-1 min-w-[9rem] bg-white/[0.03] border ${t.ring} rounded-xl px-4 py-4`}>
      <div className="text-[11px] text-tt-muted uppercase tracking-wide">{label}</div>
      <div className={`mt-1.5 text-2xl font-semibold tabular-nums ${t.value}`}>{value}</div>
      {count && <div className="text-[11px] text-tt-muted mt-1 tabular-nums">{count}</div>}
      {caption && <div className="text-[11px] text-tt-muted mt-2 leading-snug">{caption}</div>}
    </div>
  );
}

export default function AuctionPerformanceCard() {
  const [store, setStore] = useState('all');
  const [days, setDays] = useState(21);
  const { data, isLoading, isError } = useAuctionPerformance(store, days);

  const beTone = data ? belowBeTone(data.below_breakeven_rate, data.below_breakeven_baseline) : 'neutral';

  return (
    <div className="bg-tt-card border border-tt-border rounded-[14px] backdrop-blur-xl overflow-hidden">
      <div className="px-6 py-5 border-b border-tt-border">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-tt-text">Auction Performance</h2>
            <p className="text-xs text-tt-muted mt-1 max-w-xl">
              Team-wide, last {days} days. Realized sale price vs. the 3× ASP goal.
              Hitting the goal is the <span className="text-tt-text">bonus lever</span> — aspirational,
              only ~30% of auctions clear it. Selling below break-even is the{' '}
              <span className="text-tt-text">accountability lever</span>.
            </p>
          </div>
          {/* Store toggle — re-runs the window against that store's data + baseline. */}
          <div className="flex gap-1 bg-white/5 rounded-lg p-0.5 shrink-0">
            {STORE_OPTIONS.map((o) => (
              <button
                key={o.value}
                onClick={() => setStore(o.value)}
                className={`px-3 py-1.5 rounded-md text-xs font-semibold transition-colors ${
                  store === o.value ? 'bg-white/10 text-tt-text' : 'text-tt-muted hover:text-tt-text'
                }`}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>
        {/* Rolling-window selector. */}
        <div className="flex items-center gap-1 mt-3">
          <span className="text-[11px] text-tt-muted uppercase tracking-wide mr-1">Window</span>
          {WINDOW_OPTIONS.map((d) => (
            <button
              key={d}
              onClick={() => setDays(d)}
              className={`px-2.5 py-1 rounded-md text-[11px] font-semibold transition-colors ${
                days === d ? 'bg-white/10 text-tt-text' : 'text-tt-muted hover:text-tt-text'
              }`}
            >
              {d}d
            </button>
          ))}
        </div>
      </div>

      <div className="px-6 py-5">
        {isLoading ? (
          <p className="text-sm text-tt-muted py-8 text-center">Loading…</p>
        ) : isError ? (
          <p className="text-sm text-tt-red py-8 text-center">Failed to load auction performance.</p>
        ) : !data || data.sample_size === 0 ? (
          <p className="text-sm text-tt-muted py-8 text-center">No sold auctions in this window.</p>
        ) : (
          <>
            <div className="flex flex-wrap gap-3">
              <StatTile
                label="ASP Goal Hit — bonus target"
                value={pctStr(data.asp_hit_rate)}
                count={`${data.counts.asp_hit} of ${data.sample_size}`}
                caption="Team baseline ~30% — stretch/bonus target, not a floor."
              />
              <StatTile
                label="Below Break-even — loss"
                value={pctStr(data.below_breakeven_rate)}
                count={`${data.counts.below_breakeven} of ${data.sample_size}`}
                tone={beTone}
                caption={`Store baseline ~${(data.below_breakeven_baseline * 100).toFixed(0)}%. Red = above baseline.`}
              />
              <StatTile
                label="Thin Margin"
                value={pctStr(data.thin_margin_rate)}
                count={`${data.counts.thin_margin} of ${data.sample_size}`}
                caption="At/above break-even but under the 3× goal."
              />
            </div>

            <div className="flex flex-wrap gap-x-8 gap-y-2 mt-5 text-[13px]">
              <div>
                <span className="text-tt-muted">Median final price: </span>
                <span className="text-tt-text tabular-nums font-medium">
                  {data.median_final_price_cents == null ? '—' : fmt(data.median_final_price_cents / 100)}
                </span>
              </div>
              <div>
                <span className="text-tt-muted">Median % of goal reached: </span>
                <span className="text-tt-text tabular-nums font-medium">{pctStr(data.median_pct_of_goal)}</span>
              </div>
              <div>
                <span className="text-tt-muted">Auctions in window: </span>
                <span className="text-tt-text tabular-nums font-medium">{data.sample_size}</span>
              </div>
            </div>

            <p className="text-[11px] text-tt-muted mt-4">
              Host breakdown coming once live sessions carry a host — today this is the whole team combined.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
