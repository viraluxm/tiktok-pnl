import { createAdminClient } from '@/lib/supabase/admin';
import { fetchRoomOwner } from '@/lib/tiktok/roomOwner';

// ROOM → OWNER channel resolver (shared core for the cron + a manual admin trigger).
//
// WHY: the extension detects the streaming channel by scraping the Seller Center DOM,
// which is fragile and frequently yields NULL on mapped channels → the session has no
// channel_handle → the set_store_id trigger can't derive a store → "Unmapped store" and
// broken attribution. The room's OWNER is authoritative and cheap to fetch server-side
// (see @/lib/tiktok/roomOwner), so we backfill it here — entirely off the auction/capture
// write path.
//
// WRITES (only when write=true):
//   • channel_handle, channel_sec_uid, channel_nickname, channel_account_id
//   • store_id — ONLY when currently null AND we can attribute it (handle in
//     channel_store_map, or a sec_uid we've already seen mapped to a store → rename-proof).
//     When the handle is mapped we can also just write channel_handle and let the
//     set_store_id trigger derive it; we set it explicitly so the sec_uid fallback and the
//     trigger path converge on one code path.
//   • bookkeeping: channel_resolve_attempts / _status / _resolved_at.
//
// FRAGILE ENDPOINT HYGIENE: newest-first, small batch, a sleep between calls, and a
// per-room attempt cap so the handful of permanently-unavailable rooms (status 4003110)
// aren't retried forever.

const BATCH = 20;              // rooms resolved per run (keeps call volume low)
const MAX_ATTEMPTS = 6;        // give up on a room after this many failed lookups
const SLEEP_MS = 1200;         // spacing between endpoint calls
const LOOKBACK_DAYS = 60;      // also covers the historical null-handle backfill

export interface ResolveOutcome {
  session_id: string;
  room_id: string;
  status_code: number | null;
  handle: string | null;
  sec_uid_present: boolean;
  store_resolved_via: 'existing' | 'handle-map' | 'sec-uid' | 'unmapped' | null;
  action: 'resolved' | 'would-resolve' | 'failed' | 'skipped';
}

export interface ResolveResult {
  dry_run: boolean;
  candidates: number;
  resolved: number;
  failed: number;
  outcomes: ResolveOutcome[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function resolveChannels({ write }: { write: boolean }): Promise<ResolveResult> {
  const admin = createAdminClient();
  const sinceIso = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000).toISOString();

  // Candidates: have a room, still missing the rename-proof id OR the handle, not yet
  // exhausted, within the lookback window. Newest first — a live show's attribution
  // matters most; the historical backfill drains over subsequent runs.
  const { data: rows, error } = await admin
    .from('live_sessions')
    .select('id, tiktok_live_id, channel_handle, channel_sec_uid, store_id, channel_resolve_attempts')
    .not('tiktok_live_id', 'is', null)
    .or('channel_sec_uid.is.null,channel_handle.is.null')
    .lt('channel_resolve_attempts', MAX_ATTEMPTS)
    .gte('started_at', sinceIso)
    .order('started_at', { ascending: false })
    .limit(BATCH);

  if (error) throw new Error(`candidate query failed: ${error.message}`);
  const candidates = rows ?? [];

  // sec_uid → store_id, learned from sessions that ALREADY have both. Lets us attribute a
  // renamed channel (handle changed, sec_uid stable) even before channel_store_map knows
  // the new handle. Empty on first runs; self-populates as the sweep writes sec_uids.
  const secUidToStore = new Map<string, string>();
  {
    const { data: known } = await admin
      .from('live_sessions')
      .select('channel_sec_uid, store_id')
      .not('channel_sec_uid', 'is', null)
      .not('store_id', 'is', null)
      .limit(2000);
    for (const k of known ?? []) {
      const su = k.channel_sec_uid as string | null;
      const st = k.store_id as string | null;
      if (su && st && !secUidToStore.has(su)) secUidToStore.set(su, st);
    }
  }

  // Handle → store from the map (single read; the trigger uses the same source).
  const handleToStore = new Map<string, string>();
  {
    const { data: map } = await admin.from('channel_store_map').select('channel_name, store_id');
    for (const m of map ?? []) {
      const h = m.channel_name as string | null;
      const st = m.store_id as string | null;
      if (h && st) handleToStore.set(h, st);
    }
  }

  const outcomes: ResolveOutcome[] = [];
  let resolved = 0;
  let failed = 0;

  for (let i = 0; i < candidates.length; i++) {
    const s = candidates[i];
    const room = s.tiktok_live_id as string;
    if (i > 0) await sleep(SLEEP_MS);

    const owner = await fetchRoomOwner(room);

    if (!owner.ok) {
      failed += 1;
      const attempts = ((s.channel_resolve_attempts as number | null) ?? 0) + 1;
      if (write) {
        await admin
          .from('live_sessions')
          .update({ channel_resolve_attempts: attempts, channel_resolve_status: `err:${owner.statusCode ?? 'net'}` })
          .eq('id', s.id);
      }
      outcomes.push({
        session_id: s.id as string, room_id: room, status_code: owner.statusCode,
        handle: null, sec_uid_present: false, store_resolved_via: null, action: 'failed',
      });
      continue;
    }

    // Decide store attribution (only fills a NULL store; never overwrites an existing one).
    const existingStore = (s.store_id as string | null) ?? null;
    let storeId: string | null = existingStore;
    let via: ResolveOutcome['store_resolved_via'];
    if (existingStore) {
      via = 'existing';
    } else if (owner.displayId && handleToStore.has(owner.displayId)) {
      storeId = handleToStore.get(owner.displayId)!;
      via = 'handle-map';
    } else if (owner.secUid && secUidToStore.has(owner.secUid)) {
      storeId = secUidToStore.get(owner.secUid)!;
      via = 'sec-uid';
    } else {
      via = 'unmapped'; // handle not in map and no known sec_uid → store stays null (banner still flags it)
    }

    const patch: Record<string, unknown> = {
      channel_handle: owner.displayId,
      channel_sec_uid: owner.secUid,
      channel_nickname: owner.nickname,
      channel_account_id: owner.accountId,
      channel_resolve_attempts: 0,
      channel_resolve_status: 'ok',
      channel_resolved_at: new Date().toISOString(),
    };
    if (!existingStore && storeId) patch.store_id = storeId;

    if (write) {
      const { error: upErr } = await admin.from('live_sessions').update(patch).eq('id', s.id);
      if (upErr) {
        failed += 1;
        outcomes.push({
          session_id: s.id as string, room_id: room, status_code: owner.statusCode,
          handle: owner.displayId, sec_uid_present: !!owner.secUid, store_resolved_via: via, action: 'failed',
        });
        continue;
      }
      // Learn this sec_uid → store for the rest of this run.
      if (owner.secUid && storeId && !secUidToStore.has(owner.secUid)) secUidToStore.set(owner.secUid, storeId);
    }

    resolved += 1;
    outcomes.push({
      session_id: s.id as string, room_id: room, status_code: owner.statusCode,
      handle: owner.displayId, sec_uid_present: !!owner.secUid, store_resolved_via: via,
      action: write ? 'resolved' : 'would-resolve',
    });
  }

  return { dry_run: !write, candidates: candidates.length, resolved, failed, outcomes };
}
