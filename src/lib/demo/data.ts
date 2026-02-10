import type { Product, Entry } from '@/types';

// ============================================================
// Demo Store Configuration
// ============================================================

export const DEMO_USER_EMAIL = 'Alvaro@viralux.media';
export const DEMO_USER_PASSWORD = 'Tiktok2001!';
export const DEMO_SHOP_NAME = 'Demo Store';
export const DEMO_USER_ID = 'demo-user-00000000-0000-0000-0000-000000000000';

// ============================================================
// Demo Products — realistic TikTok Shop products with SKUs & COGS
// ============================================================

export interface DemoProductVariant {
  id: string;
  name: string;
  sku: string;
  cogs: number;
  avgPrice: number;
}

export interface DemoProduct extends Product {
  sku: string;
  cogs: number;       // Cost of goods sold per unit
  avgPrice: number;    // Average selling price
  category: string;
  demoVariants?: DemoProductVariant[];
}

const productDefs: Array<{
  name: string;
  sku: string;
  cogs: number;
  avgPrice: number;
  category: string;
  variants?: Array<{ name: string; sku: string; cogs: number; avgPrice: number }>;
}> = [
  {
    name: 'LED Ring Light 10"', sku: 'RL-10-001', cogs: 8.50, avgPrice: 29.99, category: 'Lighting',
    variants: [
      { name: '1 Pack', sku: 'RL-10-1PK', cogs: 8.50, avgPrice: 29.99 },
      { name: '2 Pack', sku: 'RL-10-2PK', cogs: 15.00, avgPrice: 54.99 },
      { name: '3 Pack', sku: 'RL-10-3PK', cogs: 20.00, avgPrice: 74.99 },
    ],
  },
  { name: 'Portable Phone Tripod', sku: 'PT-MINI-02', cogs: 5.20, avgPrice: 19.99, category: 'Accessories' },
  { name: 'Wireless Lavalier Mic', sku: 'WM-LAV-03', cogs: 12.00, avgPrice: 39.99, category: 'Audio' },
  { name: 'Backdrop Green Screen', sku: 'BG-GS-04', cogs: 15.00, avgPrice: 49.99, category: 'Backdrops' },
  { name: 'Content Planner Notebook', sku: 'CP-NB-05', cogs: 3.50, avgPrice: 14.99, category: 'Stationery' },
  { name: 'USB-C Card Reader', sku: 'CR-UC-06', cogs: 4.80, avgPrice: 16.99, category: 'Tech' },
  { name: 'Clip-On Wide Angle Lens', sku: 'CL-WA-07', cogs: 6.00, avgPrice: 24.99, category: 'Lenses' },
  { name: 'Desktop Softbox Kit', sku: 'SB-DK-08', cogs: 22.00, avgPrice: 64.99, category: 'Lighting' },
];

function makeProductId(index: number): string {
  return `demo-product-${String(index).padStart(4, '0')}`;
}

export const DEMO_PRODUCTS: DemoProduct[] = productDefs.map((p, i) => ({
  id: makeProductId(i),
  user_id: DEMO_USER_ID,
  name: p.name,
  created_at: new Date(Date.now() - 90 * 86400000).toISOString(),
  sku: p.sku,
  cogs: p.cogs,
  avgPrice: p.avgPrice,
  category: p.category,
  variants: p.variants?.map((v, vi) => ({
    id: `${makeProductId(i)}-var-${vi}`,
    name: v.name,
    sku: v.sku,
  })),
  demoVariants: p.variants?.map((v, vi) => ({
    id: `${makeProductId(i)}-var-${vi}`,
    name: v.name,
    sku: v.sku,
    cogs: v.cogs,
    avgPrice: v.avgPrice,
  })),
}));

// ============================================================
// Seeded PRNG — deterministic "random" so data stays consistent
// ============================================================

function seededRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 16807 + 0) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

// ============================================================
// Order Status Distribution
// ============================================================

type OrderStatus = 'completed' | 'shipped' | 'cancelled' | 'refunded';

const STATUS_WEIGHTS: Array<{ status: OrderStatus; weight: number }> = [
  { status: 'completed', weight: 0.65 },
  { status: 'shipped', weight: 0.18 },
  { status: 'cancelled', weight: 0.10 },
  { status: 'refunded', weight: 0.07 },
];

function pickStatus(rand: () => number): OrderStatus {
  const r = rand();
  let cumulative = 0;
  for (const sw of STATUS_WEIGHTS) {
    cumulative += sw.weight;
    if (r < cumulative) return sw.status;
  }
  return 'completed';
}

// ============================================================
// Individual Order Type (for detailed view if needed)
// ============================================================

export interface DemoOrder {
  id: string;
  date: string;
  product: DemoProduct;
  quantity: number;
  unitPrice: number;
  totalAmount: number;
  platformFeeRate: number;
  platformFee: number;
  commissionRate: number;
  commissionFee: number;
  shippingCost: number;
  affiliateCommission: number;
  cogs: number;
  netProfit: number;
  status: OrderStatus;
}

