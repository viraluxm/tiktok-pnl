'use client';

import { useState, useMemo, useCallback } from 'react';
import dynamic from 'next/dynamic';
import Header from '@/components/layout/Header';
import FiltersBar from '@/components/filters/FiltersBar';
import SummaryCards from '@/components/dashboard/SummaryCards';
import ForecastCard from '@/components/dashboard/ForecastCard';
import ProductCostTable from '@/components/products/ProductCostTable';
import TikTokConnect from '@/components/tiktok/TikTokConnect';
import { useTikTok } from '@/hooks/useTikTok';
import { useEntries } from '@/hooks/useEntries';
import { useProductCosts } from '@/hooks/useProductCosts';
import { useProductStats } from '@/hooks/useProductStats';
import { useFilters } from '@/hooks/useFilters';
import { useShopVideos } from '@/hooks/useShopVideos';
import { useTikTokBusiness } from '@/hooks/useTikTokBusiness';
import { useAdSpend } from '@/hooks/useAdSpend';
import { computeDashboardMetrics } from '@/lib/calculations';
import { useReturns } from '@/hooks/useReturns';
import ReturnsTab from '@/components/dashboard/ReturnsTab';
import { useFinance } from '@/hooks/useFinance';
import CashflowTab from '@/components/dashboard/CashflowTab';
import type { Entry, DashboardMetrics, ChartData } from '@/types';
import type { OrderTotals } from '@/hooks/useProductStats';

const Charts = dynamic(() => import('@/components/dashboard/Charts'), { ssr: false });

