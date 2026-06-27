import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';

// Server-side gate for every /admin/* route. Reuses Supabase auth; admin access
// is granted via the user's app_metadata.role === 'admin' (set in Supabase,
// no DB table/migration required).
export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect('/login');
  }
  if (user.app_metadata?.role !== 'admin') {
    redirect('/dashboard');
  }

  return <>{children}</>;
}
