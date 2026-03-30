// Server-only TikTok Shop API client
// Handles OAuth and Shop Open API (orders, products, finance)

import crypto from 'crypto';
import { TIKTOK_SHOP_APP_KEY, TIKTOK_SHOP_APP_SECRET } from '@/lib/env';

// TikTok Shop OAuth & API endpoints
const TIKTOK_SHOP_AUTH_URL = 'https://services.us.tiktokshop.com/open/authorize';
const TIKTOK_SHOP_TOKEN_URL = 'https://auth.tiktok-shops.com/api/v2/token/get';
const TIKTOK_SHOP_REFRESH_URL = 'https://auth.tiktok-shops.com/api/v2/token/refresh';
const TIKTOK_SHOP_BASE = 'https://open-api.tiktokglobalshop.com';

function getServiceId() {
  return (process.env.TIKTOK_SHOP_SERVICE_ID || '').trim();
}

// ==================== OAUTH ====================

export function getAuthUrl(state: string): string {
  const params = new URLSearchParams({
    service_id: getServiceId(),
    state,
  });
  return `${TIKTOK_SHOP_AUTH_URL}?${params.toString()}`;
}

export interface TikTokShopTokenResponse {
  access_token: string;
  access_token_expire_in: number;
  refresh_token: string;
  refresh_token_expire_in: number;
  open_id: string;
  seller_name: string;
  seller_base_region: string;
  user_type: number;
}

export async function exchangeCodeForToken(code: string): Promise<TikTokShopTokenResponse> {
  const params = new URLSearchParams({
    app_key: TIKTOK_SHOP_APP_KEY,
    app_secret: TIKTOK_SHOP_APP_SECRET,
    auth_code: code,
    grant_type: 'authorized_code',
  });

  const url = `${TIKTOK_SHOP_TOKEN_URL}?${params.toString()}`;

  const res = await fetch(url, { method: 'GET' });
  const rawText = await res.text();

  console.log('[TikTok token exchange] HTTP status:', res.status);
  console.log('[TikTok token exchange] Raw response:', rawText);

  let json: Record<string, unknown>;
  try {
    json = JSON.parse(rawText);
  } catch {
    throw new Error(`TikTok token response is not JSON (HTTP ${res.status}): ${rawText.slice(0, 500)}`);
  }

  if (json.code !== 0) {
    console.error('[TikTok token exchange] Error response:', JSON.stringify(json, null, 2));
    throw new Error(`TikTok Shop token exchange failed: ${json.message || 'unknown error'} (code: ${json.code})`);
  }

  return json.data as TikTokShopTokenResponse;
}

export async function refreshAccessToken(refreshToken: string): Promise<TikTokShopTokenResponse> {
  // POST with form-encoded body to keep app_secret out of URLs
  const body = new URLSearchParams({
    app_key: TIKTOK_SHOP_APP_KEY,
    app_secret: TIKTOK_SHOP_APP_SECRET,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });

  const res = await fetch(TIKTOK_SHOP_REFRESH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  const json = await res.json();

  if (json.code !== 0) {
    throw new Error(`TikTok Shop token refresh failed: ${json.message || 'unknown error'}`);
  }

  return json.data as TikTokShopTokenResponse;
}

// ==================== SHOP API (HMAC SIGNED) ====================

function generateShopSignature(path: string, params: Record<string, string>, body?: string): string {
  const secret = TIKTOK_SHOP_APP_SECRET;

  // Sort params by key (exclude sign and access_token)
  const sortedKeys = Object.keys(params)
    .filter(k => k !== 'sign' && k !== 'access_token')
    .sort();
  const paramString = sortedKeys.map((k) => `${k}${params[k]}`).join('');

  // Sign: secret + path + sorted_params + body + secret
  const signString = `${secret}${path}${paramString}${body || ''}${secret}`;

  return crypto.createHmac('sha256', secret).update(signString).digest('hex');
}

export async function shopGet(path: string, accessToken: string, extraParams: Record<string, string> = {}) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const appKey = TIKTOK_SHOP_APP_KEY;

  const params: Record<string, string> = {
    app_key: appKey,
    timestamp,
    ...extraParams,
  };

  const sign = generateShopSignature(path, params);
  params.sign = sign;

  const qs = new URLSearchParams(params).toString();
  const fullUrl = `${TIKTOK_SHOP_BASE}${path}?${qs}`;

  const res = await fetch(fullUrl, {
    headers: {
      'Content-Type': 'application/json',
      'x-tts-access-token': accessToken,
    },
  });

  const rawText = await res.text();

  const json = JSON.parse(rawText);

  if (json.code !== 0) {
    console.error(`[TikTok shopGet] ${path} error:`, JSON.stringify(json, null, 2));
    throw new Error(`TikTok Shop API error: ${json.message || 'unknown error'} (code: ${json.code})`);
  }

  return json.data;
}

