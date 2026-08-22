'use client';

import { useState, useMemo, useEffect } from 'react';
import dynamic from 'next/dynamic';
import Header from '@/components/layout/Header';
import FiltersBar from '@/components/filters/FiltersBar';
import UnmappedSessionsBanner from '@/components/admin/UnmappedSessionsBanner';
import SummaryCards from '@/components/dashboard/SummaryCards';
import ForecastCard from '@/components/dashboard/ForecastCard';
import InventorySection from '@/components/inventory/InventorySection';
import TikTokConnect from '@/components/tiktok/TikTokConnect';
import { useTikTok } from '@/hooks/useTikTok';
import { useEntries } from '@/hooks/useEntries';
import { useProductCosts } from '@/hooks/useProductCosts';
import { useProductStats } from '@/hooks/useProductStats';
import { useLabor, useSavePackerLabor } from '@/hooks/useLabor';
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

type ViewTab = 'dashboard' | 'pnl' | 'inventory' | 'shows' | 'shipping' | 'employees';

function getPreviousPeriodEntries(
  allEntries: Entry[],
  activeQuickFilter: number | 'all',
  dateFrom: string | null,
  dateTo: string | null,
): Entry[] {
  if (activeQuickFilter === 'all' || (!dateFrom && !dateTo)) return [];

  const now = new Date();
  let prevFrom: string;
  let prevTo: string;

  if (activeQuickFilter === 0) {
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    prevFrom = prevTo = yesterday.toISOString().split('T')[0];
  } else if (activeQuickFilter === 1) {
    const dayBefore = new Date(now);
    dayBefore.setDate(dayBefore.getDate() - 2);
    prevFrom = prevTo = dayBefore.toISOString().split('T')[0];
  } else if (dateFrom && dateTo) {
    const from = new Date(dateFrom);
    const to = new Date(dateTo);
    const daysSpan = Math.round((to.getTime() - from.getTime()) / 86400000) + 1;
    const prevEnd = new Date(from);
    prevEnd.setDate(prevEnd.getDate() - 1);
    const prevStart = new Date(prevEnd);
    prevStart.setDate(prevStart.getDate() - daysSpan + 1);
    prevFrom = prevStart.toISOString().split('T')[0];
    prevTo = prevEnd.toISOString().split('T')[0];
  } else {
    return [];
  }

  return allEntries.filter((e) => e.date >= prevFrom && e.date <= prevTo);
}

