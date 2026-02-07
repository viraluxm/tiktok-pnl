'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';

export default function Home() {
  const router = useRouter();

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (user) {
        router.replace('/dashboard');
      } else {
        router.replace('/login');
      }
    });
  }, [router]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-tt-bg">
      <div className="w-9 h-9 bg-gradient-to-br from-tt-cyan to-tt-magenta rounded-[10px] animate-pulse" />
    </div>
  );
}
