'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

// Keeps the live board current without the manager pulling to refresh. There is NO Supabase client
// here and no fetch to anything but this route's own server component — the public /s/* routes
// must never establish an auth session (see CLAUDE.md).
export function AutoRefresh({ seconds }: { seconds: number }) {
  const router = useRouter();
  useEffect(() => {
    const id = setInterval(() => router.refresh(), seconds * 1000);
    return () => clearInterval(id);
  }, [router, seconds]);
  return null;
}
