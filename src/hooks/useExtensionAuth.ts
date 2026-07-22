'use client';

import { useEffect } from 'react';
import { createClient } from '@/lib/supabase/client';

/**
 * Relays the Supabase session to the Lensed Chrome extension via
 * chrome.runtime.sendMessage (externally_connectable).
 *
 * ─── Single-refresher COMPAT phase ───
 * Transition state for the single-refresher cutover. This build does BOTH:
 *   • Push (unchanged): relay access + refresh token, so existing v0.4.x extensions
 *     (which self-refresh and read the refresh token) keep working.
 *   • Pull (new): answer the extension's on-demand token request with a fresh access
 *     token from getSession(), so v0.5.0 extensions (which never self-refresh) work.
 * Both extension versions function against this build. The refresh-token relay is
 * removed ONLY in the final phase, after every host is confirmed on v0.5.0.
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

    // Pull responder: the extension (via its content script on this domain) posts
    // { type: 'LENSED_REQUEST_TOKEN' } when its access token 401s. Answer with a
    // fresh access token from the SDK's session (or null so it can show a reconnect
    // state). We never call /auth/v1/token here — getSession() reads the session the
    // SDK already keeps fresh. Added in the compat phase so v0.5.0 extensions can pull;
    // harmless to v0.4.x extensions (they never send it).
    const onMessage = async (event: MessageEvent) => {
      // Only accept same-window, same-origin messages (the content script shares
      // this page's window; reject anything from iframes / other origins).
      if (event.source !== window) return;
      if (event.origin !== window.location.origin) return;
      if (!event.data || event.data.type !== 'LENSED_REQUEST_TOKEN') return;

      const { data: { session } } = await supabase.auth.getSession();
      window.postMessage(
        { type: 'LENSED_TOKEN_RESPONSE', accessToken: session?.access_token ?? null },
        window.location.origin
      );
    };
    window.addEventListener('message', onMessage);

    return () => {
      subscription.unsubscribe();
      window.removeEventListener('message', onMessage);
    };
  }, []);
}
