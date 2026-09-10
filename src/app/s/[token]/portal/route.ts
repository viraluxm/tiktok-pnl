import { NextResponse } from 'next/server';
import { guardPublicRead } from '@/lib/schedule/publicRoute';
import { getPortalSnapshot } from '@/lib/schedule/portalSnapshot';

export const dynamic = 'force-dynamic';

// GET /s/[token]/portal — the employee's whole portal snapshot (Home / Schedule / Requests).
//
// Public tokenized route: NO auth session (middleware excludes /s/*). The employee is resolved
// from the token; nothing in the request selects an employee or an owner. See portalSnapshot.ts
// for the field allow-list.
export async function GET(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const guard = await guardPublicRead(token, req);
  if ('response' in guard) return guard.response;
  try {
    const snapshot = await getPortalSnapshot(guard.resolved.employee);
    return NextResponse.json(snapshot, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    console.error('[portal] snapshot:', (e as Error).message);
    return NextResponse.json({ error: 'Could not load your schedule.' }, { status: 500 });
  }
}
