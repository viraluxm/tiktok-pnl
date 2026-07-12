'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { isAuthRetryableFetchError } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/client';
import { useExtensionAuth } from '@/hooks/useExtensionAuth';

export default function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [checked, setChecked] = useState(false);
  const router = useRouter();
  const queryClient = useQueryClient();
  const knownUserId = useRef<string | null>(null);
  // Guards against overlapping /login navigations if SIGNED_OUT fires more than
  // once. Reset on a valid signed-in session so a later logout still redirects.
  const signOutRedirecting = useRef(false);

  useEffect(() => {
    const supabase = createClient();

    supabase.auth.getUser().then(({ data: { user }, error }) => {
      if (user) {
        knownUserId.current = user.id;
        setChecked(true);
        return;
      }
      // Transient auth-endpoint failure (network/5xx): the session is likely
      // still valid, so render the shell instead of bouncing to /login. Data is
      // gated server-side (API getUser() + RLS); onAuthStateChange below
      // corrects the UI once connectivity returns. A genuine missing/invalid
      // session (non-retryable error) still redirects.
      if (isAuthRetryableFetchError(error)) {
        setChecked(true);
        return;
      }
      router.replace('/login');
    });

    // React ONLY to a genuine sign-out. auth-js emits SIGNED_OUT solely via
    // _removeSession (a real logout or a non-retryable failed refresh) — never
    // on a transient network blip. Never toggle `checked` back to false or
    // remount the tree on TOKEN_REFRESHED/USER_UPDATED/SIGNED_IN/INITIAL_SESSION,
    // or an hourly token refresh would tear down in-flight UI.
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (event, session) => {
        if (event === 'SIGNED_OUT') {
          // Sole authority for the signed-out redirect + cache clear (UserMenu no
          // longer navigates). Guarded so repeated SIGNED_OUT events cannot start
          // overlapping navigations. Exactly one redirect, no router.refresh().
          if (signOutRedirecting.current) return;
          signOutRedirecting.current = true;
          knownUserId.current = null;
          queryClient.clear();
          router.replace('/login');
          return;
        }
        // A different user signing in on the same tab must not inherit the
        // previous user's cached, user-scoped data.
        if (session?.user) {
          // Signed in with a valid session — allow a future sign-out to redirect.
          signOutRedirecting.current = false;
          const id = session.user.id;
          if (knownUserId.current && knownUserId.current !== id) {
            queryClient.clear();
          }
          knownUserId.current = id;
        }
      }
    );

    return () => subscription.unsubscribe();
  }, [router, queryClient]);

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
