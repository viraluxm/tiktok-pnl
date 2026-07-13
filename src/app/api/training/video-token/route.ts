import { NextResponse } from 'next/server';
import { AccessToken } from 'livekit-server-sdk';
import { createClient } from '@/lib/supabase/server';
import { isValidTrainingSessionId, trainingLiveKitRoom } from '@/lib/training/session';

// LiveKit video token route for the Practice Mode camera preview.
// Admin-gated independently: /api routes are NOT covered by the (app)/admin
// page layout, so this route enforces auth + admin role itself.
export const runtime = 'nodejs'; // JWT signing needs Node, not the edge runtime
export const dynamic = 'force-dynamic';

type Role = 'host' | 'controller';

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (user.app_metadata?.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  // LiveKit env is read only here (not added to src/lib/env.ts, to avoid
  // coupling unrelated routes to these vars).
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  const url = process.env.NEXT_PUBLIC_LIVEKIT_URL;
  if (!apiKey || !apiSecret || !url) {
    return NextResponse.json({ error: 'Video not configured' }, { status: 500 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    role?: Role;
    session?: string;
  };

  // Never trust a raw room name from the client. Re-validate the practice
  // sessionId server-side and derive the LiveKit room here, so a token is only
  // ever issued for `training:<validated-session>` (no shared-room fallback).
  if (!isValidTrainingSessionId(body.session)) {
    return NextResponse.json({ error: 'Invalid session' }, { status: 400 });
  }
  const isHost = body.role === 'host';
  const room = trainingLiveKitRoom(body.session);

  const at = new AccessToken(apiKey, apiSecret, {
    identity: `${isHost ? 'host' : 'ctrl'}-${user.id}`,
    ttl: '2h',
  });
  at.addGrant({
    room,
    roomJoin: true,
    canPublish: isHost,
    canSubscribe: true,
    canPublishData: false,
  });

  return NextResponse.json(
    { token: await at.toJwt(), url },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
