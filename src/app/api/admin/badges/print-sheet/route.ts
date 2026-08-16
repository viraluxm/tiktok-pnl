import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { code128ToSvg } from '@/lib/barcode/code128';
import { monogramSvg } from '@/lib/kiosk/monogram';

export const dynamic = 'force-dynamic';

// POST /api/admin/badges/print-sheet — owner-gated. Returns the printable badge sheet as HTML with
// headshots INLINED as base64 data-URIs (fetched server-side via service-role). No signed URLs at
// render → no expiry race that prints an empty circle. Null photo_path → an initials monogram.
// Each badge = photo/monogram + name + role + Code 128-B code. Badge-holders only.
async function requireOwner(): Promise<{ ok: true; ownerId: string } | { ok: false; response: NextResponse }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  const role = user.app_metadata?.role as string | undefined;
  if (role && role !== 'admin') return { ok: false, response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  return { ok: true, ownerId: user.id };
}

function esc(s: string): string {
  return s.replace(/[<>&"']/g, (c) => (c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '&' ? '&amp;' : c === '"' ? '&quot;' : '&#39;'));
}
function mimeOf(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase();
  return ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
}

export async function POST() {
  const gate = await requireOwner();
  if (!gate.ok) return gate.response;
  const admin = createAdminClient();

  const { data: emps, error: e1 } = await admin
    .from('employees').select('id, name, role, photo_path')
    .eq('user_id', gate.ownerId).eq('status', 'active').order('name', { ascending: true });
  if (e1) return NextResponse.json({ error: e1.message }, { status: 500 });

  const { data: badges, error: e2 } = await admin
    .from('employee_badges').select('employee_id, code').eq('user_id', gate.ownerId).eq('active', true);
  if (e2) return NextResponse.json({ error: e2.message }, { status: 500 });
  const codeByEmp = new Map((badges ?? []).map((b) => [String(b.employee_id), String(b.code)]));

  const cards: string[] = [];
  for (const e of emps ?? []) {
    const code = codeByEmp.get(String(e.id));
    if (!code) continue; // only employees with an active badge

    let media: string | null = null;
    const photoPath = (e as { photo_path?: string | null }).photo_path;
    if (photoPath) {
      const { data: blob } = await admin.storage.from('employee-photos').download(String(photoPath));
      if (blob) {
        const b64 = Buffer.from(await blob.arrayBuffer()).toString('base64');
        media = `<img src="data:${mimeOf(String(photoPath))};base64,${b64}" width="96" height="96" style="border-radius:12px;object-fit:cover;" />`;
      }
    }
    if (!media) media = monogramSvg(String(e.name), 96); // never an empty circle

    cards.push(
      `<div style="display:inline-block;width:200px;margin:10px;padding:12px;border:1px solid #ccc;border-radius:10px;text-align:center;page-break-inside:avoid;font-family:sans-serif;">` +
        `<div>${media}</div>` +
        `<div style="font-size:15px;font-weight:600;margin-top:6px;">${esc(String(e.name))}</div>` +
        `<div style="font-size:12px;color:#666;margin-bottom:6px;">${esc(String(e.role ?? ''))}</div>` +
        code128ToSvg(code, { caption: code, moduleWidth: 2, barHeight: 54 }) +
      `</div>`,
    );
  }

  const html =
    `<!doctype html><html><head><meta charset="utf-8"><title>Employee badges</title></head>` +
    `<body style="margin:0;padding:12px;">${cards.join('') || '<p style="font-family:sans-serif">No badge-holders yet.</p>'}</body></html>`;
  return new NextResponse(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}
