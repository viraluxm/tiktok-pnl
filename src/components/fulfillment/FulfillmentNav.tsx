'use client';

/**
 * Shared owner-side fulfillment sub-nav, rendered on every /pickpack/* page.
 * Reached from the "Fulfillment" tab on the dashboard. Points ONLY at owner surfaces —
 * never /pick or /pack (those are device-gated and bounce owner sessions).
 * Worker KPIs is shown only when the current store is allowlisted (kpiAllowlisted).
 */

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const ITEMS: { href: string; label: string }[] = [
  { href: '/pickpack', label: 'Buy Labels' },
  { href: '/pickpack/settings', label: 'Settings & Barcodes' },
];

export default function FulfillmentNav({ kpiOn = false }: { kpiOn?: boolean }) {
  const pathname = usePathname();
  const items = kpiOn ? [...ITEMS, { href: '/pickpack/kpis', label: 'Worker KPIs' }] : ITEMS;

  return (
    <nav className="flex items-center gap-2 mb-6 flex-wrap">
      {items.map((it) => {
        const active = pathname === it.href;
        return (
          <Link
            key={it.href}
            href={it.href}
            className={`px-4 py-2 rounded-lg border text-sm font-medium transition-all ${
              active
                ? 'bg-tt-cyan text-black border-tt-cyan font-semibold'
                : 'border-tt-border text-tt-muted hover:bg-tt-card-hover'
            }`}
          >
            {it.label}
          </Link>
        );
      })}
      <Link href="/dashboard" className="ml-auto px-4 py-2 rounded-lg border border-tt-border text-tt-muted text-sm hover:bg-tt-card-hover transition-all">
        ← Dashboard
      </Link>
    </nav>
  );
}
