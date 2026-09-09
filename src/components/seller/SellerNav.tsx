'use client';

import Link from 'next/link';

// Nav for the confined /seller pages. A fixed three-item set: unlike MemberNav there are no
// per-account scopes to filter on — every seller reaches exactly these pages, and middleware
// (SELLER_CONFINEMENT) is the real gate. Nothing here links out of /seller, because nothing
// outside it is reachable: our dashboard, Team, payroll, admin and assistant are all 403/redirect
// for this role. Rendering a link to any of them would only produce a bounce.
const NAV_ITEMS = [
  { id: 'shop', href: '/seller', label: 'My shop' },
  { id: 'inventory', href: '/seller/inventory', label: 'Inventory' },
  { id: 'labels', href: '/seller/labels', label: 'Labels' },
] as const;

export type SellerTab = (typeof NAV_ITEMS)[number]['id'];

export default function SellerNav({ active }: { active: SellerTab }) {
  return (
    <nav className="mb-6 flex flex-wrap gap-1">
      {NAV_ITEMS.map((i) => (
        <Link
          key={i.id}
          href={i.href}
          className={
            i.id === active
              ? 'px-3 py-1.5 rounded-lg text-xs font-semibold bg-tt-cyan/15 text-tt-cyan border border-tt-cyan/30'
              : 'px-3 py-1.5 rounded-lg text-xs font-medium text-tt-muted border border-tt-border hover:text-tt-cyan hover:border-tt-cyan/40 transition-colors'
          }
        >
          {i.label}
        </Link>
      ))}
    </nav>
  );
}
