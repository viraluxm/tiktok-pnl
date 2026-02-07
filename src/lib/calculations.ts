import type { Entry, EntryCalculations, DashboardMetrics, ChartData, MarginLevel } from '@/types';

export function calcEntry(entry: Entry): EntryCalculations {
  const gmv = Number(entry.gmv) || 0;
  const videos = Number(entry.videos_posted) || 0;
  const shipping = Number(entry.shipping) || 0;
  const affiliate = Number(entry.affiliate) || 0;
  const ads = Number(entry.ads) || 0;

  const cogs = gmv * 0.06;
  const totalNetProfit = gmv - cogs - shipping - affiliate - ads;
  const grossRevPerVideo = videos > 0 ? gmv / videos : 0;
  const netProfitPerVideo = videos > 0 ? totalNetProfit / videos : 0;
  const margin = gmv > 0 ? (totalNetProfit / gmv) * 100 : 0;

  return { grossRevPerVideo, cogs, totalNetProfit, netProfitPerVideo, margin };
}

export function getMarginLevel(margin: number): MarginLevel {
  if (margin >= 25) return 'green';
  if (margin >= 10) return 'yellow';
  return 'red';
}

export function fmt(n: number | null | undefined): string {
  if (n == null || isNaN(n)) return '$0.00';
  return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function fmtInt(n: number | null | undefined): string {
  if (n == null || isNaN(n)) return '0';
  return Number(n).toLocaleString('en-US');
}

export function fmtPct(n: number | null | undefined): string {
  if (n == null || isNaN(n)) return '0.0%';
  return Number(n).toFixed(1) + '%';
}

export function computeDashboardMetrics(entries: Entry[]): DashboardMetrics {
  let totalGMV = 0;
  let totalVideos = 0;
  let totalViews = 0;
  let totalShipping = 0;
  let totalAffiliate = 0;
  let totalAds = 0;
  let totalCogs = 0;
  let totalNetProfit = 0;
  const productProfits: Record<string, { profit: number; gmv: number }> = {};

  entries.forEach((e) => {
    const c = calcEntry(e);
    const gmv = Number(e.gmv) || 0;
    totalGMV += gmv;
    totalVideos += Number(e.videos_posted) || 0;
    totalViews += Number(e.views) || 0;
    totalShipping += Number(e.shipping) || 0;
    totalAffiliate += Number(e.affiliate) || 0;
    totalAds += Number(e.ads) || 0;
    totalCogs += c.cogs;
    totalNetProfit += c.totalNetProfit;

    const productName = e.product?.name || 'Unknown';
    if (!productProfits[productName]) {
      productProfits[productName] = { profit: 0, gmv: 0 };
    }
    productProfits[productName].profit += c.totalNetProfit;
    productProfits[productName].gmv += gmv;
  });

  const avgMargin = totalGMV > 0 ? (totalNetProfit / totalGMV) * 100 : 0;
  const avgViewsPerVideo = totalVideos > 0 ? totalViews / totalVideos : 0;
  const roas = totalAds > 0 ? totalGMV / totalAds : null;

  let topProduct: { name: string; profit: number } | null = null;
  Object.entries(productProfits).forEach(([name, data]) => {
    if (!topProduct || data.profit > topProduct.profit) {
      topProduct = { name, profit: data.profit };
    }
  });

  return {
    totalGMV,
    totalNetProfit,
    avgMargin,
    totalVideos,
    totalViews,
    totalAds,
    entryCount: entries.length,
    avgViewsPerVideo,
    roas,
    topProduct,
    productProfits,
  };
}

export function computeChartData(entries: Entry[]): ChartData {
  // Profit by date
  const profitByDateMap: Record<string, number> = {};
  const gmvByDateMap: Record<string, number> = {};
  const profitByDateMapForMargin: Record<string, number> = {};
  const productProfits: Record<string, { profit: number; gmv: number }> = {};

  // Cost totals for breakdown
  let totalCogs = 0;
  let totalShipping = 0;
  let totalAffiliate = 0;
  let totalAds = 0;
  let totalProfit = 0;

  entries.forEach((e) => {
    const c = calcEntry(e);
    const gmv = Number(e.gmv) || 0;

    // Profit by date
    if (!profitByDateMap[e.date]) profitByDateMap[e.date] = 0;
    profitByDateMap[e.date] += c.totalNetProfit;

    // GMV + profit by date for margin
    if (!gmvByDateMap[e.date]) { gmvByDateMap[e.date] = 0; profitByDateMapForMargin[e.date] = 0; }
    gmvByDateMap[e.date] += gmv;
    profitByDateMapForMargin[e.date] += c.totalNetProfit;

    // By product
    const productName = e.product?.name || 'Unknown';
    if (!productProfits[productName]) productProfits[productName] = { profit: 0, gmv: 0 };
    productProfits[productName].profit += c.totalNetProfit;
    productProfits[productName].gmv += gmv;

    // Cost totals
    totalCogs += c.cogs;
    totalShipping += Number(e.shipping) || 0;
    totalAffiliate += Number(e.affiliate) || 0;
    totalAds += Number(e.ads) || 0;
    totalProfit += c.totalNetProfit;
  });

  // Sort dates
  const sortedDates = Object.keys(profitByDateMap).sort();
  const profitByDate = {
    labels: sortedDates,
    data: sortedDates.map((d) => profitByDateMap[d]),
  };

  // Product compare
  const prodNames = Object.keys(productProfits);
  const productCompare = {
    labels: prodNames,
    gmv: prodNames.map((p) => productProfits[p].gmv),
    profit: prodNames.map((p) => productProfits[p].profit),
  };

  // Cost breakdown
  const costBreakdown = {
    labels: ['Platform Fee (6%)', 'Shipping', 'Affiliate', 'Ads', 'Net Profit'],
    data: [
      Math.max(0, totalCogs),
      Math.max(0, totalShipping),
      Math.max(0, totalAffiliate),
      Math.max(0, totalAds),
      Math.max(0, totalProfit),
    ],
    colors: ['#ff6384', '#ff9f40', '#ffcd56', '#EE1D52', '#69C9D0'],
  };

  // Margin by date
  const marginDates = Object.keys(gmvByDateMap).sort();
  const marginByDate = {
    labels: marginDates,
    data: marginDates.map((d) =>
      gmvByDateMap[d] > 0 ? (profitByDateMapForMargin[d] / gmvByDateMap[d]) * 100 : 0
    ),
  };

  return { profitByDate, productCompare, costBreakdown, marginByDate };
}
