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

  console.log(`[TikTok shopGet] Fetching: ${fullUrl}`);

  const res = await fetch(fullUrl, {
    headers: {
      'Content-Type': 'application/json',
      'x-tts-access-token': accessToken,
    },
  });

  const rawText = await res.text();
  console.log(`[TikTok shopGet] ${path} HTTP ${res.status}:`, rawText.slice(0, 1000));

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

  console.log(`[TikTok shopPost] URL: ${fullUrl}`);
  console.log(`[TikTok shopPost] Body string (${bodyString.length} bytes): ${bodyString}`);
  console.log(`[TikTok shopPost] Body keys: ${Object.keys(body).join(', ')}`);
  console.log(`[TikTok shopPost] access_token length: ${accessToken?.length || 0}`);

  const res = await fetch(fullUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-tts-access-token': accessToken,
    },
    body: bodyString,
  });

  const rawText = await res.text();
  console.log(`[TikTok shopPost] ${path} HTTP ${res.status} Response: ${rawText.slice(0, 1500)}`);

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
  console.log('[TikTok getAuthorizedShops] raw data:', JSON.stringify(data));
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
    queryParams.cursor = pageCursor;
  }

  console.log(`[TikTok fetchOrdersPage] ts=${startTs}..${endTs} sentCursor=${pageCursor || 'none'}`);

  const data = await shopPost(path, accessToken, body, queryParams);
  const orders = data?.orders || [];
  const nextCursor = data?.next_cursor || data?.next_page_token || '';

  // Log cursor tracking and first order ID for dedup debugging
  const firstOrderId = orders.length > 0 ? (orders[0] as Record<string, unknown>).id || 'unknown' : 'none';
  const lastOrderId = orders.length > 0 ? (orders[orders.length - 1] as Record<string, unknown>).id || 'unknown' : 'none';
  console.log(`[TikTok fetchOrdersPage] Got ${orders.length} orders, firstId=${firstOrderId}, lastId=${lastOrderId}, receivedCursor=${nextCursor || 'none'}, hasMore=${!!(nextCursor && orders.length === 50)}`);

  return {
    orders,
    nextCursor: nextCursor && orders.length === 50 ? nextCursor : null,
  };
}

// ==================== FINANCE ENDPOINTS ====================

export interface FinanceSettlement {
  date: string;
  revenue: number;
  fees: number;
  net_amount: number;
}

export async function getFinanceOverview(
  accessToken: string,
  shopCipher: string,
): Promise<FinanceSettlement[]> {
  try {
    const path = '/finance/202309/settlements/search';
    const body = {};
    const queryParams: Record<string, string> = {
      shop_cipher: shopCipher,
      page_size: '20',
      sort_field: 'create_time',
      sort_order: 'DESC',
    };

    const data = await shopPost(path, accessToken, body, queryParams);
    const settlements = data?.settlements || [];

    return settlements.map((s: Record<string, unknown>) => ({
      date: s.settlement_time ? new Date((s.settlement_time as number) * 1000).toISOString().split('T')[0] : '',
      revenue: parseFloat((s.revenue as string) || '0'),
      fees: parseFloat((s.fees as string) || '0'),
      net_amount: parseFloat((s.net_amount as string) || '0'),
    }));
  } catch (error) {
    console.error('Failed to get finance overview:', error);
    return [];
  }
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
