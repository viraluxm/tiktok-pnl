import type { Entry, EntryCalculations, DashboardMetrics, ChartData, MarginLevel } from '@/types';

/**
 * CostsMap: lookup of cost per unit.
 * Keys are "productId" for products without variants,
 * or "productId-variantId" for variant-level costs.
 */
export type CostsMap = Record<string, number>;

/**
 * Calculate profit for a single entry.
 * costPerUnit is the user-entered COGS — looked up from the costs map.
 */
export function calcEntry(entry: Entry, costsMap?: CostsMap): EntryCalculations {
  const gmv = Number(entry.gmv) || 0;
  const videos = Number(entry.videos_posted) || 0;
  const shipping = Number(entry.shipping) || 0;
  const affiliate = Number(entry.affiliate) || 0;
  const ads = Number(entry.ads) || 0;
  const unitsSold = Number(entry.units_sold) || 0;

  // Platform fee is always 6%
  const platformFee = gmv * 0.06;

  // Look up user-entered cost per unit
  let costPerUnit = 0;
  if (costsMap) {
    // Try variant-level cost first, then product-level
    if (entry.variant_id) {
      costPerUnit = costsMap[`${entry.product_id}-${entry.variant_id}`] || costsMap[entry.product_id] || 0;
    } else {
      costPerUnit = costsMap[entry.product_id] || 0;
    }
  }

  const totalCogs = costPerUnit * unitsSold;
  const totalNetProfit = gmv - platformFee - shipping - affiliate - ads - totalCogs;
  const grossRevPerVideo = videos > 0 ? gmv / videos : 0;
  const netProfitPerVideo = videos > 0 ? totalNetProfit / videos : 0;
  const margin = gmv > 0 ? (totalNetProfit / gmv) * 100 : 0;

  return { grossRevPerVideo, cogs: platformFee + totalCogs, totalNetProfit, netProfitPerVideo, margin };
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

export function computeDashboardMetrics(entries: Entry[], costsMap?: CostsMap): DashboardMetrics {
  let totalGMV = 0;
  let totalVideos = 0;
  let totalViews = 0;
  let totalShipping = 0;
  let totalAffiliate = 0;
  let totalAds = 0;
  let totalCogs = 0;
  let totalNetProfit = 0;
  let totalUnitsSold = 0;
  const productProfits: Record<string, { profit: number; gmv: number; unitsSold: number }> = {};

  entries.forEach((e) => {
    const c = calcEntry(e, costsMap);
    const gmv = Number(e.gmv) || 0;
    const units = Number(e.units_sold) || 0;
    totalGMV += gmv;
    totalVideos += Number(e.videos_posted) || 0;
    totalViews += Number(e.views) || 0;
    totalShipping += Number(e.shipping) || 0;
    totalAffiliate += Number(e.affiliate) || 0;
    totalAds += Number(e.ads) || 0;
    totalCogs += c.cogs;
    totalNetProfit += c.totalNetProfit;
    totalUnitsSold += units;

    const productName = e.product?.name || 'Unknown';
    if (!productProfits[productName]) {
      productProfits[productName] = { profit: 0, gmv: 0, unitsSold: 0 };
    }
    productProfits[productName].profit += c.totalNetProfit;
    productProfits[productName].gmv += gmv;
    productProfits[productName].unitsSold += units;
  });

  const avgMargin = totalGMV > 0 ? (totalNetProfit / totalGMV) * 100 : 0;
  const avgViewsPerVideo = totalVideos > 0 ? totalViews / totalVideos : 0;
  const revenuePerVideo = totalVideos > 0 ? totalGMV / totalVideos : 0;
  const profitPerVideo = totalVideos > 0 ? totalNetProfit / totalVideos : 0;
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
    totalAffiliate,
    totalShipping,
    totalUnitsSold,
    entryCount: entries.length,
    avgViewsPerVideo,
    revenuePerVideo,
    profitPerVideo,
    roas,
    topProduct,
    productProfits,
  };
}

export function computeChartData(entries: Entry[], costsMap?: CostsMap): ChartData {
  // Profit by date
  const profitByDateMap: Record<string, number> = {};
  const gmvByDateMap: Record<string, number> = {};
  const profitByDateMapForMargin: Record<string, number> = {};
  const productProfits: Record<string, { profit: number; gmv: number }> = {};

  // Cost totals for breakdown
  let totalPlatformFee = 0;
  let totalUserCogs = 0;
  let totalShipping = 0;
  let totalAffiliate = 0;
  let totalAds = 0;
  let totalProfit = 0;

  entries.forEach((e) => {
    const c = calcEntry(e, costsMap);
    const gmv = Number(e.gmv) || 0;
    const unitsSold = Number(e.units_sold) || 0;

    // Calculate user COGS separately for the breakdown
    let costPerUnit = 0;
    if (costsMap) {
      if (e.variant_id) {
        costPerUnit = costsMap[`${e.product_id}-${e.variant_id}`] || costsMap[e.product_id] || 0;
      } else {
        costPerUnit = costsMap[e.product_id] || 0;
      }
    }
    const userCogs = costPerUnit * unitsSold;
    const platformFee = gmv * 0.06;

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
    totalPlatformFee += platformFee;
    totalUserCogs += userCogs;
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

  // Product compare — sorted by GMV descending
  const prodEntries = Object.entries(productProfits).sort((a, b) => b[1].gmv - a[1].gmv);
  const productCompare = {
    labels: prodEntries.map(([name]) => name),
    gmv: prodEntries.map(([, data]) => data.gmv),
    profit: prodEntries.map(([, data]) => data.profit),
  };

  // Cost breakdown — as percentages adding up to 100%
  // If user has entered COGS, show it separately from platform fee
  const hasUserCogs = totalUserCogs > 0;
  const breakdownLabels = hasUserCogs
    ? ['Platform Fee (6%)', 'COGS', 'Shipping', 'Affiliate', 'Ads', 'Net Profit']
    : ['Platform Fee (6%)', 'Shipping', 'Affiliate', 'Ads', 'Net Profit'];
  const rawCostAmounts = hasUserCogs
    ? [
        Math.max(0, totalPlatformFee),
        Math.max(0, totalUserCogs),
        Math.max(0, totalShipping),
        Math.max(0, totalAffiliate),
        Math.max(0, totalAds),
        Math.max(0, totalProfit),
      ]
    : [
        Math.max(0, totalPlatformFee),
        Math.max(0, totalShipping),
        Math.max(0, totalAffiliate),
        Math.max(0, totalAds),
        Math.max(0, totalProfit),
      ];
  const breakdownColors = hasUserCogs
    ? ['#ff6384', '#f97316', '#ff9f40', '#ffcd56', '#EE1D52', '#69C9D0']
    : ['#ff6384', '#ff9f40', '#ffcd56', '#EE1D52', '#69C9D0'];

  const totalCosts = rawCostAmounts.reduce((a, b) => a + b, 0);
  const costBreakdown = {
    labels: breakdownLabels,
    data: totalCosts > 0
      ? rawCostAmounts.map((v) => (v / totalCosts) * 100)
      : rawCostAmounts.map(() => 0),
    colors: breakdownColors,
    rawAmounts: rawCostAmounts,
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