export async function shopPost(path: string, accessToken: string, body: Record<string, unknown>, extraParams: Record<string, string> = {}) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const appKey = TIKTOK_SHOP_APP_KEY;
  const bodyString = JSON.stringify(body);

  const params: Record<string, string> = {
    app_key: appKey,
    timestamp,
    ...extraParams,
  };

  const sign = generateShopSignature(path, params, bodyString);
  params.sign = sign;

  const qs = new URLSearchParams(params).toString();
  const fullUrl = `${TIKTOK_SHOP_BASE}${path}?${qs}`;

  const res = await fetch(fullUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-tts-access-token': accessToken,
    },
    body: bodyString,
  });

  const rawText = await res.text();

  const json = JSON.parse(rawText);

  if (json.code !== 0) {
    console.error(`[TikTok shopPost] ${path} error:`, JSON.stringify(json, null, 2));
    throw new Error(`TikTok Shop API error: ${json.message || 'unknown error'} (code: ${json.code})`);
  }

  return json.data;
}

// ==================== SHOP ENDPOINTS ====================

export interface ShopInfo {
  shop_cipher: string;
  shop_name: string;
  region: string;
}

export async function getAuthorizedShops(accessToken: string): Promise<ShopInfo[]> {
  const data = await shopGet('/authorization/202309/shops', accessToken);
  if (!data?.shops) return [];
  return data.shops.map((s: Record<string, string>) => ({
    shop_cipher: s.cipher,
    shop_name: s.name,
    region: s.region,
  }));
}

export interface FetchOrdersPageResult {
  orders: Record<string, unknown>[];
  nextCursor: string | null;
}

export async function fetchOrdersPage(
  accessToken: string,
  shopCipher: string,
  startTs: number,
  endTs: number,
  pageCursor: string | null,
): Promise<FetchOrdersPageResult> {
  const path = '/order/202309/orders/search';

  const body: Record<string, unknown> = {
    create_time_ge: startTs,
    create_time_lt: endTs,
  };

  const queryParams: Record<string, string> = {
    shop_cipher: shopCipher,
    page_size: '50',
    sort_field: 'create_time',
    sort_order: 'DESC',
  };
  if (pageCursor) {
    queryParams.page_token = pageCursor;
  }

  const data = await shopPost(path, accessToken, body, queryParams);
  const orders = data?.orders || [];
  const nextCursor = data?.next_page_token || '';

  // Log pagination info for debugging
  if (orders.length >= 50 || pageCursor) {
    console.log(`[Pagination] ${orders.length} orders, next_page_token=${nextCursor ? 'yes' : 'no'}, sent_page_token=${pageCursor ? 'yes' : 'no'}, data_keys=${Object.keys(data || {}).join(',')}`);
  }

  return {
    orders,
    nextCursor: nextCursor || null,
  };
}

// ==================== FINANCE ENDPOINTS ====================

export interface ParsedStatement {
  date: string;
  revenue: number;
  platformFee: number;
  shippingCost: number;
  settlement: number;
  netSales: number;
}

