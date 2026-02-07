export interface Product {
  id: string;
  user_id: string;
  name: string;
  created_at: string;
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
  created_at: string;
  updated_at: string;
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
  entryCount: number;
  avgViewsPerVideo: number;
  roas: number | null;
  topProduct: { name: string; profit: number } | null;
  productProfits: Record<string, { profit: number; gmv: number }>;
}

export interface ChartData {
  profitByDate: { labels: string[]; data: number[] };
  productCompare: { labels: string[]; gmv: number[]; profit: number[] };
  costBreakdown: { labels: string[]; data: number[]; colors: string[] };
  marginByDate: { labels: string[]; data: number[] };
}

export interface FilterState {
  dateFrom: string | null;
  dateTo: string | null;
  productId: string; // 'all' | uuid
}

export type MarginLevel = 'green' | 'yellow' | 'red';
