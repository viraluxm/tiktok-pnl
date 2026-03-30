// TikTok Business API client (separate from Shop API)
// Handles OAuth and Reporting for ad spend data

const TIKTOK_BUSINESS_BASE = 'https://business-api.tiktok.com';

function getBusinessAppId(): string {
  return (process.env.TIKTOK_BUSINESS_APP_ID || '').trim();
}

function getBusinessAppSecret(): string {
  return (process.env.TIKTOK_BUSINESS_APP_SECRET || '').trim();
}

// ==================== OAUTH ====================

export function getBusinessAuthUrl(state: string, redirectUri: string): string {
  const params = new URLSearchParams({
    app_id: getBusinessAppId(),
    state,
    redirect_uri: redirectUri,
  });
  return `${TIKTOK_BUSINESS_BASE}/portal/auth?${params.toString()}`;
}

export interface BusinessTokenResponse {
  access_token: string;
  advertiser_ids: string[];
}

export async function exchangeBusinessCode(authCode: string): Promise<BusinessTokenResponse> {
  const url = `${TIKTOK_BUSINESS_BASE}/open_api/v1.3/oauth2/access_token/`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      app_id: getBusinessAppId(),
      secret: getBusinessAppSecret(),
      auth_code: authCode,
    }),
  });

  const json = await res.json();

  if (json.code !== 0) {
    console.error('[TikTok Business] Token exchange error:', JSON.stringify(json));
    throw new Error(`TikTok Business token exchange failed: ${json.message || 'unknown'}`);
  }

  const data = json.data;
  return {
    access_token: data.access_token,
    advertiser_ids: data.advertiser_ids || [],
  };
}

// ==================== REPORTING ====================

export interface AdSpendRow {
  date: string;
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  currency: string;
}

export async function fetchAdSpend(
  accessToken: string,
  advertiserId: string,
  startDate: string,
  endDate: string,
): Promise<AdSpendRow[]> {
  const url = new URL(`${TIKTOK_BUSINESS_BASE}/open_api/v1.3/report/integrated/get/`);
  url.searchParams.set('advertiser_id', advertiserId);
  url.searchParams.set('report_type', 'BASIC');
  url.searchParams.set('data_level', 'AUCTION_ADVERTISER');
  url.searchParams.set('dimensions', JSON.stringify(['stat_time_day']));
  url.searchParams.set('metrics', JSON.stringify(['spend', 'impressions', 'clicks', 'conversion']));
  url.searchParams.set('query_lifetime', 'false');
  url.searchParams.set('start_date', startDate);
  url.searchParams.set('end_date', endDate);
  url.searchParams.set('page_size', '365');

  const res = await fetch(url.toString(), {
    headers: {
      'Access-Token': accessToken,
      'Content-Type': 'application/json',
    },
  });

  const json = await res.json();

  console.log(`[AdSpend Debug] advertiser=${advertiserId} range=${startDate}-${endDate} code=${json.code} msg=${json.message || 'ok'} rows=${json.data?.list?.length || 0}`);
  if (json.code !== 0) {
    console.error('[TikTok Business] Report error:', JSON.stringify(json).slice(0, 1000));
    throw new Error(`TikTok Business report failed: ${json.message || 'unknown'}`);
  }

  const rows = (json.data?.list || []) as Array<Record<string, unknown>>;
  return rows.map(r => {
    const metrics = (r.metrics || {}) as Record<string, string>;
    const dimensions = (r.dimensions || {}) as Record<string, string>;
    return {
      date: dimensions.stat_time_day || '',
      spend: parseFloat(metrics.spend || '0') || 0,
      impressions: parseInt(metrics.impressions || '0') || 0,
      clicks: parseInt(metrics.clicks || '0') || 0,
      conversions: parseInt(metrics.conversion || '0') || 0,
      currency: 'USD',
    };
  });
}

// Get advertiser info
export async function getAdvertiserInfo(
  accessToken: string,
  advertiserIds: string[],
): Promise<Array<{ id: string; name: string }>> {
  const url = new URL(`${TIKTOK_BUSINESS_BASE}/open_api/v1.3/advertiser/info/`);
  url.searchParams.set('advertiser_ids', JSON.stringify(advertiserIds));

  const res = await fetch(url.toString(), {
    headers: { 'Access-Token': accessToken },
  });

  const json = await res.json();
  if (json.code !== 0) return [];

  return ((json.data?.list || []) as Array<Record<string, unknown>>).map(a => ({
    id: String(a.advertiser_id || ''),
    name: String(a.advertiser_name || ''),
  }));
}
