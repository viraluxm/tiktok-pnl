'use client';

import { useState } from 'react';
import AuctionPerformanceCard from './AuctionPerformanceCard';
import FulfillmentPerformance from './FulfillmentPerformance';

// Team → Performance. Two worker types, kept strictly separate via a segmented selector:
//   • Live Hosts  → existing team-wide auction/host performance (AuctionPerformanceCard).
//   • Fulfillment → daily picker performance (Phase 1).
// Host and fulfillment metrics are never mixed on one view.
type Segment = 'hosts' | 'fulfillment';

export default function PerformanceView() {
  const [seg, setSeg] = useState<Segment>('fulfillment');

  return (
    <div>
      <div className="inline-flex rounded-lg border border-tt-border p-0.5 mb-5">
        {(['hosts', 'fulfillment'] as Segment[]).map((s) => (
          <button
            key={s}
            onClick={() => setSeg(s)}
            className={`min-h-[36px] px-4 py-1.5 rounded-md text-xs font-semibold transition-colors cursor-pointer ${
              seg === s ? 'bg-white/10 text-tt-text' : 'text-tt-muted hover:text-tt-text'
            }`}
          >
            {s === 'hosts' ? 'Live Hosts' : 'Fulfillment'}
          </button>
        ))}
      </div>

      {seg === 'hosts' && <AuctionPerformanceCard />}
      {seg === 'fulfillment' && <FulfillmentPerformance />}
    </div>
  );
}
