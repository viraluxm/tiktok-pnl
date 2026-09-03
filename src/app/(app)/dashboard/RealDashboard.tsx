'use client';

import { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import dynamic from 'next/dynamic';
import Header from '@/components/layout/Header';
import FiltersBar from '@/components/filters/FiltersBar';
import UnmappedSessionsBanner from '@/components/admin/UnmappedSessionsBanner';
import SummaryCards from '@/components/dashboard/SummaryCards';
import InventoryTabs from '@/components/inventory/InventoryTabs';
import TikTokConnect from '@/components/tiktok/TikTokConnect';
import { useTikTok } from '@/hooks/useTikTok';
import { useEntries } from '@/hooks/useEntries';
import { useProductStats } from '@/hooks/useProductStats';
import { useLabor } from '@/hooks/useLabor';
import { useFilters } from '@/hooks/useFilters';
import { useShopVideos } from '@/hooks/useShopVideos';
import { useTikTokBusiness } from '@/hooks/useTikTokBusiness';
import { useAdSpend } from '@/hooks/useAdSpend';
import { computeDashboardMetrics } from '@/lib/calculations';
import { useReturns } from '@/hooks/useReturns';
import ShowsTab from '@/components/shows/ShowsTab';
import ShippingTab from '@/components/shipping/ShippingTab';
import EmployeesTab from '@/components/employees/EmployeesTab';
import type { Entry, DashboardMetrics, ChartData } from '@/types';
import type { OrderTotals } from '@/hooks/useProductStats';

const Charts = dynamic(() => import('@/components/dashboard/Charts'), { ssr: false });
// P&L renders chart.js — load client-only, same as Charts.
const PnlTab = dynamic(() => import('@/components/pnl/PnlTab'), { ssr: false });

// The active tab lives in the URL (?tab=…), not in component state. A reload, a middleware 307
// round-trip, or an accidental tab activation therefore returns the operator to where they were
// instead of dropping them on Dashboard — which matters most for the packing station, where the
// Shipping tab is open for a whole shift and losing it means losing the scanner overlay.
// 'dashboard' is the default and is represented by the ABSENCE of the param, so the bare
// /dashboard URL keeps its current meaning and no redundant ?tab=dashboard is ever written.
const TAB_VALUES = ['dashboard', 'pnl', 'inventory', 'shows', 'shipping', 'employees'] as const;
type ViewTab = (typeof TAB_VALUES)[number];
const DEFAULT_TAB: ViewTab = 'dashboard';
const isViewTab = (v: unknown): v is ViewTab =>
  typeof v === 'string' && (TAB_VALUES as readonly string[]).includes(v);

function getPreviousPeriodEntries(
  allEntries: Entry[],
  activeQuickFilter: number | 'all' | 'custom',
  dateFrom: string | null,
  dateTo: string | null,
): Entry[] {
  if (activeQuickFilter === 'all' || (!dateFrom && !dateTo)) return [];

  // Pacific-anchored (America/Los_Angeles) to match the main filter + order-date derivation.
  // shiftDays does pure calendar math on YYYY-MM-DD strings (parse+emit in UTC, no zone drift).
  const toShopDate = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  const shiftDays = (isoDate: string, n: number) => {
    const d = new Date(`${isoDate}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };
  const todayStr = toShopDate(new Date());

  let prevFrom: string;
  let prevTo: string;

  if (activeQuickFilter === 0) {
    prevFrom = prevTo = shiftDays(todayStr, -1); // yesterday (Pacific)
  } else if (activeQuickFilter === 1) {
    prevFrom = prevTo = shiftDays(todayStr, -2); // day before yesterday (Pacific)
  } else if (dateFrom && dateTo) {
    const daysSpan =
      Math.round(
        (new Date(`${dateTo}T00:00:00Z`).getTime() - new Date(`${dateFrom}T00:00:00Z`).getTime()) /
          86400000,
      ) + 1;
    prevTo = shiftDays(dateFrom, -1);
    prevFrom = shiftDays(dateFrom, -daysSpan);
  } else {
    return [];
  }

  return allEntries.filter((e) => e.date >= prevFrom && e.date <= prevTo);
}

export default function RealDashboard() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // Derived, not stored: the URL is the single source of truth for the tab. An unrecognised
  // ?tab= value falls back to the default WITHOUT rewriting the URL — a stale bookmark renders
  // the dashboard rather than bouncing the history.
  const tabParam = searchParams.get('tab');
  const activeView: ViewTab = isViewTab(tabParam) ? tabParam : DEFAULT_TAB;

  // 'push' for operator-initiated tab changes, so Back/Forward walk the tabs the way they read.
  // 'replace' for programmatic landings (the one-shot handoff below), so no phantom entry is
  // created that Back would bounce off. Other search params are preserved verbatim.
  const setActiveView = useCallback(
    (next: ViewTab, mode: 'push' | 'replace' = 'push') => {
      const params = new URLSearchParams(searchParams.toString());
      if (next === DEFAULT_TAB) params.delete('tab');
      else params.set('tab', next);
      const qs = params.toString();
      const url = qs ? `${pathname}?${qs}` : pathname;
      if (mode === 'replace') router.replace(url, { scroll: false });
      else router.push(url, { scroll: false });
    },
    [router, pathname, searchParams],
  );

  // One-shot: honor a tab a prior flow asked us to land on (e.g. Exit Kiosk → Team, written by
  // ExitKioskButton). Read from sessionStorage in a mount effect (not a lazy initializer) to
  // avoid a hydration mismatch — same convention as PracticeModeLauncher's storage hydration.
  // The ref guards against the effect re-running if setActiveView's identity changes; the key is
  // consumed (removed) on the first pass regardless, preserving the existing one-shot contract.
  const handoffConsumed = useRef(false);
  useEffect(() => {
    if (handoffConsumed.current) return;
    handoffConsumed.current = true;
    let t: string | null = null;
    try {
      t = sessionStorage.getItem('lensed.dashboardTab');
      if (t) sessionStorage.removeItem('lensed.dashboardTab');
    } catch {
      /* storage unavailable (private mode) — no handoff, nothing to clean up */
    }
    if (isViewTab(t)) setActiveView(t, 'replace');
  }, [setActiveView]);
  const [activeQuickFilter, setActiveQuickFilter] = useState<number | 'all' | 'custom'>('all');

  const { filters, setQuickFilter, setDateFrom, setDateTo } = useFilters();
  const { syncProgress, isConnected, connection } = useTikTok();
  const { data: productStatsData, isError: productStatsError } = useProductStats(filters.dateFrom, filters.dateTo);
  const productStats = productStatsData?.products;
  const orderTotals = productStatsData?.totals;
  const { data: videoMetrics } = useShopVideos(filters.dateFrom, filters.dateTo);
  const { isConnected: bizConnected, advertiserName, connect: connectBiz, disconnect: disconnectBiz, syncAdSpend } = useTikTokBusiness();
  const { data: adSpendMetrics } = useAdSpend(filters.dateFrom, filters.dateTo);
  const { data: returnsData } = useReturns(filters.dateFrom, filters.dateTo);
  // Labor line — host + fulfillment, both punch-derived (clock-in/out via computeLaborByDateRole).
  // Only available when a bounded period is selected (needs from & to).
  const { data: laborData } = useLabor(filters.dateFrom, filters.dateTo);
  const hostLaborDollars = (laborData?.host.labor_cents || 0) / 100;
  const fulfillmentLaborDollars = (laborData?.fulfillment.labor_cents || 0) / 100;
  const totalLaborDollars = hostLaborDollars + fulfillmentLaborDollars;

  // All entries (no filter) for previous period comparison & forecast
  const { entries: allEntries } = useEntries({ dateFrom: null, dateTo: null, productId: 'all' });
  const { entries } = useEntries(filters);

  // COGS from the AUCTION cost snapshot (live_auction_item_skus.unit_cost_cents_snapshot), read via
  // the canonical order-grain view. PARTIAL BY DESIGN: only auction orders carry a snapshot;
  // cogsCoveredOrders vs totalOrders lets the UI label that coverage honestly. Non-auction
  // (storefront) orders carry no snapshot and are not costed here.
  const snapshotCogs = orderTotals?.snapshotCogs || 0;
  const totalProductCogs = snapshotCogs;
  const cogsCoveredOrders = orderTotals?.cogsCoveredOrders || 0;
  const cogsTotalOrders = orderTotals?.totalOrders || 0;
  // Recognised revenue (the same figure the net-profit math below uses: GMV less non-auction
  // merchandise) cannot legitimately resolve zero auction COGS. Three ways cost data can be
  // missing, all of which must stop the net card rendering a number:
  //   * the stats read itself failed — orderTotals is undefined, so GMV and COGS both compute to
  //     0 and the arithmetic check below would sit there looking healthy;
  //   * the route flagged a COGS read that errored part-way (partial sum, too low, not zero);
  //   * recognised revenue with no COGS at all.
  const recognisedGmv = (orderTotals?.totalGMV || 0) - (orderTotals?.nonAuctionMerch || 0);
  const costDataUnavailable = productStatsError
    || (orderTotals?.cogsUnavailable ?? false)
    || (recognisedGmv > 0 && totalProductCogs === 0);
  const cogsCoveragePct = cogsTotalOrders > 0 ? Math.round((cogsCoveredOrders / cogsTotalOrders) * 100) : 0;

  // Adjust net profit with product-level COGS and overlay video metrics
  const metrics = useMemo(() => {
    // Compute base metrics from order totals (synced_order_ids) — more reliable than entries table
    const t = orderTotals;
    // Headline GMV drops non-auction MERCHANDISE (gmv − shipping); auction GMV stays on the synced
    // basis and non-auction shipping remains. This card answers "what did TikTok bill buyers".
    const gmv = (t?.totalGMV || 0) - (t?.nonAuctionMerch || 0);
    const shipping = t?.totalShipping || 0;
    const affiliate = t?.totalAffiliate || 0;
    const platformFee = t?.totalPlatformFee || 0;
    const effectivePlatformFee = platformFee || (gmv * 0.06);
    const baseProfit = gmv - effectivePlatformFee - shipping - affiliate - totalProductCogs;

    let result: DashboardMetrics = {
      totalGMV: gmv,
      totalNetProfit: baseProfit,
      avgMargin: gmv > 0 ? (baseProfit / gmv) * 100 : 0,
      totalVideos: 0,
      totalViews: 0,
      totalAds: 0,
      totalAffiliate: affiliate,
      totalShipping: shipping,
      totalUnitsSold: t?.totalOrders || 0,
      totalUnits: t?.totalUnits || 0, // actual units/qty (same orderTotals source as GMV/Net Profit)
      entryCount: t?.totalOrders || 0,
      avgViewsPerVideo: 0,
      revenuePerVideo: 0,
      profitPerVideo: 0,
      roas: null,
      topProduct: null,
      productProfits: {},
      returnsCount: returnsData?.summary?.totalReturns ?? t?.returnsCount ?? 0,
      returnsAmount: returnsData?.summary?.totalAmount ?? t?.returnsAmount ?? 0,
      samplesCount: t?.samplesCount || 0,
      cogsUnavailable: costDataUnavailable,
    };

    // Override video metrics from shop_videos table if available
    if (videoMetrics && videoMetrics.totalVideos > 0) {
      const videos = videoMetrics.totalVideos;
      const views = videoMetrics.totalViews;
      result = {
        ...result,
        totalVideos: videos,
        totalViews: views,
        avgViewsPerVideo: videos > 0 ? views / videos : 0,
        revenuePerVideo: videos > 0 ? result.totalGMV / videos : 0,
        profitPerVideo: videos > 0 ? result.totalNetProfit / videos : 0,
      };
    }

    // Override ad spend from Business API if available
    if (adSpendMetrics && adSpendMetrics.totalSpend > 0) {
      const ads = adSpendMetrics.totalSpend;
      const adjustedProfit = result.totalNetProfit - ads + result.totalAds; // remove old ads, add real
      result = {
        ...result,
        totalAds: ads,
        totalNetProfit: adjustedProfit,
        avgMargin: result.totalGMV > 0 ? (adjustedProfit / result.totalGMV) * 100 : 0,
        roas: ads > 0 ? result.totalGMV / ads : null,
        profitPerVideo: result.totalVideos > 0 ? adjustedProfit / result.totalVideos : 0,
      };
    }

    // LABOR — period cost (host + fulfillment, both punch-derived), subtracted from net. Reuses
    // payroll's payability (see /api/labor → computeLaborByDateRole). Reduces net + margin.
    if (totalLaborDollars > 0) {
      const afterLabor = result.totalNetProfit - totalLaborDollars;
      result = { ...result, totalNetProfit: afterLabor, avgMargin: result.totalGMV > 0 ? (afterLabor / result.totalGMV) * 100 : 0 };
    }

    return result;
  }, [orderTotals, totalProductCogs, costDataUnavailable, videoMetrics, adSpendMetrics, returnsData, totalLaborDollars]);
  // Build chart data from orderTotals.byDate (synced_order_ids) instead of entries
  const chartData = useMemo((): ChartData => {
    const byDate = orderTotals?.byDate || {};
    const sortedDates = Object.keys(byDate).sort();

    const gmvData: number[] = [];
    const profitData: number[] = [];
    let totalPlatFee = 0, totalShip = 0, totalProf = 0, totalUserCogs = 0;

    for (const date of sortedDates) {
      const d = byDate[date];
      const pf = d.platformFee || (d.gmv * 0.06);
      const dayProfit = d.gmv - pf - d.shipping - d.affiliate;
      gmvData.push(d.gmv);
      profitData.push(dayProfit);
      totalPlatFee += pf;
      totalShip += d.shipping;
      totalProf += dayProfit;
    }

    // Subtract COGS from total profit
    totalUserCogs = totalProductCogs;
    totalProf -= totalUserCogs;

    const hasUserCogs = totalUserCogs > 0;
    // COGS = auction cost snapshot only. The % is auction coverage; non-auction orders carry no
    // snapshot and are not costed here.
    const cogsLabel = `COGS (auction snapshot, ${cogsCoveragePct}% of orders)`;
    const breakdownLabels = hasUserCogs
      ? ['Platform Fee (6%)', cogsLabel, 'Shipping', 'Net Profit']
      : ['Platform Fee (6%)', 'Shipping', 'Net Profit'];
    const rawAmounts = hasUserCogs
      ? [Math.max(0, totalPlatFee), Math.max(0, totalUserCogs), Math.max(0, totalShip), Math.max(0, totalProf)]
      : [Math.max(0, totalPlatFee), Math.max(0, totalShip), Math.max(0, totalProf)];
    const breakdownColors = hasUserCogs
      ? ['#ff6384', '#f97316', '#ff9f40', '#69C9D0']
      : ['#ff6384', '#ff9f40', '#69C9D0'];
    const totalCosts = rawAmounts.reduce((a, b) => a + b, 0);

    return {
      profitByDate: { labels: sortedDates, data: profitData },
      gmvByDate: { labels: sortedDates, data: gmvData },
      productCompare: { labels: [], gmv: [], profit: [] },
      costBreakdown: {
        labels: breakdownLabels,
        data: totalCosts > 0 ? rawAmounts.map(v => (v / totalCosts) * 100) : rawAmounts.map(() => 0),
        colors: breakdownColors,
        rawAmounts,
      },
      marginByDate: {
        labels: sortedDates,
        data: sortedDates.map((_, i) => gmvData[i] > 0 ? (profitData[i] / gmvData[i]) * 100 : 0),
      },
    };
  }, [orderTotals, totalProductCogs]);

  // Previous period
  const prevEntries = useMemo(
    () => getPreviousPeriodEntries(allEntries, activeQuickFilter, filters.dateFrom, filters.dateTo),
    [allEntries, activeQuickFilter, filters.dateFrom, filters.dateTo],
  );
  const prevMetrics = useMemo(
    () => (prevEntries.length > 0 ? computeDashboardMetrics(prevEntries) : null),
    [prevEntries],
  );

  function handleQuickFilter(days: number | 'all') {
    setActiveQuickFilter(days);
    setQuickFilter(days);
  }

  // Last-touched-wins: an explicit date edit clears the quick-filter highlight (→ 'custom'),
  // and a quick-filter click (handleQuickFilter) overwrites the dates. Exactly one is ever active.
  function handleDateFrom(date: string | null) {
    setActiveQuickFilter('custom');
    setDateFrom(date);
  }
  function handleDateTo(date: string | null) {
    setActiveQuickFilter('custom');
    setDateTo(date);
  }

  const tabs: Array<{ label: string; value: ViewTab }> = [
    { label: 'Dashboard', value: 'dashboard' },
    { label: 'P&L', value: 'pnl' },
    { label: 'Inventory', value: 'inventory' },
    { label: 'Shows', value: 'shows' },
    { label: 'Shipping', value: 'shipping' },
    { label: 'Team', value: 'employees' },
  ];

  return (
    <div className="min-h-screen bg-tt-bg">
      <Header />

      <div className="px-4 py-4 md:px-8 md:py-6">
        <UnmappedSessionsBanner />
        <TikTokConnect />

        {/* Ad Account Connection */}
        {isConnected && (
          <div className="mb-4 flex items-center gap-3 flex-wrap">
            {bizConnected ? (
              <div className="flex items-center gap-3 px-4 py-2 rounded-lg border border-tt-border bg-tt-card">
                <span className="text-xs text-tt-muted">Ad Account:</span>
                <span className="text-xs font-medium text-tt-green">{advertiserName || 'Connected'}</span>
                <button onClick={() => syncAdSpend()} className="text-[10px] px-2 py-0.5 rounded border border-tt-border text-tt-muted hover:text-tt-cyan hover:border-tt-cyan transition-colors">
                  Sync Ads
                </button>
                <button onClick={() => disconnectBiz()} className="text-[10px] px-2 py-0.5 rounded border border-tt-border text-tt-muted hover:text-tt-red hover:border-tt-red transition-colors">
                  Disconnect
                </button>
              </div>
            ) : (
              <button
                onClick={() => connectBiz()}
                className="flex items-center gap-2 px-4 py-2 rounded-lg border border-dashed border-tt-border text-tt-muted hover:border-tt-cyan hover:text-tt-cyan transition-colors text-xs"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 5v14M5 12h14"/></svg>
                Connect Ad Account
              </button>
            )}
          </div>
        )}

        {/* Sync hero — show until isCaughtUp is true */}
        {isConnected && syncProgress?.isSyncing && (
          <div className="mb-8 p-8 rounded-2xl border border-tt-cyan/30 bg-gradient-to-br from-[rgba(105,201,208,0.12)] to-[rgba(105,201,208,0.03)]">
            <div className="flex flex-col items-center gap-5 text-center">
              <div className="w-14 h-14 border-[3px] border-tt-cyan border-t-transparent rounded-full animate-spin" />
              <div>
                <h2 className="text-lg font-bold text-tt-text mb-2">Syncing your TikTok Shop data...</h2>
                {syncProgress && (
                  <p className="text-sm text-tt-cyan font-semibold mb-1">
                    {syncProgress.totalOrders.toLocaleString()} orders imported
                  </p>
                )}
                {syncProgress?.currentRange && (
                  <p className="text-xs text-tt-muted mb-3">
                    ({syncProgress.currentRange})
                  </p>
                )}
                <p className="text-xs text-tt-muted max-w-md mx-auto leading-relaxed">
                  Usually takes 1–3 minutes. You can close this page and come back later.
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Show dashboard when sync is complete or not connected */}
        {(!isConnected || !syncProgress?.isSyncing) && (
          <>
        <FiltersBar
          filters={filters}
          onQuickFilter={handleQuickFilter}
          onDateFromChange={handleDateFrom}
          onDateToChange={handleDateTo}
          activeQuickFilter={activeQuickFilter}
        />

        {/* View Tabs — horizontally scrollable on mobile (edge-to-edge), static row on desktop */}
        <div className="flex gap-2 mb-6 md:mb-8 overflow-x-auto no-scrollbar snap-x -mx-4 px-4 md:mx-0 md:px-0">
          {tabs.map((tab) => (
            <button
              key={tab.value}
              onClick={() => setActiveView(tab.value)}
              className={`shrink-0 snap-start min-h-[44px] px-4 md:px-6 py-2.5 rounded-lg border text-sm font-medium cursor-pointer transition-all ${
                activeView === tab.value
                  ? 'bg-tt-cyan text-black border-tt-cyan font-semibold'
                  : 'border-tt-border text-tt-muted hover:bg-tt-card-hover'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Dashboard View */}
        {activeView === 'dashboard' && (
          <>
            <SummaryCards metrics={metrics} prevMetrics={prevMetrics} />
            {/* LABOR — host + fulfillment, both PUNCH-DERIVED (clock-in/out). Provisional when a
                material share of hours is still awaiting manager confirmation. */}
            {laborData && (
              <div className="rounded-xl border border-tt-border bg-tt-card p-4">
                <div className="flex items-center justify-between mb-2 gap-2 flex-wrap">
                  <div className="text-sm font-semibold text-tt-text">Labor · punch-derived</div>
                  <div className={`text-sm ${laborData.provisional ? 'text-tt-yellow' : 'text-tt-muted'}`}>
                    −${totalLaborDollars.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} from net
                    {laborData.provisional && <span> · +{laborData.pending.hours}h pending confirmation</span>}
                  </div>
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  <div className="rounded-lg bg-tt-card-hover px-3 py-2">
                    <div className="text-xs text-tt-muted">Host labor · punch-derived</div>
                    <div className="text-lg font-semibold text-tt-text">
                      ${hostLaborDollars.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      <span className="ml-2 text-xs font-normal text-tt-muted">{laborData.host.hours}h</span>
                    </div>
                    {laborData.host.zero_rate_flag && (
                      <div className="mt-1 text-[11px] text-tt-yellow" role="note">
                        ⚠ some hosts have a $0 rate — hours counted, cost flagged (not silently $0)
                      </div>
                    )}
                  </div>
                  <div className="rounded-lg bg-tt-card-hover px-3 py-2">
                    <div className="text-xs text-tt-muted">Fulfillment labor · punch-derived</div>
                    <div className="text-lg font-semibold text-tt-text">
                      ${fulfillmentLaborDollars.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      <span className="ml-2 text-xs font-normal text-tt-muted">{laborData.fulfillment.hours}h</span>
                    </div>
                  </div>
                </div>
                {laborData.provisional && (
                  <div className="mt-2 text-[11px] text-tt-yellow" role="note">
                    Provisional — {laborData.pending.hours}h ({laborData.pending.pct}% of labor) awaiting manager confirmation; net settles as punches confirm.
                  </div>
                )}
              </div>
            )}
            <Charts chartData={chartData} />
          </>
        )}

        {/* P&L View */}
        {activeView === 'pnl' && <PnlTab dateFrom={filters.dateFrom} dateTo={filters.dateTo} />}

        {/* Inventory View */}
        {activeView === 'inventory' && <InventoryTabs />}

        {/* Shows View */}
        {activeView === 'shows' && <ShowsTab />}

        {/* Shipping View */}
        {activeView === 'shipping' && (
          <ShippingTab />
        )}

        {/* Team / Employees View */}
        {activeView === 'employees' && (
          <EmployeesTab dateFrom={filters.dateFrom} dateTo={filters.dateTo} />
        )}
          </>
        )}
      </div>
    </div>
  );
}
