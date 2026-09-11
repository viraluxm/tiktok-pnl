import type { PayPeriodsPayload, PortalSnapshot, PortalWeek, TimecardPayload, TimecardPeriodPayload, TradeOptionsPayload } from '@/lib/schedule/portalTypes';

// The portal's data seam. Production uses createFetchPortalClient(token), which calls ONLY our own
// /s/[token]/* routes — there is no Supabase client on this page and no auth session (CLAUDE.md).
// /preview/employee-portal supplies an in-memory implementation of the same interface, so every
// screen, sheet and state can be reviewed with ZERO network path.
//
// The token lives in the URL the employee already has; it is passed to fetch as part of the path and
// nowhere else — never logged, never put in a header or a body.

export class PortalRequestError extends Error {
  code: string | null;
  status: number;
  constructor(message: string, status: number, code: string | null = null) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export interface PortalClient {
  /** Cache-key discriminator: the token in production, 'preview' in the preview route. */
  scopeKey: string;
  /** Token for the QR clock sheet (ClockControls talks to /s/[token]/clock itself). null = no clock UI. */
  token: string | null;
  getSnapshot(): Promise<PortalSnapshot>;
  getWeek(start: string): Promise<PortalWeek>;
  getTimecard(): Promise<TimecardPayload>;
  /** Recent CLOSED pay periods — its own call, so the snapshot's timer never pays for the sweep. */
  getPayPeriods(): Promise<PayPeriodsPayload>;
  /** One past pay period in full. `start` must be a real period start; the server re-checks it. */
  getTimecardPeriod(start: string): Promise<TimecardPeriodPayload>;
  getTradeOptions(instanceId: string): Promise<TradeOptionsPayload>;
  /** Drop Shift — offers the shift while it stays yours. */
  offer(instanceId: string): Promise<void>;
  cancelOffer(instanceId: string, offerId: string): Promise<void>;
  /** Pick Up (Phase 2 offer) — files a pending request. */
  pickup(instanceId: string, offerId: string | null): Promise<void>;
  /** Claim (legacy open board) — assigns at once, or files an OT approval over 40h. */
  claim(instanceId: string): Promise<{ result: 'claimed' | 'pending_approval' }>;
  requestTrade(mineInstanceId: string, theirsInstanceId: string): Promise<void>;
  respondTrade(tradeId: string, response: 'accept' | 'decline'): Promise<void>;
  cancelTrade(tradeId: string): Promise<void>;
  requestTimeOff(startDate: string, endDate: string, reason: string): Promise<void>;
  withdrawTimeOff(id: string): Promise<void>;
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  return (await res.json().catch(() => ({}))) as Record<string, unknown>;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) {
    const body = await readJson(res);
    throw new PortalRequestError(String(body.error ?? (res.status === 429 ? 'Too many requests — try again in a moment.' : 'Could not load.')), res.status, typeof body.code === 'string' ? body.code : null);
  }
  return (await res.json()) as T;
}

async function postJson<T = Record<string, unknown>>(url: string, body: unknown, method: 'POST' | 'DELETE' = 'POST'): Promise<T> {
  const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await readJson(res);
  if (!res.ok) {
    throw new PortalRequestError(String(data.error ?? (res.status === 429 ? 'Too many requests — try again in a moment.' : 'Something went wrong.')), res.status, typeof data.code === 'string' ? data.code : null);
  }
  return data as T;
}

export function createFetchPortalClient(token: string): PortalClient {
  const base = `/s/${encodeURIComponent(token)}`;
  return {
    scopeKey: token,
    token,
    getSnapshot: () => getJson<PortalSnapshot>(`${base}/portal`),
    getWeek: (start) => getJson<PortalWeek>(`${base}/portal/week?start=${encodeURIComponent(start)}`),
    getTimecard: () => getJson<TimecardPayload>(`${base}/portal/timecard`),
    getPayPeriods: () => getJson<PayPeriodsPayload>(`${base}/portal/pay-periods`),
    getTimecardPeriod: (start) => getJson<TimecardPeriodPayload>(`${base}/portal/timecard?period=${encodeURIComponent(start)}`),
    getTradeOptions: (instanceId) => getJson<TradeOptionsPayload>(`${base}/portal/trade-options?instanceId=${encodeURIComponent(instanceId)}`),
    offer: async (instanceId) => { await postJson(`${base}/offer`, { instanceId }); },
    cancelOffer: async (instanceId, offerId) => { await postJson(`${base}/cancel-offer`, { instanceId, offerId }); },
    pickup: async (instanceId, offerId) => { await postJson(`${base}/pickup`, { instanceId, offerId }); },
    claim: async (instanceId) => {
      const r = await postJson<{ result?: string }>(`${base}/claim`, { instanceId });
      return { result: r.result === 'pending_approval' ? 'pending_approval' : 'claimed' };
    },
    requestTrade: async (mineInstanceId, theirsInstanceId) => { await postJson(`${base}/trade`, { mineInstanceId, theirsInstanceId }); },
    respondTrade: async (tradeId, response) => { await postJson(`${base}/trade/respond`, { tradeId, response }); },
    cancelTrade: async (tradeId) => { await postJson(`${base}/trade/cancel`, { tradeId }); },
    requestTimeOff: async (start_date, end_date, reason) => { await postJson(`${base}/time-off`, { start_date, end_date, reason }); },
    withdrawTimeOff: async (id) => { await postJson(`${base}/time-off`, { id }, 'DELETE'); },
  };
}
