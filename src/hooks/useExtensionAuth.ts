'use client';

import { useEffect } from 'react';
import { createClient } from '@/lib/supabase/client';

/**
 * Relays the Supabase session to the Lensed Chrome extension via
 * chrome.runtime.sendMessage (externally_connectable).
 *
 * Silently no-ops if the extension isn't installed or the ID doesn't match.
 *
 * ─── IMPORTANT ───
 * LENSED_EXTENSION_ID must match the extension's ID shown on chrome://extensions
 * after loading unpacked. A mismatch makes the relay silently fail.
 * In production this would come from an env var; hardcoded here for dev.
 */
const LENSED_EXTENSION_ID = 'lmmlohbjhdagndahchljlckannhhlngk';

function sendToExtension(accessToken: string, refreshToken: string) {
  try {
    if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) return;
    chrome.runtime.sendMessage(
      LENSED_EXTENSION_ID,
      { type: 'LENSED_AUTH', accessToken, refreshToken },
      // Callback swallows errors (extension not installed, ID wrong, etc.)
      () => { if (chrome.runtime.lastError) { /* expected if extension absent */ } }
    );
  } catch (_) {
    // Not a Chrome browser, or extension API unavailable — ignore.
  }
}

/**
 * Call this hook once in the authenticated app layout.
 * It pushes the current session on mount and on every token refresh.
 */
export function useExtensionAuth() {
  useEffect(() => {
    const supabase = createClient();

    // Push current session immediately
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) {
        sendToExtension(session.access_token, session.refresh_token);
      }
    });

    // Push on every auth state change (login, token refresh, logout)
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session) {
        sendToExtension(session.access_token, session.refresh_token);
      }
    });

    return () => subscription.unsubscribe();
  }, []);
}
