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

async function shopGet(path: string, accessToken: string, extraParams: Record<string, string> = {}) {
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

async function shopPost(path: string, accessToken: string, body: Record<string, unknown>, extraParams: Record<string, string> = {}) {
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

  return {
    orders,
    // Trust TikTok's cursor — if they provide one, there are more pages
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
  status: string;
  skus: { sku_id: string; seller_sku: string; price: string }[];
}

export async function getProducts(
  accessToken: string,
  shopCipher: string,
): Promise<ShopProduct[]> {
  try {
    const path = '/product/202309/products/search';
    const body = {};
    const queryParams: Record<string, string> = {
      shop_cipher: shopCipher,
      page_size: '50',
    };

    const data = await shopPost(path, accessToken, body, queryParams);
    const products = data?.products || [];

    return products.map((p: Record<string, unknown>) => ({
      product_id: p.id || '',
      product_name: (p.title as string) || '',
      status: (p.status as string) || '',
      skus: ((p.skus as Array<Record<string, unknown>>) || []).map((s) => ({
        sku_id: s.id || '',
        seller_sku: s.seller_sku || '',
        price: (s.price as Record<string, string>)?.sale_price || '0',
      })),
    }));
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