// ============================================================
// Generate Orders — 80 orders across last 60 days
// ============================================================

export function generateDemoOrders(): DemoOrder[] {
  const rand = seededRandom(42);
  const orders: DemoOrder[] = [];
  const now = new Date();
  const numOrders = 80;

  for (let i = 0; i < numOrders; i++) {
    const daysAgo = Math.floor(rand() * 60);
    const date = new Date(now.getTime() - daysAgo * 86400000);
    const dateStr = date.toISOString().split('T')[0];

    // Pick a random product (weighted: first few products are best sellers)
    const weights = [0.22, 0.18, 0.16, 0.14, 0.10, 0.08, 0.07, 0.05];
    let r = rand();
    let productIndex = 0;
    let cum = 0;
    for (let j = 0; j < weights.length; j++) {
      cum += weights[j];
      if (r < cum) { productIndex = j; break; }
    }
    const product = DEMO_PRODUCTS[productIndex];

    const quantity = Math.floor(rand() * 3) + 1; // 1-3 units
    const priceVariation = product.avgPrice * (0.9 + rand() * 0.2); // ±10%
    const unitPrice = Math.round(priceVariation * 100) / 100;
    const totalAmount = Math.round(unitPrice * quantity * 100) / 100;

    // TikTok platform fee (2-8%)
    const platformFeeRate = 0.02 + rand() * 0.06;
    const platformFee = Math.round(totalAmount * platformFeeRate * 100) / 100;

    // Commission fee (1-5%)
    const commissionRate = 0.01 + rand() * 0.04;
    const commissionFee = Math.round(totalAmount * commissionRate * 100) / 100;

    // Shipping ($3-8)
    const shippingCost = Math.round((3 + rand() * 5) * 100) / 100;

    // Affiliate commission (some orders have affiliate, ~40%)
    const hasAffiliate = rand() < 0.4;
    const affiliateRate = hasAffiliate ? (0.05 + rand() * 0.15) : 0; // 5-20%
    const affiliateCommission = Math.round(totalAmount * affiliateRate * 100) / 100;

    // COGS
    const cogs = Math.round(product.cogs * quantity * 100) / 100;

    const status = pickStatus(rand);

    // Net profit (0 for cancelled/refunded)
    let netProfit = 0;
    if (status === 'completed' || status === 'shipped') {
      netProfit = totalAmount - platformFee - commissionFee - shippingCost - affiliateCommission - cogs;
      netProfit = Math.round(netProfit * 100) / 100;
    } else if (status === 'refunded') {
      // Refund = we lose shipping + platform fee (often non-refundable)
      netProfit = -(shippingCost + platformFee);
      netProfit = Math.round(netProfit * 100) / 100;
    }

    orders.push({
      id: `demo-order-${String(i).padStart(5, '0')}`,
      date: dateStr,
      product,
      quantity,
      unitPrice,
      totalAmount,
      platformFeeRate,
      platformFee,
      commissionRate,
      commissionFee,
      shippingCost,
      affiliateCommission,
      cogs,
      netProfit,
      status,
    });
  }

  // Sort by date descending
  orders.sort((a, b) => b.date.localeCompare(a.date));
  return orders;
}

// ============================================================
// Aggregate orders into daily entries (matching Entry type)
// ============================================================

export function generateDemoEntries(): Entry[] {
  const orders = generateDemoOrders();

  // Group by date + product
  const grouped = new Map<string, {
    date: string;
    product: DemoProduct;
    gmv: number;
    shipping: number;
    affiliate: number;
    ads: number;
    orders: DemoOrder[];
  }>();

  for (const order of orders) {
    // Skip cancelled orders from aggregation (they never generated revenue)
    if (order.status === 'cancelled') continue;

    const key = `${order.date}__${order.product.id}`;
    if (!grouped.has(key)) {
      grouped.set(key, {
        date: order.date,
        product: order.product,
        gmv: 0,
        shipping: 0,
        affiliate: 0,
        ads: 0,
        orders: [],
      });
    }
    const g = grouped.get(key)!;
    g.orders.push(order);

    if (order.status === 'refunded') {
      // Refunded orders subtract from GMV
      g.gmv -= order.totalAmount;
      g.shipping += order.shippingCost; // We still paid shipping
    } else {
      g.gmv += order.totalAmount;
      g.shipping += order.shippingCost;
      g.affiliate += order.affiliateCommission;
    }
  }

  // Add some ad spend — not all days, but many
  const rand = seededRandom(99);
  const entries: Entry[] = [];
  let entryIndex = 0;

  for (const [, g] of grouped) {
    // Ad spend: 60% of days have some ad spend ($5-50)
    const hasAds = rand() < 0.6;
    const adSpend = hasAds ? Math.round((5 + rand() * 45) * 100) / 100 : 0;

    // Videos posted & views for engagement metrics
    const videosPosted = Math.floor(rand() * 4); // 0-3
    const viewsPerVideo = 500 + Math.floor(rand() * 15000);
    const views = videosPosted * viewsPerVideo;

    // Calculate units sold from orders
    const unitsSold = g.orders.reduce((sum, o) => sum + (o.status !== 'cancelled' ? o.quantity : 0), 0);

    // Pick a variant if the product has variants
    const variantId = g.product.demoVariants && g.product.demoVariants.length > 0
      ? g.product.demoVariants[Math.floor(rand() * g.product.demoVariants.length)].id
      : undefined;

    entries.push({
      id: `demo-entry-${String(entryIndex).padStart(5, '0')}`,
      user_id: DEMO_USER_ID,
      product_id: g.product.id,
      date: g.date,
      gmv: Math.max(0, Math.round(g.gmv * 100) / 100),
      videos_posted: videosPosted,
      views,
      shipping: Math.round(g.shipping * 100) / 100,
      affiliate: Math.round(g.affiliate * 100) / 100,
      ads: adSpend,
      units_sold: unitsSold,
      variant_id: variantId,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      source: 'tiktok',
      product: {
        id: g.product.id,
        user_id: DEMO_USER_ID,
        name: g.product.name,
        created_at: g.product.created_at,
        variants: g.product.variants,
      },
    });
    entryIndex++;
  }

  // Sort by date descending
  entries.sort((a, b) => b.date.localeCompare(a.date));
  return entries;
}

