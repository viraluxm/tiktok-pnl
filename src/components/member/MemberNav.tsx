'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';

// Small nav shared by the confined /team member pages. It links ONLY to the scopes the signed-in
// member actually holds — read from their own app_metadata.scopes via the browser session (the same
// getUser pattern as useUser; it reads the existing session, never establishes one). Middleware is
// still the real gate; this just avoids showing a member a tab they'd be 403'd from.
const NAV_ITEMS: Array<{ scope: string; href: string; label: string }> = [
  { scope: 'binding', href: '/team/binding', label: 'Binding' },
  { scope: 'inventory', href: '/team/inventory', label: 'Inventory' },
  { scope: 'pnl', href: '/team/pnl', label: 'P&L' },
  { scope: 'shows', href: '/team/shows', label: 'Shows' },
];

export default function MemberNav({ active }: { active: 'binding' | 'inventory' | 'pnl' | 'shows' }) {
  const [scopes, setScopes] = useState<string[] | null>(null);

  useEffect(() => {
    const supabase = createClient();
    let alive = true;
    supabase.auth.getUser().then(({ data }) => {
      if (!alive) return;
      const raw = (data.user?.app_metadata as { scopes?: unknown } | undefined)?.scopes;
      setScopes(Array.isArray(raw) ? raw.map(String) : []);
    });
    return () => { alive = false; };
  }, []);

  // Until scopes load, show only the current tab so links the member may not hold never flash in.
  const items = NAV_ITEMS.filter((i) => (scopes == null ? i.scope === active : scopes.includes(i.scope)));

  return (
    <nav className="mb-6 flex flex-wrap gap-1">
      {items.map((i) => (
        <a
          key={i.scope}
          href={i.href}
          className={`px-4 py-1.5 rounded-full text-xs font-semibold transition-all ${
            i.scope === active ? 'bg-tt-cyan text-black' : 'bg-tt-card-hover text-tt-muted hover:text-tt-text'
          }`}
        >
          {i.label}
        </a>
      ))}
    </nav>
  );
}
