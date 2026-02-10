'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { useDemo } from '@/lib/demo/context';
import { DEMO_USER_EMAIL } from '@/lib/demo/data';

export default function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [checked, setChecked] = useState(false);
  const router = useRouter();
  const { isDemo, enterDemo } = useDemo();

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (!user) {
        router.replace('/login');
      } else {
        // Auto-detect demo account on page load / refresh
        if (user.email?.toLowerCase() === DEMO_USER_EMAIL.toLowerCase() && !isDemo) {
          enterDemo();
        }
        setChecked(true);
      }
    });
  }, [router, isDemo, enterDemo]);

  if (!checked) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-tt-bg">
        <div className="w-9 h-9 bg-gradient-to-br from-tt-cyan to-[#4F46E5] rounded-[10px] animate-pulse" />
      </div>
    );
  }

  return <>{children}</>;
}
