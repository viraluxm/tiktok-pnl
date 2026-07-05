'use client';

import { useEffect, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { useExtensionAuth } from '@/hooks/useExtensionAuth';

// Route confinement (chunk 10). FAIL-SAFE: default to full access; confine ONLY an account
// explicitly tagged account_type='fulfillment' (the shared device account) to the device
// routes below. Store/owner logins (and any null/missing/error) get the full surface.
const DEVICE_PATHS = ['/fulfillment', '/pick', '/pack']; // where a confined fulfillment account may go
const PUBLIC_PROVISION = '/fulfillment/provision';        // device entry — reachable with NO session

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const [checked, setChecked] = useState(false);
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    // A fresh device has no session yet — the provisioning page must load publicly.
    if (pathname === PUBLIC_PROVISION) { setChecked(true); return; }

    const supabase = createClient();
    let cancelled = false;
    supabase.auth.getUser().then(async ({ data: { user } }) => {
      if (cancelled) return;
      if (!user) { router.replace('/login'); return; }

      // FAIL-SAFE: confine ONLY on an explicit 'fulfillment' tag; anything else → full access.
      let confined = false;
      try {
        const { data: prof } = await supabase.from('profiles').select('account_type').eq('id', user.id).maybeSingle();
        confined = prof?.account_type === 'fulfillment';
      } catch {
        confined = false; // error → fail open (never lock out)
      }
      if (cancelled) return;

      if (confined) {
        const allowed = DEVICE_PATHS.some((p) => pathname === p || pathname.startsWith(p + '/'));
        if (!allowed) { router.replace('/fulfillment'); return; } // device account off its routes → back to device home
      }
      setChecked(true);
    });
    return () => { cancelled = true; };
  }, [router, pathname]);

  // Relay Supabase session to the Lensed Chrome extension (no-ops if not installed / no session)
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
