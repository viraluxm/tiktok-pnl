'use client';

import { useState } from 'react';
import InventorySection from './InventorySection';
import MappingSection from './MappingSection';

// Subtab shell for the Inventory tab.
//
// A wrapper rather than a change inside InventorySection: that file is ~1,350 lines of SKU
// and cost-layer logic that has nothing to say about where stock physically lives, and
// threading a tab through it would only entangle the two. Both panels stay mounted-on-demand
// and own their own data.

type SubTab = 'skus' | 'mapping';

const TABS: { value: SubTab; label: string }[] = [
  { value: 'skus', label: 'SKUs' },
  { value: 'mapping', label: 'Mapping' },
];

export default function InventoryTabs() {
  const [tab, setTab] = useState<SubTab>('skus');

  return (
    <div>
      <div className="mb-4 flex gap-1 border-b border-tt-border">
        {TABS.map((t) => (
          <button
            key={t.value}
            onClick={() => setTab(t.value)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors cursor-pointer ${
              tab === t.value
                ? 'border-tt-green text-tt-text'
                : 'border-transparent text-tt-muted hover:text-tt-text'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'skus' ? <InventorySection /> : <MappingSection />}
    </div>
  );
}
