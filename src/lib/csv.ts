import type { Entry } from '@/types';
import { calcEntry } from './calculations';

export function exportCSV(entries: Entry[]): void {
  const headers = [
    'date', 'product', 'gmv', 'videos_posted', 'views',
    'gross_rev_per_video', 'cogs_6pct', 'shipping', 'affiliate', 'ads',
    'net_profit_per_video', 'total_net_profit', 'margin_pct',
  ];

  const rows = entries.map((e) => {
    const c = calcEntry(e);
    return [
      e.date,
      `"${e.product?.name || 'Unknown'}"`,
      e.gmv || 0,
      e.videos_posted || 0,
      e.views || 0,
      c.grossRevPerVideo.toFixed(2),
      c.cogs.toFixed(2),
      e.shipping || 0,
      e.affiliate || 0,
      e.ads || 0,
      c.netProfitPerVideo.toFixed(2),
      c.totalNetProfit.toFixed(2),
      c.margin.toFixed(1),
    ].join(',');
  });

  const csv = [headers.join(','), ...rows].join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `tiktok_pnl_${new Date().toISOString().split('T')[0]}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export interface ParsedCSVEntry {
  date: string;
  productName: string;
  gmv: number;
  videosPosted: number;
  views: number;
  shipping: number;
  affiliate: number;
  ads: number;
}

export function parseCSVData(text: string): ParsedCSVEntry[] {
  const lines = text.trim().split('\n');
  if (lines.length < 2) return [];

  const headers = lines[0].toLowerCase().split(',').map((h) => h.trim().replace(/"/g, ''));
  const dateIdx = headers.indexOf('date');
  const productIdx = headers.indexOf('product');
  const gmvIdx = headers.indexOf('gmv');
  const videosIdx = headers.findIndex((h) => h.includes('video') && h.includes('post'));
  const viewsIdx = headers.indexOf('views');
  const shippingIdx = headers.indexOf('shipping');
  const affiliateIdx = headers.indexOf('affiliate');
  const adsIdx = headers.indexOf('ads');

  const results: ParsedCSVEntry[] = [];

  for (let i = 1; i < lines.length; i++) {
    const vals = lines[i].split(',').map((v) => v.trim().replace(/"/g, ''));
    if (vals.length < 3) continue;

    results.push({
      date: dateIdx >= 0 ? vals[dateIdx] : new Date().toISOString().split('T')[0],
      productName: productIdx >= 0 ? vals[productIdx] : 'Imported',
      gmv: gmvIdx >= 0 ? parseFloat(vals[gmvIdx]) || 0 : 0,
      videosPosted: videosIdx >= 0 ? parseInt(vals[videosIdx]) || 0 : 0,
      views: viewsIdx >= 0 ? parseInt(vals[viewsIdx]) || 0 : 0,
      shipping: shippingIdx >= 0 ? parseFloat(vals[shippingIdx]) || 0 : 0,
      affiliate: affiliateIdx >= 0 ? parseFloat(vals[affiliateIdx]) || 0 : 0,
      ads: adsIdx >= 0 ? parseFloat(vals[adsIdx]) || 0 : 0,
    });
  }

  return results;
}
