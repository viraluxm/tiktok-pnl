'use client';

import { useEffect, useRef } from 'react';
import { createClient } from '@/lib/supabase/client';
import {
  afterMint,
  afterPush,
  decide,
  initialState,
  COOLDOWN_MS,
  MAX_MINTS_PER_WINDOW,
  type LimiterState,
} from '@/lib/extension/tokenResponderLimit';

/**
 * Relays the Supabase session to the Lensed Chrome extension via
 * chrome.runtime.sendMessage (externally_connectable).
 *
 * ─── Single-refresher model (final) ───
 * The web app is the ONLY refresher. It relays the ACCESS TOKEN ONLY:
 *   • Push: on sign-in and every TOKEN_REFRESHED, send the fresh access token.
 *   • Pull: answer the extension's LENSED_REQUEST_TOKEN with a fresh access token
 *     from getSession(). We never send the refresh token — an extension that held it
 *     would be a second refresher racing the rotating token (the 2026-07-22 dead-loop).
 * Apply ONLY after every host is confirmed on v0.5.0 (v0.4.x extensions need the
 * refresh relay the compat build still provides).
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
  // Rate-limiter state for the pull responder + the token it last handed out. Refs, not state:
  // nothing here should re-render, and the values must survive across message events.
  const limiter = useRef<LimiterState>(initialState());
  const lastToken = useRef<string | null>(null);

  useEffect(() => {
    const supabase = createClient();

    // Push current session immediately
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) {
        lastToken.current = session.access_token;
        limiter.current = afterPush(limiter.current, Date.now());
        sendToExtension(session.access_token);
      }
    });

    // Push on every auth state change (login, token refresh, logout). Feeding the cache here means
    // a pull inside the cooldown serves the NEWEST token the SDK minted for its own reasons,
    // rather than a stale one — and costs no mint of our own.
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session) {
        lastToken.current = session.access_token;
        limiter.current = afterPush(limiter.current, Date.now());
        sendToExtension(session.access_token);
      }
    });

    // Pull responder: the extension (via its content script on this domain) posts
    // { type: 'LENSED_REQUEST_TOKEN' } when its access token 401s. Answer with a
    // fresh access token from the SDK's session (or null so it can show a reconnect
    // state). We never call /auth/v1/token here — getSession() reads the session the
    // SDK already keeps fresh.
    //
    // RATE LIMITED (see @/lib/extension/tokenResponderLimit). getSession() REFRESHES when the
    // token is inside the 90s expiry margin, so an unbounded responder is an unbounded token
    // minter — and this channel is same-origin postMessage, so ANY script on the page can drive
    // it. Repeat asks inside the cooldown are served from cache; past the per-minute ceiling we
    // stop minting entirely.
    //
    // The message CONTRACT is unchanged: every accepted request still gets exactly one
    // LENSED_TOKEN_RESPONSE. Being throttled means we answer without minting — never that we go
    // silent. Silence would leave lensed-bridge.js hanging until its own 3s timeout and then
    // resolve null anyway, which trips the extension into a reconnect state; a prompt cached
    // answer keeps the pull path working, and a prompt null fails fast instead of slowly.
    const onMessage = async (event: MessageEvent) => {
      // Only accept same-window, same-origin messages (the content script shares
      // this page's window; reject anything from iframes / other origins).
      if (event.source !== window) return;
      if (event.origin !== window.location.origin) return;
      if (!event.data || event.data.type !== 'LENSED_REQUEST_TOKEN') return;

      const reply = (accessToken: string | null) =>
        window.postMessage(
          { type: 'LENSED_TOKEN_RESPONSE', accessToken },
          window.location.origin
        );

      const now = Date.now();
      const decision = decide(limiter.current, now, lastToken.current !== null);

      if (decision.action === 'serve-cached') {
        reply(lastToken.current);
        return;
      }

      if (decision.action === 'throttled') {
        // LOUD on purpose. A silent drop here would look exactly like a healthy quiet period while
        // something on the page hammered the session — the failure mode that produced 99 refreshes
        // in 15 minutes with nothing in any log to show for it.
        console.error(
          `[Lensed→extension] token responder THROTTLED: ${decision.mintsInWindow} mints already ` +
            `in the last minute (ceiling ${MAX_MINTS_PER_WINDOW}, cooldown ${COOLDOWN_MS}ms). ` +
            'Something is requesting tokens in a loop — not minting. ' +
            `Answering with ${lastToken.current ? 'the cached token' : 'null'}.`
        );
        reply(lastToken.current);
        return;
      }

      const { data: { session } } = await supabase.auth.getSession();
      lastToken.current = session?.access_token ?? null;
      limiter.current = afterMint(limiter.current, Date.now());
      reply(lastToken.current);
    };
    window.addEventListener('message', onMessage);

    return () => {
      subscription.unsubscribe();
      window.removeEventListener('message', onMessage);
    };
  }, []);
}
