'use client';

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PortalSnapshot, PortalWeek, TimecardPayload, TradeOptionsPayload } from '@/lib/schedule/portalTypes';
import type { PortalClient } from './client';
import { clockControlsMounted } from '@/app/s/[token]/clockActivity';

// React Query wiring for the portal. ONE snapshot query serves Home, Schedule and Requests; weeks
// and the timecard are their own queries; every mutation invalidates the whole `['portal', scope]`
// prefix, so a Drop Shift refreshes the strip, the list, the alerts and the badge together.
//
// CACHE KEYS carry `client.scopeKey` (the token). Two tokens opened in one browser can never read
// each other's cached data, and the preview route's 'preview' scope never collides with a real one.

interface Ctx {
  client: PortalClient;
  initialSnapshot?: PortalSnapshot;
  initialWeek?: PortalWeek;
}

const PortalContext = createContext<Ctx | null>(null);

export function PortalProvider({ client, initialSnapshot, initialWeek, children }: Ctx & { children: ReactNode }) {
  const value = useMemo(() => ({ client, initialSnapshot, initialWeek }), [client, initialSnapshot, initialWeek]);
  return <PortalContext.Provider value={value}>{children}</PortalContext.Provider>;
}

function useCtx(): Ctx {
  const c = useContext(PortalContext);
  if (!c) throw new Error('PortalProvider missing');
  return c;
}

export function usePortalClient(): PortalClient {
  return useCtx().client;
}

export const portalKey = (scope: string, ...rest: unknown[]) => ['portal', scope, ...rest] as const;

// Low-frequency self-heal (the old ScheduleAutoRefresh): a shift added after load surfaces on its
// own. Never while a clock control is mounted — the QR sheet and an in-flight punch live inside it.
const SNAPSHOT_REFRESH_MS = 120_000;

export function useSnapshot() {
  const { client, initialSnapshot } = useCtx();
  return useQuery<PortalSnapshot>({
    queryKey: portalKey(client.scopeKey, 'snapshot'),
    queryFn: () => client.getSnapshot(),
    initialData: initialSnapshot,
    initialDataUpdatedAt: initialSnapshot ? Date.parse(initialSnapshot.generatedAt) : undefined,
    staleTime: 30_000,
    refetchInterval: (q) => (typeof document !== 'undefined' && document.visibilityState === 'visible' && !clockControlsMounted() && !q.state.error ? SNAPSHOT_REFRESH_MS : false),
    refetchOnWindowFocus: true,
    retry: 1,
  });
}

export function useWeek(start: string) {
  const { client, initialWeek } = useCtx();
  return useQuery<PortalWeek>({
    queryKey: portalKey(client.scopeKey, 'week', start),
    queryFn: () => client.getWeek(start),
    initialData: initialWeek && initialWeek.start === start ? initialWeek : undefined,
    staleTime: 60_000,
    retry: 1,
  });
}

export function useTimecard(enabled = true) {
  const { client } = useCtx();
  return useQuery<TimecardPayload>({
    queryKey: portalKey(client.scopeKey, 'timecard'),
    queryFn: () => client.getTimecard(),
    staleTime: 60_000,
    enabled,
    retry: 1,
  });
}

export function useTradeOptions(instanceId: string | null) {
  const { client } = useCtx();
  return useQuery<TradeOptionsPayload>({
    queryKey: portalKey(client.scopeKey, 'trade-options', instanceId),
    queryFn: () => client.getTradeOptions(instanceId as string),
    enabled: !!instanceId,
    staleTime: 15_000,
    retry: false,
  });
}

/** A mutation that, on success, refreshes everything under this token's prefix. */
export function usePortalAction<TArgs extends unknown[], TResult = void>(fn: (client: PortalClient, ...args: TArgs) => Promise<TResult>) {
  const { client } = useCtx();
  const qc = useQueryClient();
  return useMutation<TResult, Error, TArgs>({
    mutationFn: (args) => fn(client, ...args),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: portalKey(client.scopeKey) });
    },
  });
}
