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
 * LENSED_EXTENSION_ID must match the extension's ID. The extension now pins a
 * fixed ID via a `key` in manifest.json, so every unpacked install derives the
 * SAME id below — the relay reaches all members, not just the owner's original
 * install. Override per-environment with NEXT_PUBLIC_LENSED_EXTENSION_ID.
 */
const LENSED_EXTENSION_ID =
  process.env.NEXT_PUBLIC_LENSED_EXTENSION_ID || 'mdfjfepjpnhidnfpeghkpgdjpcjehbpg';

function sendToExtension(accessToken: string, refreshToken: string) {
  try {
    if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) return;
    chrome.runtime.sendMessage(
      LENSED_EXTENSION_ID,
      { type: 'LENSED_AUTH', accessToken, refreshToken },
      // Surface failures instead of swallowing them — a wrong ID / non-matching
      // domain shows "Could not establish connection. Receiving end does not
      // exist." rather than a silent "Not connected".
      () => {
        if (chrome.runtime.lastError) {
          console.warn('[Lensed→extension] relay failed:', chrome.runtime.lastError.message, '(id ' + LENSED_EXTENSION_ID + ')');
        } else {
          console.log('[Lensed→extension] session relayed to', LENSED_EXTENSION_ID);
        }
      }
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
