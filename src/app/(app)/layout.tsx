'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';

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

  if (!checked) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-tt-bg">
        <div className="w-9 h-9 bg-gradient-to-br from-tt-cyan to-tt-magenta rounded-[10px] animate-pulse" />
      </div>
    );
  }

  return <>{children}</>;
}
