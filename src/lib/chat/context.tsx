'use client';

import { createContext, useContext, useMemo, useState, useCallback, type ReactNode } from 'react';

// Page context for the admin chat assistant.
//
// Why a context and not usePathname(): the dashboard's "tabs" are NOT routes. Every
// one of them lives at /dashboard and is switched by React state — RealDashboard
// holds `activeView` (ViewTab) and EmployeesTab holds its own `subView`. So when an
// admin is looking at Shifts, the URL still reads /dashboard and the pathname tells
// us nothing. The tab components publish what they're showing into this context and
// the widget reads it.
//
// This carries NO data — only which view is open and the active date filter. The
// answer itself always comes from the owner-scoped tools on the server, never from
// whatever the client claims. Treat everything here as a UI hint: it steers the
// greeting and the model's framing, and it must never be used for access control.

export type ChatTab =
  | 'dashboard' | 'pnl' | 'inventory' | 'shows' | 'shipping' | 'employees';

export interface ChatPageContext {
  tab: ChatTab | null;
  /** Sub-view within a tab (e.g. Team → 'roster' | 'shifts' | 'pay' | 'performance'). */
  subView: string | null;
  dateFrom: string | null;
  dateTo: string | null;
}

const EMPTY: ChatPageContext = { tab: null, subView: null, dateFrom: null, dateTo: null };

interface Store {
  context: ChatPageContext;
  setContext: (patch: Partial<ChatPageContext>) => void;
}

const Ctx = createContext<Store>({ context: EMPTY, setContext: () => {} });

export function ChatContextProvider({ children }: { children: ReactNode }) {
  const [context, setState] = useState<ChatPageContext>(EMPTY);

  // Merge-patch so a tab can publish just its slice (e.g. EmployeesTab owns
  // `subView` and knows nothing about the date filter above it).
  const setContext = useCallback((patch: Partial<ChatPageContext>) => {
    setState((prev) => {
      const next = { ...prev, ...patch };
      // Bail out when nothing actually changed. Both publishers call this from an
      // effect keyed on their own state, and returning a fresh object every time
      // would re-render every consumer of this context on each parent render.
      if (
        next.tab === prev.tab && next.subView === prev.subView &&
        next.dateFrom === prev.dateFrom && next.dateTo === prev.dateTo
      ) return prev;
      return next;
    });
  }, []);

  const value = useMemo(() => ({ context, setContext }), [context, setContext]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useChatContext() {
  return useContext(Ctx);
}

/** Human-readable label for the view an admin is looking at. */
export function describeView(c: ChatPageContext): string | null {
  if (!c.tab) return null;
  if (c.tab === 'employees') {
    const sub: Record<string, string> = {
      roster: 'Team → Roster', shifts: 'Team → Shifts',
      pay: 'Team → Pay', performance: 'Team → Performance',
    };
    return sub[c.subView ?? ''] ?? 'Team';
  }
  const label: Record<string, string> = {
    dashboard: 'Dashboard', pnl: 'P&L', inventory: 'Inventory',
    shows: 'Shows', shipping: 'Shipping',
  };
  return label[c.tab] ?? null;
}

/** Tab-specific opening line, so the widget greets in context. */
export function greetingFor(c: ChatPageContext): string {
  switch (c.tab) {
    case 'employees':
      if (c.subView === 'shifts') return 'Hey! What questions or concerns do you have about shifts?';
      if (c.subView === 'pay') return 'Hey! Questions about pay or this pay period?';
      if (c.subView === 'performance') return 'Hey! Want to dig into picker or host performance?';
      return 'Hey! Questions about the team or roster?';
    case 'pnl': return 'Hey! What would you like to know about P&L?';
    case 'inventory': return 'Hey! Questions about stock or reorders?';
    case 'shows': return 'Hey! What would you like to know about your shows?';
    case 'shipping': return 'Hey! Questions about fulfillment or shipping?';
    case 'dashboard': return 'Hey! What would you like to know about the business?';
    default: return 'Hey! What can I help you with?';
  }
}