export default function RealDashboard() {
  const [activeView, setActiveView] = useState<ViewTab>('dashboard');

  // One-shot: honor a tab a prior flow asked us to land on (e.g. Exit Kiosk → Team). Read from
  // sessionStorage in a mount effect (not a lazy initializer) to avoid a hydration mismatch —
  // same convention as PracticeModeLauncher's storage hydration.
  useEffect(() => {
    const t = sessionStorage.getItem('lensed.dashboardTab');
    if (!t) return;
    sessionStorage.removeItem('lensed.dashboardTab');
    if (t === 'dashboard' || t === 'pnl' || t === 'inventory' || t === 'shows' || t === 'shipping' || t === 'employees') {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- syncing from sessionStorage on mount
      setActiveView(t);
    }
  }, []);
  const [activeQuickFilter, setActiveQuickFilter] = useState<number | 'all'>('all');

  const { filters, setQuickFilter, setDateFrom, setDateTo } = useFilters();
  const { syncProgress, isConnected, connection } = useTikTok();
  const { costsMap } = useProductCosts();
  const { data: productStatsData, isError: productStatsError } = useProductStats(filters.dateFrom, filters.dateTo);
  const productStats = productStatsData?.products;
  const orderTotals = productStatsData?.totals;
  const { data: videoMetrics } = useShopVideos(filters.dateFrom, filters.dateTo);
  const { isConnected: bizConnected, advertiserName, connect: connectBiz, disconnect: disconnectBiz, syncAdSpend } = useTikTokBusiness();
  const { data: adSpendMetrics } = useAdSpend(filters.dateFrom, filters.dateTo);
  const { data: returnsData } = useReturns(filters.dateFrom, filters.dateTo);
  // Labor line — host labor is MEASURED (live_sessions × rate), packer labor is a manual entry.
  // Only available when a bounded period is selected (needs from & to).
  const { data: laborData } = useLabor(filters.dateFrom, filters.dateTo);
  const savePacker = useSavePackerLabor();
  const hostLaborDollars = (laborData?.host.labor_cents || 0) / 100;
  const packerLaborDollars = (laborData?.packer.labor_cents || 0) / 100;
  const totalLaborDollars = hostLaborDollars + packerLaborDollars;
  const [packerInput, setPackerInput] = useState<string>('');

  // All entries (no filter) for previous period comparison & forecast
  const { entries: allEntries } = useEntries({ dateFrom: null, dateTo: null, productId: 'all' });
  const { entries } = useEntries(filters);

  // COGS from TWO server-computed sources (product-stats): the AUCTION cost snapshot
  // (live_auction_item_skus.unit_cost_cents_snapshot) for auction orders, PLUS the name-based
  // CATALOG resolver ($0.80×(boxes+1)) for non-auction storefront orders. Together they cost
  // both halves of the business; what's still uncosted is surfaced (catalog unparseable names +
  // class-c auction-lot orders), never silently zero-costed.
  const snapshotCogs = orderTotals?.snapshotCogs || 0;
  const catalogCogs = orderTotals?.catalogCogs || 0;
  const totalProductCogs = snapshotCogs + catalogCogs;
  const cogsCoveredOrders = (orderTotals?.cogsCoveredOrders || 0) + (orderTotals?.catalogCostedOrders || 0);
  const cogsTotalOrders = orderTotals?.totalOrders || 0;
  const cogsCoveragePct = cogsTotalOrders > 0 ? Math.round((cogsCoveredOrders / cogsTotalOrders) * 100) : 0;
  // A period with revenue cannot legitimately have zero product cost — both COGS sources failed,
  // so net profit below is computed from missing cost data and must not be shown as a number.
  const cogsUnavailable = (orderTotals?.totalGMV || 0) > 0 && totalProductCogs === 0;
  // A failed stats read is the same class of problem, and looks worse: orderTotals is undefined,
  // so GMV and COGS both compute to 0, cogsUnavailable stays false, and the card would render a
  // confident $0 net for a period that actually has revenue. Treat both as unavailable cost data.
  const costDataUnavailable = productStatsError || cogsUnavailable;

  // Adjust net profit with product-level COGS and overlay video metrics
  const metrics = useMemo(() => {
    // Compute base metrics from order totals (synced_order_ids) — more reliable than entries table
    const t = orderTotals;
    const gmv = t?.totalGMV || 0;
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

    // LABOR — period cost (host measured + packer entered), subtracted from net. Independent of
    // computePay/shifts; see /api/labor. Reduces net profit + margin for the selected period.
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
    // COGS now spans auction (snapshot) + catalog (name resolver). The % is the combined coverage;
    // the remainder is uncosted (catalog unparseable names + class-c auction-lot orders).
    const cogsLabel = `COGS (auction + catalog, ${cogsCoveragePct}% of orders)`;
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
          onDateFromChange={setDateFrom}
          onDateToChange={setDateTo}
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
            {/* LABOR — two separate lines. Host is MEASURED (live_sessions); packer is ENTERED. */}
            {laborData && (
              <div className="rounded-xl border border-tt-border bg-tt-card p-4">
                <div className="flex items-center justify-between mb-2">
                  <div className="text-sm font-semibold text-tt-text">Labor (hosts measured, packers entered)</div>
                  <div className="text-sm text-tt-muted">−${totalLaborDollars.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} from net</div>
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  <div className="rounded-lg bg-tt-card-hover px-3 py-2">
                    <div className="text-xs text-tt-muted">Host labor · measured</div>
                    <div className="text-lg font-semibold text-tt-text">
                      ${hostLaborDollars.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      <span className="ml-2 text-xs font-normal text-tt-muted">{laborData.host.hours}h × ${laborData.host.rate_dollars}/h</span>
                    </div>
                    {(laborData.host.excluded_over_cap_count > 0 || laborData.host.rates_differ) && (
                      <div className="mt-1 text-[11px] text-tt-yellow" role="note">
                        ⚠ undercount: {laborData.host.excluded_over_cap_count} session{laborData.host.excluded_over_cap_count === 1 ? '' : 's'} &gt;{laborData.host.cap_hours}h excluded ({laborData.host.excluded_over_cap_hours}h){laborData.host.rates_differ ? '; hosts have differing rates — using the lowest' : ''}
                      </div>
                    )}
                  </div>
                  <div className="rounded-lg bg-tt-card-hover px-3 py-2">
                    <div className="text-xs text-tt-muted">Packer labor · entered {laborData.packer.entered ? '' : '(not set)'}</div>
                    <div className="flex items-center gap-2">
                      <span className="text-tt-muted">$</span>
                      <input
                        type="number" min="0" step="0.01" inputMode="decimal"
                        placeholder={(laborData.packer.labor_cents / 100).toFixed(2)}
                        value={packerInput}
                        onChange={(e) => setPackerInput(e.target.value)}
                        className="w-32 rounded-md bg-tt-bg border border-tt-border px-2 py-1 text-lg font-semibold text-tt-text focus:outline-none focus:ring-2 focus:ring-tt-cyan"
                      />
                      <button
                        type="button"
                        disabled={savePacker.isPending || packerInput === '' || !filters.dateFrom || !filters.dateTo}
                        onClick={() => savePacker.mutate({ from: filters.dateFrom!, to: filters.dateTo!, packer_labor_cents: Math.round(parseFloat(packerInput || '0') * 100) }, { onSuccess: () => setPackerInput('') })}
                        className="rounded-md border border-tt-border-hover bg-tt-card-hover px-3 py-1 text-sm text-tt-text hover:bg-white/[0.06] disabled:opacity-50 cursor-pointer"
                      >
                        {savePacker.isPending ? 'Saving…' : 'Save'}
                      </button>
                    </div>
                    <div className="mt-1 text-[11px] text-tt-muted">No reliable measured pack-time — enter the period figure.</div>
                  </div>
                </div>
              </div>
            )}
            <ForecastCard entries={allEntries} costsMap={costsMap} />
            <Charts chartData={chartData} />
          </>
        )}

        {/* P&L View */}
        {activeView === 'pnl' && <PnlTab dateFrom={filters.dateFrom} dateTo={filters.dateTo} />}

        {/* Inventory View */}
        {activeView === 'inventory' && <InventorySection />}

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
