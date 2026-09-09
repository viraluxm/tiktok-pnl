import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { generateAccessToken } from '@/lib/schedule/tokens';

export const dynamic = 'force-dynamic';

// Admin CRUD for the manager crew-board links. Session-authenticated and gated on
// app_metadata.role === 'admin' — the same inline pattern as the other /api/admin routes, and
// correctly caught by middleware. This is NOT one of the public /s/* routes.
//
// NOTE on role gating: four production accounts carry role = null, which middleware treats as
// UNCONFINED. The check below is an explicit === 'admin', so null does NOT pass here.

async function requireAdmin() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  if (user.app_metadata?.role !== 'admin') {
    return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  }
  return { user };
}

const CREWS = new Set(['am', 'pm']);

// GET → list this owner's active crew links (token included so the caller can build the URL).
export async function GET() {
  const gate = await requireAdmin();
  if ('error' in gate) return gate.error;

  const admin = createAdminClient();
  const { data, error } = await admin
    .from('crew_board_tokens')
    .select('id, crew, label, target_boxes, token, created_at')
    .eq('user_id', gate.user.id)
    .eq('active', true)
    .order('crew', { ascending: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({
    tokens: (data ?? []).map((t) => ({ ...t, path: `/s/${t.token}/pickers` })),
  });
}

// POST { crew, label?, targetBoxes? } → mint a link for one crew.
// One active link per crew: minting revokes that crew's existing active token, so this doubles as
// "regenerate" and a leaked link can be rotated by minting again.
export async function POST(req: Request) {
  const gate = await requireAdmin();
  if ('error' in gate) return gate.error;

  let body: { crew?: string; label?: string; targetBoxes?: number | null };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Bad request' }, { status: 400 }); }

  const crew = String(body.crew ?? '');
  if (!CREWS.has(crew)) return NextResponse.json({ error: "crew must be 'am' or 'pm'" }, { status: 400 });

  const target = body.targetBoxes == null ? null : Number(body.targetBoxes);
  if (target != null && (!Number.isInteger(target) || target <= 0)) {
    return NextResponse.json({ error: 'targetBoxes must be a positive integer or null' }, { status: 400 });
  }
  const label = (body.label ?? '').trim() || (crew === 'am' ? 'Morning crew' : 'Night crew');

  const admin = createAdminClient();
  await admin
    .from('crew_board_tokens')
    .update({ active: false, revoked_at: new Date().toISOString() })
    .eq('user_id', gate.user.id)
    .eq('crew', crew)
    .eq('active', true);

  const token = generateAccessToken();
  const { data, error } = await admin
    .from('crew_board_tokens')
    .insert({ user_id: gate.user.id, crew, label, target_boxes: target, token, active: true })
    .select('id, crew, label, target_boxes, token, created_at')
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ...data, path: `/s/${token}/pickers` }, { status: 201 });
}

// PATCH { id, targetBoxes?, label? } → change the per-shift minimum or the heading WITHOUT
// rotating the link. This is how the target gets set, changed, or cleared (null removes the
// target column from the board entirely) with no deploy.
export async function PATCH(req: Request) {
  const gate = await requireAdmin();
  if ('error' in gate) return gate.error;

  let body: { id?: string; targetBoxes?: number | null; label?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Bad request' }, { status: 400 }); }

  const id = String(body.id ?? '');
  if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 });

  const patch: Record<string, unknown> = {};
  if ('targetBoxes' in body) {
    const t = body.targetBoxes == null ? null : Number(body.targetBoxes);
    if (t != null && (!Number.isInteger(t) || t <= 0)) {
      return NextResponse.json({ error: 'targetBoxes must be a positive integer or null' }, { status: 400 });
    }
    patch.target_boxes = t;
  }
  if ('label' in body && (body.label ?? '').trim()) patch.label = (body.label as string).trim();
  if (Object.keys(patch).length === 0) return NextResponse.json({ error: 'Nothing to update' }, { status: 400 });

  const admin = createAdminClient();
  const { data, error } = await admin
    .from('crew_board_tokens')
    .update(patch)
    .eq('id', id)
    .eq('user_id', gate.user.id)          // owner scope: service-role bypasses RLS
    .select('id, crew, label, target_boxes')
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json(data);
}

// DELETE ?id= → revoke a link. Kept as a row (active=false) rather than deleted, so a revoked
// token can never be silently re-minted onto the same string.
export async function DELETE(req: Request) {
  const gate = await requireAdmin();
  if ('error' in gate) return gate.error;

  const id = new URL(req.url).searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 });

  const admin = createAdminClient();
  const { error } = await admin
    .from('crew_board_tokens')
    .update({ active: false, revoked_at: new Date().toISOString() })
    .eq('id', id)
    .eq('user_id', gate.user.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
