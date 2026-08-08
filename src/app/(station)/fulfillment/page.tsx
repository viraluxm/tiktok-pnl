import { createClient } from '@/lib/supabase/server';

// Stub only. Renders the signed-in email and the resolved role so we can verify
// the middleware confinement end-to-end before building the real station UI.
// No store dropdown, no PIN entry, no scanner yet.
export default async function FulfillmentPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Mirror the middleware's role resolution: app_metadata.role, defaulting to
  // 'owner' when unset (owner/admin sessions are unconfined).
  const role = (user?.app_metadata?.role as string | undefined) ?? 'owner';

  return (
    <main style={{ padding: 24, fontFamily: 'ui-monospace, monospace' }}>
      <h1>Fulfillment Station</h1>
      <p>Signed in as: {user?.email ?? '—'}</p>
      <p>Resolved role: {role}</p>
    </main>
  );
}
