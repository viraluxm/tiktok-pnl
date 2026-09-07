'use client';

import { useState } from 'react';
import ShippingTab from './ShippingTab';
import LabelsPanel from './LabelsPanel';

// Subtab shell for the Shipping tab, mirroring InventoryTabs.
//
// A wrapper rather than a change inside ShippingTab: that file owns the packing station —
// fullscreen entry, the scanner overlay, the picked-today counter — and buying labels shares
// none of it. Threading a tab through it would entangle a screen that is open for whole shifts
// with one that is used for a few minutes a day.
//
// The station stays the DEFAULT for that reason: whoever opens Shipping is usually about to
// pack, and it is the tab that must never take an extra click. Fullscreen hides this bar
// anyway, so the station experience is unchanged once scanning starts.

type SubTab = 'station' | 'labels';

const TABS: { value: SubTab; label: string }[] = [
  { value: 'station', label: 'Pack station' },
  { value: 'labels', label: 'Labels' },
];

export default function ShippingTabs() {
  const [tab, setTab] = useState<SubTab>('station');

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

      {/* Both stay mounted-on-demand and own their own data, as the Inventory subtabs do. */}
      {tab === 'station' ? <ShippingTab /> : <LabelsPanel />}
    </div>
  );
}
