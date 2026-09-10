import { NextResponse } from 'next/server';
import { AccessToken } from 'livekit-server-sdk';
import { requireHostToken } from '@/lib/training/hostRouteGuard';
import { trainingLiveKitRoom } from '@/lib/training/session';

export const runtime = 'nodejs'; // JWT signing needs Node, not the edge runtime
export const dynamic = 'force-dynamic';

// POST /api/host/[token]/livekit-token
//
// A publish-only LiveKit grant for exactly the one room this token names.
//
// Deliberately NARROWER than the admin /api/training/video-token: that route takes
// a `role` and a `session` from the request body and can mint either a host or a
// controller grant for any session the admin names. Here both are fixed by the
// token, so a candidate's link cannot be pointed at somebody else's room, and
// canSubscribe is FALSE — a practice host has no reason to receive other
// participants' media, and withholding it means a leaked link cannot be used to
// watch another session.
export async function POST(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const gate = await requireHostToken(params);
  if (!gate.ok) return gate.response;

  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  const url = process.env.NEXT_PUBLIC_LIVEKIT_URL;
  if (!apiKey || !apiSecret || !url) {
    return NextResponse.json({ error: 'Video not configured' }, { status: 500 });
  }

  const at = new AccessToken(apiKey, apiSecret, {
    // Same identity shape the admin path uses for a host, so the room shows one
    // host regardless of which route joined it. Keyed on the SESSION, since a
    // tokenised host has no user id.
    identity: `host-token-${gate.session.sessionId}`,
    name: gate.session.traineeName ?? undefined,
    ttl: '2h',
  });
  at.addGrant({
    room: trainingLiveKitRoom(gate.session.sessionId),
    roomJoin: true,
    canPublish: true,
    canSubscribe: false, // see above — a host publishes, it never watches
    canPublishData: false,
  });

  return NextResponse.json(
    { token: await at.toJwt(), url },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
