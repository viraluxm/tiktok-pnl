'use client';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// Realtime for a PUBLIC, TOKENISED page — with no Supabase auth session, ever.
//
// THIS IS THE WHOLE POINT, SO READ BEFORE CHANGING IT. CLAUDE.md forbids a
// tokenised route from establishing a Supabase auth session: the capture extension
// relays whatever session it observes on a machine, so a second session causes
// captures to be written under the wrong user_id — silently, with no error, and
// invisible to the real owner. That is the 2026-07-22 incident.
//
// So this deliberately does NOT use createBrowserClient() from @supabase/ssr, which
// is what the rest of the app uses: that helper reads and writes the auth cookie.
// This uses the plain supabase-js client with persistSession, autoRefreshToken and
// detectSessionInUrl all OFF. It holds nothing but the anon key, writes no cookie
// and no localStorage entry, and never calls signIn. Nothing about it can become a
// session.
//
// It is used ONLY for Realtime broadcast on a public channel — comments and bids
// relayed from the trainer's controller. It reads no tables; every database read or
// write on a tokenised page goes through /api/host/<token>/*, service-role and
// explicitly scoped server-side.
export function createPublicRealtimeClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://placeholder.supabase.co';
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'placeholder-key';
  return createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}