type ViewTab = 'dashboard' | 'products' | 'returns' | 'cashflow';

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
  const [activeQuickFilter, setActiveQuickFilter] = useState<number | 'all'>('all');

  const { filters, setQuickFilter, setDateFrom, setDateTo } = useFilters();
  const { syncProgress, isConnected, connection } = useTikTok();
  const { costsMap, upsertCost } = useProductCosts();
  const { data: productStatsData } = useProductStats(filters.dateFrom, filters.dateTo);
  const productStats = productStatsData?.products;
  const orderTotals = productStatsData?.totals;
  const { data: videoMetrics } = useShopVideos(filters.dateFrom, filters.dateTo);
  const { isConnected: bizConnected, advertiserName, connect: connectBiz, disconnect: disconnectBiz, syncAdSpend } = useTikTokBusiness();
  const { data: adSpendMetrics } = useAdSpend(filters.dateFrom, filters.dateTo);
  const { data: returnsData, isLoading: returnsLoading } = useReturns(filters.dateFrom, filters.dateTo);
  const { data: financeData, isLoading: financeLoading } = useFinance(filters.dateFrom, filters.dateTo);

  // All entries (no filter) for previous period comparison & forecast
  const { entries: allEntries } = useEntries({ dateFrom: null, dateTo: null, productId: 'all' });
  const { entries } = useEntries(filters);

  // Calculate total COGS from product stats + costsMap
  // No useMemo — must recompute every render to stay in sync with costsMap
  let totalProductCogs = 0;
  if (productStats?.length && costsMap) {
    for (const product of productStats) {
      if (product.skus.length <= 1) {
        const cost = costsMap[product.tiktok_product_id] || 0;
        if (cost > 0) totalProductCogs += cost * product.total_orders;
      } else {
        for (const sku of product.skus) {
          const key = `${product.tiktok_product_id}-${sku.sku_id}`;
          const cost = costsMap[key] || 0;
          if (cost > 0) totalProductCogs += cost * sku.orders;
        }
      }
    }
  }

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

    return result;
  }, [orderTotals, totalProductCogs, videoMetrics, adSpendMetrics, returnsData]);
  // Build chart data from orderTotals.byDate (synced_order_ids) instead of entries
  const chartData = useMemo((): ChartData => {
    const byDate = orderTotals?.byDate || {};
    const sortedDates = Object.keys(byDate).sort();

    const gmvData: number[] = [];
    const profitData: number[] = [];
    let totalPlatFee = 0, totalShip = 0, totalAff = 0, totalProf = 0, totalUserCogs = 0;

    for (const date of sortedDates) {
      const d = byDate[date];
      const pf = d.platformFee || (d.gmv * 0.06);
      const dayProfit = d.gmv - pf - d.shipping - d.affiliate;
      gmvData.push(d.gmv);
      profitData.push(dayProfit);
      totalPlatFee += pf;
      totalShip += d.shipping;
      totalAff += d.affiliate;
      totalProf += dayProfit;
    }

    // Subtract COGS from total profit
    totalUserCogs = totalProductCogs;
    totalProf -= totalUserCogs;

    const hasUserCogs = totalUserCogs > 0;
    const breakdownLabels = hasUserCogs
      ? ['Platform Fee (6%)', 'COGS', 'Shipping', 'Affiliate', 'Ads', 'Net Profit']
      : ['Platform Fee (6%)', 'Shipping', 'Affiliate', 'Ads', 'Net Profit'];
    const rawAmounts = hasUserCogs
      ? [Math.max(0, totalPlatFee), Math.max(0, totalUserCogs), Math.max(0, totalShip), Math.max(0, totalAff), 0, Math.max(0, totalProf)]
      : [Math.max(0, totalPlatFee), Math.max(0, totalShip), Math.max(0, totalAff), 0, Math.max(0, totalProf)];
    const breakdownColors = hasUserCogs
      ? ['#ff6384', '#f97316', '#ff9f40', '#ffcd56', '#EE1D52', '#69C9D0']
      : ['#ff6384', '#ff9f40', '#ffcd56', '#EE1D52', '#69C9D0'];
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

  const handleCostChange = useCallback((productId: string, variantId: string | null, cost: number) => {
    upsertCost.mutate({ productId, variantId, costPerUnit: cost });
  }, [upsertCost]);

  const handleInventoryChange = useCallback(async (productId: string, skuId: string, quantity: number) => {
    try {
      await fetch('/api/tiktok/update-inventory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productId, skuId, quantity }),
      });
    } catch (err) {
      console.error('Inventory update failed:', err);
    }
  }, []);

  function handleQuickFilter(days: number | 'all') {
    setActiveQuickFilter(days);
    setQuickFilter(days);
  }

  const tabs: Array<{ label: string; value: ViewTab }> = [
    { label: 'Dashboard', value: 'dashboard' },
    { label: 'Products', value: 'products' },
    { label: 'Returns', value: 'returns' },
    { label: 'Cashflow', value: 'cashflow' },
  ];

  return (
    <div className="min-h-screen bg-tt-bg">
      <Header />

      <div className="px-8 py-6">
        <TikTokConnect />

        {/* Ad Account Connection */}
        {isConnected && (
          <div className="mb-4 flex items-center gap-3">
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

        {/* View Tabs */}
        <div className="flex gap-2 mb-8">
          {tabs.map((tab) => (
            <button
              key={tab.value}
              onClick={() => setActiveView(tab.value)}
              className={`px-6 py-2.5 rounded-lg border text-sm font-medium cursor-pointer transition-all ${
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
            <ForecastCard entries={allEntries} costsMap={costsMap} />
            <Charts chartData={chartData} />
          </>
        )}

        {/* Products View */}
        {activeView === 'products' && (
          <ProductCostTable
            productStats={productStats || []}
            costsMap={costsMap}
            onCostChange={handleCostChange}
            onInventoryChange={handleInventoryChange}
          />
        )}

        {/* Returns View */}
        {activeView === 'returns' && (
          <ReturnsTab data={returnsData} isLoading={returnsLoading} />
        )}

        {/* Cashflow View */}
        {activeView === 'cashflow' && (
          <CashflowTab data={financeData} isLoading={financeLoading} dateFrom={filters.dateFrom} dateTo={filters.dateTo} />
        )}
          </>
        )}
      </div>
    </div>
  );
}
