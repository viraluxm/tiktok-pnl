import { NextResponse } from 'next/server';
import { randomBytes } from 'crypto';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

// Only these two roles are ever created or listed here. The middleware confines
// any unrecognized role to nothing, so we NEVER write a role outside this set —
// a typo would create a locked-out user.
const MANAGED_ROLES = ['member', 'station'] as const;
type ManagedRole = (typeof MANAGED_ROLES)[number];

function isManagedRole(v: unknown): v is ManagedRole {
  return typeof v === 'string' && (MANAGED_ROLES as readonly string[]).includes(v);
}

// The only capability scopes a 'member' may hold. Each maps 1:1 to a /team page + its owner-scoped
// /api/member/* routes in the middleware allowlist — adding a scope means adding it BOTH places.
export const KNOWN_MEMBER_SCOPES = ['binding', 'inventory', 'pnl', 'shows'] as const;

// A non-empty, de-duplicated subset of KNOWN_MEMBER_SCOPES, or null if invalid. Fail closed: an
// unknown scope would confine the member to nothing, so we reject it at write time.
function validMemberScopes(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const set = [...new Set(raw.filter((s): s is string => typeof s === 'string').map((s) => s.trim()))];
  if (set.length === 0) return null;
  if (set.some((s) => !(KNOWN_MEMBER_SCOPES as readonly string[]).includes(s))) return null;
  return set;
}

// Supabase's User type doesn't surface banned_until in its public typings even
// though the admin API returns it; narrow just what we read.
type AdminUser = {
  id: string;
  email?: string;
  last_sign_in_at?: string | null;
  banned_until?: string | null;
  app_metadata?: { role?: string; store_id?: string; stores?: string[]; scopes?: string[] } | null;
};

// GET /api/admin/team — list station/member sub-users only.
export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (user.app_metadata?.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const admin = createAdminClient();

  // Page through every auth user; the admin API caps a page at perPage rows.
  const perPage = 200;
  const all: AdminUser[] = [];
  for (let page = 1; page <= 50; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    const batch = (data?.users ?? []) as unknown as AdminUser[];
    all.push(...batch);
    if (batch.length < perPage) break;
  }

  const members = all
    .filter((u) => isManagedRole(u.app_metadata?.role))
    .map((u) => ({
      id: u.id,
      email: u.email ?? null,
      role: u.app_metadata?.role as ManagedRole,
      // Return whichever assignment shape is present: station carries a single
      // store_id, member carries a stores array.
      store_id: u.app_metadata?.store_id ?? null,
      stores: Array.isArray(u.app_metadata?.stores) ? u.app_metadata!.stores! : null,
      scopes: Array.isArray(u.app_metadata?.scopes) ? u.app_metadata!.scopes! : null,
      last_sign_in_at: u.last_sign_in_at ?? null,
      banned_until: u.banned_until ?? null,
    }));

  return NextResponse.json({ members });
}

// POST /api/admin/team — create a station/member sub-user with a server-generated
// password, returned exactly once in the response.
export async function POST(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (user.app_metadata?.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  let body: { email?: unknown; role?: unknown; stores?: unknown; scopes?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Expected JSON body' }, { status: 400 });
  }

  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const role = body.role;

  if (!email || !email.includes('@')) {
    return NextResponse.json({ error: 'A valid email is required' }, { status: 400 });
  }
  // Fail closed on the role: must be EXACTLY 'member' or 'station'.
  if (!isManagedRole(role)) {
    return NextResponse.json({ error: "role must be 'member' or 'station'" }, { status: 400 });
  }

  const admin = createAdminClient();

  // The store-assignment shape depends on the role:
  //   station → NONE. A warehouse station handles every store, so it is not
  //             store-scoped: app_metadata carries only { role }.
  //   member  → one or more stores, or the '*' sentinel for all stores, plus the capability
  //             scopes it may use (>=1 of KNOWN_MEMBER_SCOPES). Non-'*' ids validated.
  let appMetadata:
    | { role: ManagedRole }
    | { role: ManagedRole; scopes: string[]; stores: string[] };

  if (role === 'station') {
    appMetadata = { role };
  } else {
    const scopes = validMemberScopes(body.scopes);
    if (!scopes) {
      return NextResponse.json(
        { error: `scopes must be a non-empty subset of: ${KNOWN_MEMBER_SCOPES.join(', ')}` },
        { status: 400 },
      );
    }
    const raw: unknown[] = Array.isArray(body.stores) ? body.stores : [];
    const stores = [
      ...new Set(
        raw
          .filter((s): s is string => typeof s === 'string' && s.trim() !== '')
          .map((s) => s.trim()),
      ),
    ];
    if (stores.length === 0) {
      return NextResponse.json({ error: 'stores must be a non-empty array' }, { status: 400 });
    }
    if (stores.includes('*')) {
      // All stores — the '*' sentinel is not a real store id, so skip existence validation.
      appMetadata = { role, scopes, stores: ['*'] };
    } else {
      const { data: found, error: storesErr } = await admin
        .from('stores')
        .select('id')
        .in('id', stores);
      if (storesErr) return NextResponse.json({ error: storesErr.message }, { status: 500 });
      const foundIds = new Set((found ?? []).map((r) => r.id as string));
      const missing = stores.filter((s) => !foundIds.has(s));
      if (missing.length) {
        return NextResponse.json({ error: `unknown store id(s): ${missing.join(', ')}` }, { status: 400 });
      }
      appMetadata = { role, scopes, stores };
    }
  }

  // Server-generated password — shown to the admin once, never stored by us.
  const password = randomBytes(18).toString('base64url');

  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    app_metadata: appMetadata,
  });
  if (createErr) {
    // Duplicate email etc. — surface a 409 for conflicts, 400 otherwise.
    const status = /already|exist|registered/i.test(createErr.message) ? 409 : 400;
    return NextResponse.json({ error: createErr.message }, { status });
  }

  return NextResponse.json({
    ok: true,
    user: { id: created.user?.id, email: created.user?.email, ...appMetadata },
    password,
  });
}
