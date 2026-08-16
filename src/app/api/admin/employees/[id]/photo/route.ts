import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

const MAX_BYTES = 3 * 1024 * 1024; // 3 MB
const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

// POST /api/admin/employees/[id]/photo — owner-gated, server-mediated headshot upload. Validates
// type + size, writes to the private employee-photos bucket at {owner}/{employee_id}.<ext> (owner
// folder, service-role), and stores the object PATH on employees.photo_path. Reads are served as
// data-URIs by the print-sheet route; the raw object is never publicly reachable.
async function requireOwner(): Promise<{ ok: true; ownerId: string } | { ok: false; response: NextResponse }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  const role = user.app_metadata?.role as string | undefined;
  if (role && role !== 'admin') return { ok: false, response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  return { ok: true, ownerId: user.id };
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireOwner();
  if (!gate.ok) return gate.response;
  const { id } = await params;

  const admin = createAdminClient();
  const { data: emp, error: e0 } = await admin
    .from('employees').select('id').eq('id', id).eq('user_id', gate.ownerId).maybeSingle();
  if (e0) return NextResponse.json({ error: e0.message }, { status: 500 });
  if (!emp) return NextResponse.json({ error: 'Employee not found' }, { status: 404 });

  let form: FormData;
  try { form = await req.formData(); } catch { return NextResponse.json({ error: 'Expected multipart form' }, { status: 400 }); }
  const file = form.get('file');
  if (!(file instanceof File)) return NextResponse.json({ error: 'file required' }, { status: 400 });
  if (!EXT[file.type]) return NextResponse.json({ error: 'image must be JPEG, PNG, or WebP' }, { status: 400 });
  if (file.size > MAX_BYTES) return NextResponse.json({ error: 'image too large (max 3 MB)' }, { status: 400 });

  const buf = Buffer.from(await file.arrayBuffer());
  const path = `${gate.ownerId}/${id}.${EXT[file.type]}`;
  const { error: upErr } = await admin.storage
    .from('employee-photos')
    .upload(path, buf, { contentType: file.type, upsert: true });
  if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 });

  const { error: updErr } = await admin
    .from('employees')
    .update({ photo_path: path, updated_at: new Date().toISOString() })
    .eq('id', id).eq('user_id', gate.ownerId);
  if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
