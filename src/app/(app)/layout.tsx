'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { useExtensionAuth } from '@/hooks/useExtensionAuth';

export default function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [checked, setChecked] = useState(false);
  const router = useRouter();

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (!user) {
        router.replace('/login');
      } else {
        setChecked(true);
      }
    });
  }, [router]);

  // Relay Supabase session to Lensed Chrome extension (no-ops if not installed)
  useExtensionAuth();

  if (!checked) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-tt-bg">
        <div className="w-9 h-9 bg-gradient-to-br from-tt-cyan to-[#4F46E5] rounded-[10px] animate-pulse" />
      </div>
    );
  }

  return <>{children}</>;
}
