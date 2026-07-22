'use strict';
/**
 * Lensed bridge content script — runs on the lensed.io web app (and localhost dev).
 *
 * Enables the "pull" token-recovery path. A web page cannot receive an unsolicited
 * message from the extension over externally_connectable, so this content script
 * (which shares the page's window) bridges the two directions:
 *
 *   background → bridge:  chrome.runtime.sendMessage { type: 'LENSED_REQUEST_TOKEN' }
 *   bridge → page:        window.postMessage       { type: 'LENSED_REQUEST_TOKEN' }
 *   page → bridge:        window.postMessage       { type: 'LENSED_TOKEN_RESPONSE', accessToken }
 *   bridge → background:  sendResponse             { accessToken }
 *
 * The page-side responder lives in the web app (useExtensionAuth), which answers
 * from its Supabase session (kept fresh by the SDK). This script never touches the
 * refresh token.
 */

var EXPECTED_ORIGIN = window.location.origin;

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (!message || message.type !== 'LENSED_REQUEST_TOKEN') return;

  var settled = false;

  function finish(accessToken) {
    if (settled) return;
    settled = true;
    window.removeEventListener('message', onWindowMessage);
    clearTimeout(timer);
    sendResponse({ accessToken: accessToken || null });
  }

  function onWindowMessage(event) {
    // Only trust replies from THIS page (same window + same origin).
    if (event.source !== window) return;
    if (event.origin !== EXPECTED_ORIGIN) return;
    if (!event.data || event.data.type !== 'LENSED_TOKEN_RESPONSE') return;
    finish(event.data.accessToken);
  }

  window.addEventListener('message', onWindowMessage);

  // Don't let the background worker hang if the page has no responder (e.g. logged
  // out, or an old web build). Resolve to null → reconnect state.
  var timer = setTimeout(function () { finish(null); }, 3000);

  // Ask the page for a fresh access token.
  window.postMessage({ type: 'LENSED_REQUEST_TOKEN' }, EXPECTED_ORIGIN);

  return true; // async sendResponse
});
