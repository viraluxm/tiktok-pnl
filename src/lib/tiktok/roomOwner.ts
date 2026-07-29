// Resolve a TikTok live room to its OWNER (channel) via the public webcast room-info
// endpoint. This is an UNDOCUMENTED internal endpoint — treat it as fragile:
//   • no auth required (aid=1988 + room_id only),
//   • works for ENDED rooms (verified up to ~48h; a minority return an error code),
//   • returns owner.display_id (= handle), sec_uid (rename-proof id), nickname.
// One fetch, no internal retries — retries are the sweep's job across runs, so we never
// hammer the endpoint. Caller is responsible for batching + backoff + low call volume.

export interface RoomOwner {
  ok: boolean;               // status_code === 0 AND a display_id was present
  statusCode: number | null; // TikTok's body status_code (0 = ok; e.g. 4003110 = unavailable), or null on transport failure
  displayId: string | null;  // the channel handle, e.g. "jumbosteals"
  secUid: string | null;     // rename-proof owner id (survives a handle rename)
  nickname: string | null;
  accountId: string | null;
  roomStatus: number | null; // 2 = live, 4 = ended
}

const ENDPOINT = 'https://webcast.tiktok.com/webcast/room/info/';

export async function fetchRoomOwner(roomId: string, timeoutMs = 8000): Promise<RoomOwner> {
  const empty: RoomOwner = {
    ok: false, statusCode: null, displayId: null, secUid: null,
    nickname: null, accountId: null, roomStatus: null,
  };
  if (!roomId) return empty;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${ENDPOINT}?aid=1988&room_id=${encodeURIComponent(roomId)}`, {
      headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
      signal: ctrl.signal,
      cache: 'no-store',
    });
    if (!res.ok) return { ...empty, statusCode: res.status };
    const j = (await res.json()) as {
      status_code?: number;
      data?: { status?: number; owner?: { display_id?: string; sec_uid?: string; nickname?: string; id_str?: string; id?: string | number } };
    };
    const sc = typeof j?.status_code === 'number' ? j.status_code : null;
    const owner = j?.data?.owner ?? {};
    const displayId = owner?.display_id ? String(owner.display_id).trim() : null;
    const ok = sc === 0 && !!displayId;
    return {
      ok,
      statusCode: sc,
      displayId: ok ? displayId : null,
      secUid: owner?.sec_uid ? String(owner.sec_uid) : null,
      nickname: owner?.nickname ? String(owner.nickname) : null,
      accountId: owner?.id_str ? String(owner.id_str) : owner?.id != null ? String(owner.id) : null,
      roomStatus: typeof j?.data?.status === 'number' ? j.data.status : null,
    };
  } catch {
    // Abort / network / parse failure → transport failure (statusCode null); the sweep
    // will retry on a later run.
    return empty;
  } finally {
    clearTimeout(timer);
  }
}
