'use client';

import { useMemo } from 'react';
import type { PortalSnapshot, PortalWeek } from '@/lib/schedule/portalTypes';
import { createFetchPortalClient } from './client';
import { PortalProvider } from './PortalProvider';
import { PortalApp } from './PortalApp';
import type { NavState } from './nav';

// Client boundary for /s/[token]. The server page resolves the token, builds the first snapshot and
// week, and hands them here; this seeds React Query so the first paint is complete, then every
// later read goes through the fetch client against /s/[token]/portal/*.
export default function PortalRoot({
  token, initialSnapshot, initialWeek, initialNav,
}: {
  token: string;
  initialSnapshot: PortalSnapshot;
  initialWeek: PortalWeek;
  initialNav: NavState;
}) {
  const client = useMemo(() => createFetchPortalClient(token), [token]);
  return (
    <PortalProvider client={client} initialSnapshot={initialSnapshot} initialWeek={initialWeek}>
      <PortalApp initialNav={initialNav} />
    </PortalProvider>
  );
}
