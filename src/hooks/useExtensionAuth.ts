'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
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
import {
  mayRelay,
  resolveRelayEligibility,
  type Eligibility,
} from '@/lib/extension/relayEligibility';
import {
  clearBinding,
  decideRelay,
  readBinding,
  type WithholdReason,
} from '@/lib/extension/captureBinding';

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
 * ─── Who may be relayed ───
 * TWO gates, and they answer different questions.
 *
 *   1. Eligibility (@/lib/extension/relayEligibility, resolved server-side by
 *      /api/ext/relay-eligible): may this user hand a session to the extension AT ALL — i.e. do
 *      they own a store. Fails closed.
 *   2. Capture binding (@/lib/extension/captureBinding): does THIS browser profile capture as
 *      THIS user. Gate 1 passes both the owner and an external seller, because both own stores —
 *      so gate 1 alone cannot stop a seller signing in on a warehouse machine and silently taking
 *      over capture. Gate 2 is what makes a machine belong to one account. Trust on first use, so
 *      existing machines bind to whoever is signed in there now and nothing stops mid-show.
 *
 * A withheld relay means the extension keeps its own token and drops into a reconnect state:
 * capture stops VISIBLY instead of continuing under the wrong identity INVISIBLY.
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
export interface RelayStatus {
  /** null until the first decision has been made. */
  reason: WithholdReason | null;
  /** Who this profile captures as, when we know. */
  boundUserId: string | null;
  /** The signed-in user at the time of the last decision. */
  signedInUserId: string | null;
  /** True for a short window after a fresh trust-on-first-use bind, so the UI can announce it. */
  justBound: boolean;
}

export function useExtensionAuth() {
  // Rate-limiter state for the pull responder + the token it last handed out. Refs, not state:
  // nothing here should re-render, and the values must survive across message events.
  const limiter = useRef<LimiterState>(initialState());
  const lastToken = useRef<string | null>(null);
  // Cached relay eligibility, keyed by the user it was resolved for — a different account signing
  // in on the same page must be re-checked, not inherited. 'unknown' is never cached as an answer.
  const eligibility = useRef<{ userId: string | null; value: Eligibility }>({ userId: null, value: 'unknown' });
  // The in-flight eligibility probe, so a pull that lands during it waits for the verdict instead
  // of being answered 'unknown'. Without this, an extension whose token happens to 401 in the
  // ~200ms after a page load gets a null and drops into a reconnect state until its own recovery
  // alarm comes round a minute later — on the owner's own machine, mid-show.
  const pending = useRef<Promise<Eligibility> | null>(null);

  // Surfaced to the UI (see components/extension/CaptureRelay) so a machine bound to someone else
  // says so on screen, not only in a console nobody has open. State, not a ref: this one renders.
  const [status, setStatus] = useState<RelayStatus>({
    reason: null,
    boundUserId: null,
    signedInUserId: null,
    justBound: false,
  });
  // Bumped by the Rebind button to force the effect to re-run its decision.
  const [rebindNonce, setRebindNonce] = useState(0);

  useEffect(() => {
    const supabase = createClient();
    const storage: Storage | null = typeof window === 'undefined' ? null : window.localStorage;

    const eligibilityFor = async (userId: string): Promise<Eligibility> => {
      const cached = eligibility.current;
      if (cached.userId === userId && cached.value !== 'unknown') return cached.value;
      const probe = resolveRelayEligibility((input, init) => fetch(input, init));
      pending.current = probe;
      const value = await probe;
      eligibility.current = { userId, value };
      return value;
    };

    // The ONE path that hands a token to the extension. Nothing else may write lastToken: an
    // ineligible session must leave the pull responder's cache empty too, or a withheld push would
    // be undone by the very next pull.
    const relay = async (session: { access_token: string; user: { id: string } }) => {
      const value = await eligibilityFor(session.user.id);
      const decision = decideRelay({
        eligible: mayRelay(value),
        signedInUserId: session.user.id,
        read: readBinding(storage),
        nowMs: Date.now(),
        storage,
      });

      if (decision.action === 'withhold') {
        setStatus({
          reason: decision.reason,
          boundUserId: decision.boundUserId,
          signedInUserId: session.user.id,
          justBound: false,
        });
        // LOUD on purpose, and the two reasons need different advice.
        if (decision.reason === 'bound-to-other') {
          console.error(
            `[Lensed→extension] relay WITHHELD: this browser profile captures as ` +
              `${decision.boundUserId}, but ${session.user.id} is signed in. The extension keeps ` +
              'its own token and will show a reconnect state — it will NOT capture under this ' +
              'account. If this machine really should capture as the signed-in user, press Rebind.'
          );
        } else {
          console.error(
            `[Lensed→extension] relay WITHHELD for user ${session.user.id} (${value}). ` +
              'Only a store owner may hand a session to the capture extension.'
          );
        }
        return;
      }

      if (decision.justBound) {
        // A fresh trust-on-first-use bind. Announced rather than silent: an unbound profile has no
        // mismatch to warn about, so this is the only moment a wrong bind is visible.
        console.warn(
          `[Lensed→extension] this browser profile is now bound to capture as ${session.user.id}. ` +
            'Only that account can relay a session here from now on.'
        );
      }
      setStatus({
        reason: null,
        boundUserId: decision.boundUserId,
        signedInUserId: session.user.id,
        justBound: decision.justBound,
      });
      lastToken.current = session.access_token;
      limiter.current = afterPush(limiter.current, Date.now());
      sendToExtension(session.access_token);
    };

    // Push current session immediately
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) void relay(session);
    });

    // Push on every auth state change (login, token refresh, logout). Feeding the cache here means
    // a pull inside the cooldown serves the NEWEST token the SDK minted for its own reasons,
    // rather than a stale one — and costs no mint of our own.
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session) {
        void relay(session);
        return;
      }
      // Signed out: drop both the cached token and the eligibility verdict. Serving either to a
      // pull after sign-out would answer for an identity that is no longer here.
      lastToken.current = null;
      eligibility.current = { userId: null, value: 'unknown' };
      // The BINDING deliberately survives sign-out: it says which account this machine captures
      // as, which does not change because somebody logged out. Only Rebind changes it.
      setStatus({ reason: null, boundUserId: null, signedInUserId: null, justBound: false });
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

      // Ineligible → null, before any getSession() call. Answering from the limiter's cache here
      // would leak a token the push path deliberately withheld, and calling getSession() to
      // re-derive the user would mint one for an account that may not have it. lastToken is only
      // ever populated by an eligible relay, so this is belt and braces — kept because the two
      // paths must not drift. A verdict still in flight is waited on rather than refused.
      let verdict = eligibility.current.value;
      if (verdict === 'unknown' && pending.current) verdict = await pending.current;
      if (!mayRelay(verdict)) {
        reply(null);
        return;
      }

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
  }, [rebindNonce]);

  // Deliberate takeover: drop the binding and re-run the decision, which re-binds to whoever is
  // signed in now (if they are eligible). One click, but never an accident — the banner names the
  // account it is taking the machine from before offering this.
  const rebind = useCallback(() => {
    if (typeof window !== 'undefined') clearBinding(window.localStorage);
    setRebindNonce((n) => n + 1);
  }, []);

  return { status, rebind };
}
