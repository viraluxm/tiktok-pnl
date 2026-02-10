export interface ProductVariant {
  id: string;
  name: string;
  sku?: string;
}

export interface Product {
  id: string;
  user_id: string;
  name: string;
  created_at: string;
  variants?: ProductVariant[];
}

export interface Entry {
  id: string;
  user_id: string;
  product_id: string;
  date: string;
  gmv: number;
  videos_posted: number;
  views: number;
  shipping: number;
  affiliate: number;
  ads: number;
  units_sold?: number;
  variant_id?: string;
  created_at: string;
  updated_at: string;
  source?: 'manual' | 'tiktok';
  product?: Product;
}

export interface EntryCalculations {
  grossRevPerVideo: number;
  cogs: number;
  totalNetProfit: number;
  netProfitPerVideo: number;
  margin: number;
}

export interface DashboardMetrics {
  totalGMV: number;
  totalNetProfit: number;
  avgMargin: number;
  totalVideos: number;
  totalViews: number;
  totalAds: number;
  totalAffiliate: number;
  totalShipping: number;
  totalUnitsSold: number;
  entryCount: number;
  avgViewsPerVideo: number;
  revenuePerVideo: number;
  profitPerVideo: number;
  roas: number | null;
  topProduct: { name: string; profit: number } | null;
  productProfits: Record<string, { profit: number; gmv: number; unitsSold: number }>;
}

export interface ChartData {
  profitByDate: { labels: string[]; data: number[] };
  gmvByDate: { labels: string[]; data: number[] };
  productCompare: { labels: string[]; gmv: number[]; profit: number[] };
  costBreakdown: { labels: string[]; data: number[]; colors: string[]; rawAmounts: number[] };
  marginByDate: { labels: string[]; data: number[] };
}

export interface FilterState {
  dateFrom: string | null;
  dateTo: string | null;
  productId: string; // 'all' | uuid
}

export type MarginLevel = 'green' | 'yellow' | 'red';
