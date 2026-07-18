'use client';

import { useEffect, useState } from 'react';
import { isAuthRetryableFetchError } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/client';
import type { User } from '@supabase/supabase-js';

export function useUser() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const supabase = createClient();

  useEffect(() => {
    let active = true;
    const getUser = async () => {
      const { data: { user }, error } = await supabase.auth.getUser();
      if (!active) return;
      // Don't flip a known user to null on a transient auth-endpoint failure —
      // that's what made the header show "User" on a network blip. Only a
      // definitive result updates: a real user, or a non-retryable "no session".
      if (user) {
        setUser(user);
      } else if (!isAuthRetryableFetchError(error)) {
        setUser(null);
      }
      setLoading(false);
    };
    getUser();

    // Genuine transitions still come through here (SIGNED_OUT clears the user,
    // TOKEN_REFRESHED/SIGNED_IN set it); transient network failures emit no event.
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
    });

    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, [supabase.auth]);

  return { user, loading };
}
