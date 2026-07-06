import { cookies } from 'next/headers';

// The active store is carried in an httpOnly cookie set by POST /api/stores/active
// (membership-validated). Connections are per-store (unique(user_id, store_id)), so
// connection-bound routes resolve which store they act on from this cookie.
export const ACTIVE_STORE_COOKIE = 'lensed_active_store';

// Returns the active store_id, or 'all' (the default when the cookie is absent).
// 'all' means: analytics aggregate across the user's stores; connection-bound
// actions iterate over each store's connection (sync) or require a specific store.
export async function getActiveStore(): Promise<string | 'all'> {
  const v = (await cookies()).get(ACTIVE_STORE_COOKIE)?.value;
  return v && v !== 'all' ? v : 'all';
}
