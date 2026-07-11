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
  tiktok_product_id?: string;
  image_url?: string;
  sku?: string;
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
  platform_fee?: number;
  units_sold?: number;
  units?: number;
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
  totalUnits: number; // units/quantity sold (distinct from totalUnitsSold, which is order count on the dashboard)
  entryCount: number;
  avgViewsPerVideo: number;
  revenuePerVideo: number;
  profitPerVideo: number;
  roas: number | null;
  topProduct: { name: string; profit: number } | null;
  productProfits: Record<string, { profit: number; gmv: number; unitsSold: number }>;
  returnsCount?: number;
  returnsAmount?: number;
  samplesCount?: number;
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

export type EmployeeStatus = 'active' | 'probation' | 'former';

// Suggested roles the UI offers as presets; `role` is stored as free text so other
// values are allowed.
export type EmployeeRole = 'host' | 'fulfillment' | 'manager' | 'support' | 'other';

export interface Employee {
  id: string;
  user_id: string;
  name: string;
  role: string;
  status: EmployeeStatus;
  hourly_rate: number;
  hire_date: string | null;
  probation_end_date: string | null;
  store_id?: string | null;
  created_at: string;
  updated_at: string;
}

export interface Shift {
  id: string;
  user_id: string;
  employee_id: string;
  date: string;
  start_time: string; // 'HH:MM' or 'HH:MM:SS'
  end_time: string | null; // null = OPEN shift (in progress, not yet ended)
  store_id?: string | null;
  // Set when this row was MATERIALIZED from a recurring rule (migration 055); NULL = a
  // plain one-off shift. FK is ON DELETE SET NULL, so deleting the rule keeps the row.
  source_rule_id?: string | null;
  created_at: string;
  updated_at: string;
}

// A recurring-shift RULE. Instances are computed from the rule minus its
// exceptions at read time — never materialized (see migration 047).
export interface ShiftRule {
  id: string;
  user_id: string;
  employee_id: string;
  days_of_week: number[]; // getUTCDay() numbers: 0=Sun … 6=Sat
  start_time: string;
  end_time: string;
  start_date: string;
  active: boolean;
  store_id?: string | null;
  created_at: string;
  updated_at: string;
}

export type ShiftExceptionType = 'skip' | 'modified';

// A per-date override on a rule: 'skip' suppresses that date's instance;
// 'modified' replaces its hours (a null side falls back to the rule's time).
export interface ShiftException {
  id: string;
  user_id: string;
  rule_id: string;
  date: string;
  type: ShiftExceptionType;
  modified_start: string | null;
  modified_end: string | null;
  created_at: string;
  updated_at: string;
}