// ============================================================
// Settlement / Payout Mock Data
// ============================================================

export interface DemoSettlement {
  id: string;
  period: string;
  startDate: string;
  endDate: string;
  totalRevenue: number;
  totalFees: number;
  totalShipping: number;
  totalAffiliate: number;
  netPayout: number;
  status: 'paid' | 'pending' | 'processing';
  paidAt: string | null;
}

export function generateDemoSettlements(): DemoSettlement[] {
  const now = new Date();
  const settlements: DemoSettlement[] = [];

  // Generate 4 weekly settlements
  for (let i = 0; i < 4; i++) {
    const endDate = new Date(now.getTime() - i * 7 * 86400000);
    const startDate = new Date(endDate.getTime() - 7 * 86400000);

    const revenue = 800 + Math.random() * 1200;
    const fees = revenue * 0.06;
    const shipping = 40 + Math.random() * 80;
    const affiliate = revenue * 0.04;
    const netPayout = revenue - fees - shipping - affiliate;

    settlements.push({
      id: `demo-settlement-${i}`,
      period: `Week ${i + 1}`,
      startDate: startDate.toISOString().split('T')[0],
      endDate: endDate.toISOString().split('T')[0],
      totalRevenue: Math.round(revenue * 100) / 100,
      totalFees: Math.round(fees * 100) / 100,
      totalShipping: Math.round(shipping * 100) / 100,
      totalAffiliate: Math.round(affiliate * 100) / 100,
      netPayout: Math.round(netPayout * 100) / 100,
      status: i === 0 ? 'pending' : i === 1 ? 'processing' : 'paid',
      paidAt: i >= 2 ? new Date(endDate.getTime() + 3 * 86400000).toISOString() : null,
    });
  }

  return settlements;
}

// ============================================================
// Summary statistics for the demo
// ============================================================

export function getDemoSummary() {
  const orders = generateDemoOrders();
  const entries = generateDemoEntries();

  const completedOrders = orders.filter(o => o.status === 'completed' || o.status === 'shipped');
  const cancelledOrders = orders.filter(o => o.status === 'cancelled');
  const refundedOrders = orders.filter(o => o.status === 'refunded');

  const totalRevenue = completedOrders.reduce((sum, o) => sum + o.totalAmount, 0);
  const totalFees = completedOrders.reduce((sum, o) => sum + o.platformFee + o.commissionFee, 0);
  const totalCOGS = completedOrders.reduce((sum, o) => sum + o.cogs, 0);
  const totalShipping = completedOrders.reduce((sum, o) => sum + o.shippingCost, 0);
  const totalAffiliate = completedOrders.reduce((sum, o) => sum + o.affiliateCommission, 0);

  return {
    totalOrders: orders.length,
    completedOrders: completedOrders.length,
    cancelledOrders: cancelledOrders.length,
    refundedOrders: refundedOrders.length,
    totalRevenue: Math.round(totalRevenue * 100) / 100,
    totalFees: Math.round(totalFees * 100) / 100,
    totalCOGS: Math.round(totalCOGS * 100) / 100,
    totalShipping: Math.round(totalShipping * 100) / 100,
    totalAffiliate: Math.round(totalAffiliate * 100) / 100,
    netProfit: Math.round((totalRevenue - totalFees - totalCOGS - totalShipping - totalAffiliate) * 100) / 100,
    entries: entries.length,
    products: DEMO_PRODUCTS.length,
    dateRange: {
      from: entries[entries.length - 1]?.date || '',
      to: entries[0]?.date || '',
    },
  };
}
