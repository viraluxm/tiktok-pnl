'use client';

import { useEffect } from 'react';
import { createClient } from '@/lib/supabase/client';

/**
 * Relays the Supabase session to the Lensed Chrome extension.
 *
 * ─── Single-refresher model ───
 * The web app is the ONLY thing that ever calls Supabase's /auth/v1/token. The
 * SDK owns refresh-token rotation on its own timer. The extension must NEVER hold
 * or refresh the refresh token — otherwise two independent refreshers race on the
 * rotating token and invalidate each other's session (random logouts on both
 * surfaces). So we relay ONLY the short-lived access token, two ways:
 *   1. Push  — on sign-in and on every TOKEN_REFRESHED, send the fresh access
 *              token to the extension (keeps it current as the SDK rotates).
 *   2. Pull  — when the extension's access token 401s, it asks us for a fresh one;
 *              we answer from getSession() (kept fresh by the SDK). See responder.
 *
 * Push uses chrome.runtime.sendMessage (externally_connectable), which is
 * web→extension only. Pull can't use that channel — a web page cannot receive an
 * unsolicited message from an extension — so the extension's content script posts
 * a window.postMessage into this page and we reply the same way.
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

// Push: relay the ACCESS TOKEN ONLY to the extension. The refresh token is never
// sent — the web app is the single refresher.
function sendToExtension(accessToken: string) {
  try {
    if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) return;
    chrome.runtime.sendMessage(
      LENSED_EXTENSION_ID,
      { type: 'LENSED_AUTH', accessToken },
      // Surface failures instead of swallowing them — a wrong ID / non-matching
      // domain shows "Could not establish connection. Receiving end does not
      // exist." rather than a silent "Not connected".
      () => {
        if (chrome.runtime.lastError) {
          console.warn('[Lensed→extension] relay failed:', chrome.runtime.lastError.message, '(id ' + LENSED_EXTENSION_ID + ')');
        } else {
          console.log('[Lensed→extension] access token relayed to', LENSED_EXTENSION_ID);
        }
      }
    );
  } catch (_) {
    // Not a Chrome browser, or extension API unavailable — ignore.
  }
}

/**
 * Call this hook once in the authenticated app layout.
 * Pushes the access token on mount and on every token refresh, and answers the
 * extension's on-demand token requests.
 */
export function useExtensionAuth() {
  useEffect(() => {
    const supabase = createClient();

    // Push current access token immediately (initial load).
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) {
        sendToExtension(session.access_token);
      }
    });

    // Push on every auth state change that carries a session — this includes
    // SIGNED_IN and, critically, TOKEN_REFRESHED, so the extension always has the
    // latest access token the SDK minted. (No refresh token is ever sent.)
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session) {
        sendToExtension(session.access_token);
      }
    });

    // Pull responder: the extension (via its content script on this domain) posts
    // { type: 'LENSED_REQUEST_TOKEN' } when its access token 401s. Answer with a
    // fresh access token from the SDK's session (or null so it can show a reconnect
    // state). We never call /auth/v1/token here — getSession() reads the session the
    // SDK already keeps fresh.
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
