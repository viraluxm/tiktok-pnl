'use client';

import { useQuery } from '@tanstack/react-query';
import { useUser } from './useUser';

// Seller-local timezone for bucketing/period boundaries. Matches how the Shows
// tab renders times (browser-local) and, for this seller, the shop tz the Period
// selector uses (America/Los_Angeles). Falls back if the runtime can't resolve.
const TZ =
  (typeof Intl !== 'undefined' && Intl.DateTimeFormat().resolvedOptions().timeZone) ||
  'America/Los_Angeles';

// Postgres numeric/bigint come back as strings over PostgREST — coerce to number.
const num = (v: unknown): number => (v == null ? 0 : Number(v));
const numOrNull = (v: unknown): number | null => (v == null ? null : Number(v));

function qs(from: string | null, to: string | null, extra?: Record<string, string>): string {
  const p = new URLSearchParams();
  if (from) p.set('from', from);
  if (to) p.set('to', to);
  p.set('tz', TZ);
  if (extra) for (const [k, v] of Object.entries(extra)) p.set(k, v);
  return p.toString();
}

// ── By SKU ──────────────────────────────────────────────────────────────
export interface PnlSkuRow {
  sku_id: string;
  sku_number: number;
  title: string;
  is_active: boolean;
  units_sold: number;
  revenue_cents: number;
  cogs_cents: number;
  net_profit_cents: number;
  qty_on_hand: number;
  lead_time_days: number | null;
  reorder_point: number | null;
  period_days: number;
}

export function usePnlBySku(from: string | null, to: string | null) {
  const { user } = useUser();
  return useQuery<PnlSkuRow[]>({
    queryKey: ['pnl-by-sku', user?.id, from, to, TZ],
    enabled: !!user,
    staleTime: 30_000,
    queryFn: async () => {
      const res = await fetch(`/api/pnl/by-sku?${qs(from, to)}`);
      if (!res.ok) throw new Error('Failed to load P&L by SKU');
      const json = await res.json();
      return (json.rows ?? []).map((r: Record<string, unknown>) => ({
        sku_id: r.sku_id as string,
        sku_number: num(r.sku_number),
        title: (r.title as string) ?? '',
        is_active: !!r.is_active,
        units_sold: num(r.units_sold),
        revenue_cents: num(r.revenue_cents),
        cogs_cents: num(r.cogs_cents),
        net_profit_cents: num(r.net_profit_cents),
        qty_on_hand: num(r.qty_on_hand),
        lead_time_days: numOrNull(r.lead_time_days),
        reorder_point: numOrNull(r.reorder_point),
        period_days: num(r.period_days),
      }));
    },
  });
}

// ── By Show ─────────────────────────────────────────────────────────────
export interface PnlShowRow {
  session_id: string;
  title: string;
  started_at: string | null;
  ended_at: string | null;
  auctions: number;
  units: number;
  gmv_cents: number;
  cogs_cents: number;
  net_profit_cents: number;
}

export function usePnlByShow(from: string | null, to: string | null) {
  const { user } = useUser();
  return useQuery<PnlShowRow[]>({
    queryKey: ['pnl-by-show', user?.id, from, to, TZ],
    enabled: !!user,
    staleTime: 30_000,
    queryFn: async () => {
      const res = await fetch(`/api/pnl/by-show?${qs(from, to)}`);
      if (!res.ok) throw new Error('Failed to load P&L by show');
      const json = await res.json();
      return (json.rows ?? []).map((r: Record<string, unknown>) => ({
        session_id: r.session_id as string,
        title: (r.title as string) ?? '',
        started_at: (r.started_at as string) ?? null,
        ended_at: (r.ended_at as string) ?? null,
        auctions: num(r.auctions),
        units: num(r.units),
        gmv_cents: num(r.gmv_cents),
        cogs_cents: num(r.cogs_cents),
        net_profit_cents: num(r.net_profit_cents),
      }));
    },
  });
}

// ── By Show → per-hour drill-down ───────────────────────────────────────
export interface PnlHourRow {
  hour_start: string; // local wall-clock hour bucket (no tz)
  hour_of_day: number;
  auctions: number;
  units: number;
  revenue_cents: number;
  cogs_cents: number;
  net_profit_cents: number;
}

export function usePnlShowHourly(sessionId: string | null, from: string | null, to: string | null) {
  const { user } = useUser();
  return useQuery<PnlHourRow[]>({
    queryKey: ['pnl-show-hourly', user?.id, sessionId, from, to, TZ],
    enabled: !!user && !!sessionId,
    staleTime: 30_000,
    queryFn: async () => {
      const res = await fetch(`/api/pnl/show-hourly?${qs(from, to, { session_id: sessionId! })}`);
      if (!res.ok) throw new Error('Failed to load hourly breakdown');
      const json = await res.json();
      return (json.rows ?? []).map((r: Record<string, unknown>) => ({
        hour_start: r.hour_start as string,
        hour_of_day: num(r.hour_of_day),
        auctions: num(r.auctions),
        units: num(r.units),
        revenue_cents: num(r.revenue_cents),
        cogs_cents: num(r.cogs_cents),
        net_profit_cents: num(r.net_profit_cents),
      }));
    },
  });
}

// ── By Period ───────────────────────────────────────────────────────────
export interface PnlPeriodRow {
  day: string;
  units: number;
  revenue_cents: number;
  cogs_cents: number;
  net_profit_cents: number;
}

export function usePnlByPeriod(from: string | null, to: string | null) {
  const { user } = useUser();
  return useQuery<PnlPeriodRow[]>({
    queryKey: ['pnl-by-period', user?.id, from, to, TZ],
    enabled: !!user,
    staleTime: 30_000,
    queryFn: async () => {
      const res = await fetch(`/api/pnl/by-period?${qs(from, to)}`);
      if (!res.ok) throw new Error('Failed to load P&L by period');
      const json = await res.json();
      return (json.rows ?? []).map((r: Record<string, unknown>) => ({
        day: r.day as string,
        units: num(r.units),
        revenue_cents: num(r.revenue_cents),
        cogs_cents: num(r.cogs_cents),
        net_profit_cents: num(r.net_profit_cents),
      }));
    },
  });
}
