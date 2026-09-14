import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import {
  getStaffingOutlook, setBlockDateCapacity, setCapacityBlockActive, setTeamCapacity, upsertCapacityBlock,
} from '@/lib/schedule/capacityAdmin';
import { CapacityError } from '@/lib/schedule/capacityBoard';

export const dynamic = 'force-dynamic';

// STAFFING CAPACITY configuration + the manager's staffing outlook (migration 156).
//
// Everything here is owner-scoped with the SESSION uid. createAdminClient() bypasses RLS inside the
// helpers, so those explicit user_id predicates are the tenant boundary; a block or setting id from
// another account resolves to nothing rather than being edited.

async function requireAdmin() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  if (user.app_metadata?.role !== 'admin') return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  return { user };
}

function fail(e: unknown, what: string): NextResponse {
  if (e instanceof CapacityError) {
    const status = e.code === 'NOT_FOUND' ? 404
      : e.code.startsWith('BAD_') || e.code === 'NO_DAYS' ? 400
      : e.code === 'SAVE_FAILED' || e.code === 'READ_FAILED' ? 500
      : 409;
    if (status === 500) {
      console.error('[schedule/capacity]', e.code, e.message);
      return NextResponse.json({ error: what }, { status: 500 });
    }
    return NextResponse.json({ error: e.message, code: e.code }, { status });
  }
  console.error('[schedule/capacity]', (e as Error).message);
  return NextResponse.json({ error: what }, { status: 500 });
}

// GET ?from=YYYY-MM-DD&days=N — blocks, settings and the staffing outlook for the window.
export async function GET(req: Request) {
  const gate = await requireAdmin();
  if ('error' in gate) return gate.error;
  const url = new URL(req.url);
  const days = Number(url.searchParams.get('days') ?? '');
  try {
    const payload = await getStaffingOutlook(gate.user.id, {
      from: url.searchParams.get('from') ?? undefined,
      days: Number.isFinite(days) && days > 0 ? days : undefined,
    });
    return NextResponse.json({ ok: true, ...payload });
  } catch (e) {
    return fail(e, 'Could not load staffing capacity.');
  }
}

// POST — create or update a staffing block.
// { id?, team, label?, days_of_week[], start_time, end_time, capacity?, active? }
export async function POST(req: Request) {
  const gate = await requireAdmin();
  if ('error' in gate) return gate.error;
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Bad request' }, { status: 400 }); }
  try {
    const block = await upsertCapacityBlock(gate.user.id, {
      id: typeof body.id === 'string' ? body.id : undefined,
      team: String(body.team ?? ''),
      label: typeof body.label === 'string' ? body.label : null,
      days_of_week: Array.isArray(body.days_of_week) ? (body.days_of_week as unknown[]).map(Number) : [],
      start_time: String(body.start_time ?? ''),
      end_time: String(body.end_time ?? ''),
      capacity: body.capacity === null || body.capacity === '' || body.capacity === undefined ? null : Number(body.capacity),
      active: body.active === undefined ? true : Boolean(body.active),
    });
    return NextResponse.json({ ok: true, block });
  } catch (e) {
    return fail(e, 'Could not save this shift block.');
  }
}

// PATCH — the three capacity controls, all of which leave every assigned shift untouched.
//   { scope: 'team',  team, capacity|null, closed? }             set/clear the team default
//   { scope: 'date',  blockId, date, capacity|null, closed? }    override / close / restore auto
//   { scope: 'block', blockId, active }                          deactivate or restore a block
export async function PATCH(req: Request) {
  const gate = await requireAdmin();
  if ('error' in gate) return gate.error;
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Bad request' }, { status: 400 }); }
  const scope = String(body.scope ?? '');
  const num = (v: unknown) => (v === null || v === undefined || v === '' ? null : Number(v));

  try {
    if (scope === 'team') {
      await setTeamCapacity(gate.user.id, String(body.team ?? ''), num(body.capacity), Boolean(body.closed));
      return NextResponse.json({ ok: true });
    }
    if (scope === 'date') {
      await setBlockDateCapacity(gate.user.id, {
        blockId: String(body.blockId ?? ''),
        date: String(body.date ?? ''),
        capacity: num(body.capacity),
        closed: Boolean(body.closed),
        note: typeof body.note === 'string' ? body.note : null,
      });
      return NextResponse.json({ ok: true });
    }
    if (scope === 'block') {
      await setCapacityBlockActive(gate.user.id, String(body.blockId ?? ''), Boolean(body.active));
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json({ error: "scope must be 'team', 'date' or 'block'" }, { status: 400 });
  } catch (e) {
    return fail(e, 'Could not save this capacity change.');
  }
}
