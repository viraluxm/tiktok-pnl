import { createClient } from '@/lib/supabase/server';

// Stub only. Mirror of the packers stub — renders the signed-in email and the
// resolved role so we can verify va confinement end-to-end. Exists so a va
// session landing on its role home (/va) has a page to render instead of
// redirecting into a 404 loop. No real VA UI yet.
export default async function VaPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Mirror the middleware's role resolution: app_metadata.role, defaulting to
  // 'owner' when unset (owner/admin sessions are unconfined).
  const role = (user?.app_metadata?.role as string | undefined) ?? 'owner';

  return (
    <main style={{ padding: 24, fontFamily: 'ui-monospace, monospace' }}>
      <h1>VA Station</h1>
      <p>Signed in as: {user?.email ?? '—'}</p>
      <p>Resolved role: {role}</p>
    </main>
  );
}