export async function fetchStatements(
  accessToken: string,
  shopCipher: string,
  startTs: number,
  endTs: number,
): Promise<ParsedStatement[]> {
  const path = '/finance/202309/statements';

  const data = await shopGet(path, accessToken, {
    shop_cipher: shopCipher,
    statement_time_ge: String(startTs),
    statement_time_lt: String(endTs),
    page_size: '10',
    sort_field: 'statement_time',
  });


  const rawStatements = (data?.statements || data?.statement_transactions || []) as Record<string, unknown>[];

  return rawStatements.map(s => {
    const stmtTime = Number(s.statement_time || 0);
    const date = stmtTime ? new Date(stmtTime * 1000).toISOString().split('T')[0] : '';
    return {
      date,
      revenue: toFloat(s.revenue_amount),
      platformFee: Math.abs(toFloat(s.fee_amount)),
      shippingCost: Math.abs(toFloat(s.shipping_cost_amount)),
      settlement: toFloat(s.settlement_amount),
      netSales: toFloat(s.net_sales_amount),
    };
  });
}

export async function fetchUnsettledOrders(
  accessToken: string,
  shopCipher: string,
): Promise<Record<string, unknown>> {
  const path = '/finance/202507/orders/unsettled';

  const data = await shopGet(path, accessToken, {
    shop_cipher: shopCipher,
    page_size: '10',
  });

  return data || {};
}

// ==================== VIDEO ANALYTICS ====================

export interface ShopVideo {
  id: string;
  title: string;
  username: string;
  video_post_time: string;
  duration: number;
  hash_tags: string[];
  gmv_amount: number;
  gmv_currency: string;
  gpm_amount: number;
  gpm_currency: string;
  avg_customers: number;
  sku_orders: number;
  items_sold: number;
  views: number;
  click_through_rate: number;
  products: Array<{ id: string; name: string }>;
}

export interface FetchVideosResult {
  videos: ShopVideo[];
  nextPageToken: string | null;
  totalCount: number;
  latestAvailableDate: string | null;
}

export async function fetchShopVideos(
  accessToken: string,
  shopCipher: string,
  startDate: string,
  endDate: string,
  pageToken: string | null,
): Promise<FetchVideosResult> {
  const path = '/analytics/202509/shop_videos/performance';

  const queryParams: Record<string, string> = {
    shop_cipher: shopCipher,
    start_date_ge: startDate,
    end_date_le: endDate,
    page_size: '50',
    sort_field: 'gmv',
    sort_order: 'DESC',
    currency: 'USD',
    video_type: 'ALL',
  };
  if (pageToken) queryParams.page_token = pageToken;

  const data = await shopGet(path, accessToken, queryParams);
  const videos = ((data?.videos || []) as Array<Record<string, unknown>>).map(v => {
    const gmv = (v.gmv || {}) as Record<string, string>;
    const gpm = (v.gpm || {}) as Record<string, string>;
    return {
      id: String(v.id || ''),
      title: String(v.title || ''),
      username: String(v.username || ''),
      video_post_time: String(v.video_post_time || ''),
      duration: Number(v.duration) || 0,
      hash_tags: (v.hash_tags || []) as string[],
      gmv_amount: parseFloat(gmv.amount || '0') || 0,
      gmv_currency: gmv.currency || 'USD',
      gpm_amount: parseFloat(gpm.amount || '0') || 0,
      gpm_currency: gpm.currency || 'USD',
      avg_customers: Number(v.avg_customers) || 0,
      sku_orders: Number(v.sku_orders) || 0,
      items_sold: Number(v.items_sold) || 0,
      views: Number(v.views) || 0,
      click_through_rate: parseFloat(String(v.click_through_rate || '0')) || 0,
      products: ((v.products || []) as Array<Record<string, string>>).map(p => ({
        id: String(p.id || ''),
        name: String(p.name || ''),
      })),
    };
  });

  return {
    videos,
    nextPageToken: data?.next_page_token || null,
    totalCount: Number(data?.total_count) || 0,
    latestAvailableDate: data?.latest_available_date || null,
  };
}

