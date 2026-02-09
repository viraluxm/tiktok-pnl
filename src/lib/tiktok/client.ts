// Server-only TikTok Shop API client
// Handles OAuth and Shop Open API (orders, products, finance)

import crypto from 'crypto';

// TikTok Shop OAuth & API endpoints
const TIKTOK_SHOP_AUTH_URL = 'https://services.us.tiktokshop.com/open/authorize';
const TIKTOK_SHOP_TOKEN_URL = 'https://auth.tiktok-shops.com/api/v2/token/get';
const TIKTOK_SHOP_REFRESH_URL = 'https://auth.tiktok-shops.com/api/v2/token/refresh';
const TIKTOK_SHOP_BASE = 'https://open-api.tiktokglobalshop.com';

function getAppKey() {
  return (process.env.TIKTOK_SHOP_APP_KEY || '').trim();
}

function getAppSecret() {
  return (process.env.TIKTOK_SHOP_APP_SECRET || '').trim();
}

function getServiceId() {
  return (process.env.TIKTOK_SHOP_SERVICE_ID || '').trim();
}

function getRedirectUri() {
  return (process.env.TIKTOK_REDIRECT_URI || '').trim();
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
    app_key: getAppKey(),
    app_secret: getAppSecret(),
    auth_code: code,
    grant_type: 'authorized_code',
  });

  const res = await fetch(`${TIKTOK_SHOP_TOKEN_URL}?${params.toString()}`, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
  });

  const json = await res.json();

  if (json.code !== 0) {
    throw new Error(`TikTok Shop token exchange failed: ${json.message || JSON.stringify(json)}`);
  }

  return json.data as TikTokShopTokenResponse;
}

export async function refreshAccessToken(refreshToken: string): Promise<TikTokShopTokenResponse> {
  const params = new URLSearchParams({
    app_key: getAppKey(),
    app_secret: getAppSecret(),
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });

  const res = await fetch(`${TIKTOK_SHOP_REFRESH_URL}?${params.toString()}`, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
  });

  const json = await res.json();

  if (json.code !== 0) {
    throw new Error(`TikTok Shop token refresh failed: ${json.message || JSON.stringify(json)}`);
  }

  return json.data as TikTokShopTokenResponse;
}

// ==================== SHOP API (HMAC SIGNED) ====================

function generateShopSignature(path: string, params: Record<string, string>, body?: string): string {
  const secret = getAppSecret();

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
  const appKey = getAppKey();

  const params: Record<string, string> = {
    app_key: appKey,
    timestamp,
    ...extraParams,
  };

  const sign = generateShopSignature(path, params);
  params.sign = sign;
  params.access_token = accessToken;

  const url = new URL(`${TIKTOK_SHOP_BASE}${path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  const res = await fetch(url.toString(), {
    headers: {
      'Content-Type': 'application/json',
    },
  });

  const json = await res.json();

  if (json.code !== 0) {
    console.error('TikTok Shop API error:', JSON.stringify(json));
    throw new Error(`TikTok Shop API error: ${json.message || JSON.stringify(json)}`);
  }

  return json.data;
}

async function shopPost(path: string, accessToken: string, body: Record<string, unknown>, extraParams: Record<string, string> = {}) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const appKey = getAppKey();
  const bodyString = JSON.stringify(body);

  const params: Record<string, string> = {
    app_key: appKey,
    timestamp,
    ...extraParams,
  };

  const sign = generateShopSignature(path, params, bodyString);
  params.sign = sign;
  params.access_token = accessToken;

  const url = new URL(`${TIKTOK_SHOP_BASE}${path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  const res = await fetch(url.toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: bodyString,
  });

  const json = await res.json();

  if (json.code !== 0) {
    console.error('TikTok Shop API error:', JSON.stringify(json));
    throw new Error(`TikTok Shop API error: ${json.message || JSON.stringify(json)}`);
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
  try {
    const data = await shopGet('/authorization/202309/shops', accessToken);
    if (!data?.shops) return [];
    return data.shops.map((s: Record<string, string>) => ({
      shop_cipher: s.cipher,
      shop_name: s.name,
      region: s.region,
    }));
  } catch (error) {
    console.error('Failed to get authorized shops:', error);
    return [];
  }
}

export interface ShopOrderSummary {
  date: string;
  total_amount: number;
  order_count: number;
  shipping_fee: number;
  affiliate_commission: number;
}

export async function getShopOrders(
  accessToken: string,
  shopCipher: string,
  startDate: string,
  endDate: string,
): Promise<ShopOrderSummary[]> {
  try {
    const path = '/order/202309/orders/search';
    const body = {
      create_time_ge: Math.floor(new Date(startDate).getTime() / 1000),
      create_time_lt: Math.floor(new Date(endDate + 'T23:59:59').getTime() / 1000),
      page_size: 100,
    };

    const data = await shopPost(path, accessToken, body, { shop_cipher: shopCipher });
    const orders = data?.orders || [];

    // Aggregate orders by date
    const dailyMap: Record<string, ShopOrderSummary> = {};

    for (const order of orders) {
      const createTime = order.create_time;
      const date = new Date(createTime * 1000).toISOString().split('T')[0];

      if (!dailyMap[date]) {
        dailyMap[date] = {
          date,
          total_amount: 0,
          order_count: 0,
          shipping_fee: 0,
          affiliate_commission: 0,
        };
      }

      const payment = order.payment || {};
      dailyMap[date].total_amount += parseFloat(payment.total_amount || '0');
      dailyMap[date].order_count += 1;
      dailyMap[date].shipping_fee += parseFloat(payment.shipping_fee || '0');

      // Affiliate commission from line items
      const lineItems = order.line_items || [];
      for (const item of lineItems) {
        dailyMap[date].affiliate_commission += parseFloat(item.platform_commission || '0');
      }
    }

    return Object.values(dailyMap).sort((a, b) => a.date.localeCompare(b.date));
  } catch (error) {
    console.error('Failed to get shop orders:', error);
    return [];
  }
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
    const body = {
      page_size: 20,
      sort_field: 'create_time',
      sort_order: 'DESC',
    };

    const data = await shopPost(path, accessToken, body, { shop_cipher: shopCipher });
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
    const body = {
      page_size: 100,
    };

    const data = await shopPost(path, accessToken, body, { shop_cipher: shopCipher });
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