function toFloat(val: unknown): number {
  if (val === null || val === undefined) return 0;
  if (typeof val === 'number') return val;
  if (typeof val === 'string') return parseFloat(val) || 0;
  return 0;
}

// ==================== PRODUCT ENDPOINTS ====================

export interface ShopProduct {
  product_id: string;
  product_name: string;
  image_url: string | null;
  status: string;
  skus: { sku_id: string; seller_sku: string; sku_name: string; price: string }[];
}

function buildSkuName(sku: Record<string, unknown>): string {
  // TikTok SKUs have sales_attributes: [{attribute_name: "Color", value_name: "Black"}, ...]
  const attrs = (sku.sales_attributes || []) as Array<Record<string, string>>;
  if (attrs.length > 0) {
    const name = attrs.map(a => a.value_name || a.attribute_value || '').filter(Boolean).join(', ');
    if (name) return name;
  }
  if (sku.name) return String(sku.name);
  if (sku.title) return String(sku.title);
  if (sku.seller_sku) return String(sku.seller_sku);
  return String(sku.id || 'Unknown');
}

async function getProductDetail(
  accessToken: string,
  shopCipher: string,
  productId: string,
): Promise<ShopProduct | null> {
  try {
    const path = `/product/202309/products/${productId}`;
    const data = await shopGet(path, accessToken, { shop_cipher: shopCipher });
    if (!data) return null;

    const skus = ((data.skus as Array<Record<string, unknown>>) || []).map((s) => ({
      sku_id: String(s.id || ''),
      seller_sku: String(s.seller_sku || ''),
      sku_name: buildSkuName(s),
      price: (s.price as Record<string, string>)?.sale_price || '0',
    }));

    // Extract hero image from main_images array
    const mainImages = (data.main_images || []) as Array<Record<string, unknown>>;
    const imageUrl = mainImages.length > 0
      ? String((mainImages[0].urls as string[])?.[0] || mainImages[0].url || mainImages[0].thumb_url || '')
      : null;

    return {
      product_id: String(data.id || productId),
      product_name: String(data.title || ''),
      image_url: imageUrl || null,
      status: String(data.status || ''),
      skus,
    };
  } catch (err) {
    console.error(`[TikTok] Failed to get product ${productId}:`, (err as Error).message);
    return null;
  }
}

export async function getProducts(
  accessToken: string,
  shopCipher: string,
): Promise<ShopProduct[]> {
  try {
    // Step 1: Search to get product IDs
    const path = '/product/202309/products/search';
    const productIds: string[] = [];
    let pageToken: string | null = null;

    do {
      const queryParams: Record<string, string> = {
        shop_cipher: shopCipher,
        page_size: '50',
      };
      if (pageToken) queryParams.page_token = pageToken;

      const data = await shopPost(path, accessToken, {}, queryParams);
      const products = data?.products || [];

      for (const p of products as Array<Record<string, unknown>>) {
        const id = String(p.id || '');
        if (id) productIds.push(id);
      }

      pageToken = data?.next_page_token || null;
    } while (pageToken);

    // Step 2: Fetch full details for each product (has sales_attributes for SKU names)
    const allProducts: ShopProduct[] = [];
    for (const pid of productIds) {
      const detail = await getProductDetail(accessToken, shopCipher, pid);
      if (detail) allProducts.push(detail);
    }

    return allProducts;
  } catch (error) {
    console.error('Failed to get products:', error);
    return [];
  }
}

// Helper to get date range strings
export function getDateRange(days: number = 30): { startDate: string; endDate: string } {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - days);

  return {
    startDate: start.toISOString().split('T')[0],
    endDate: end.toISOString().split('T')[0],
  };
}
