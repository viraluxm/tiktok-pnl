// WHICH ACCOUNT DOES THIS MACHINE CAPTURE AS?
//
// The relay's eligibility check (see ./relayEligibility) answers "may this user hand a session to
// the capture extension at all?" — is she a store owner. It cannot answer the question that
// actually matters on a warehouse PC: *this* machine captures as *that* account, and nobody else's
// session belongs here. Both the owner and an external seller are store owners; eligibility passes
// them both. So a seller signing into lensed.io in the Chrome profile running our capture
// extension would replace its JWT with theirs, and captures would start writing under their
// user_id — accepted by own-row RLS, invisible to the owner, no error anywhere. That is the
// 2026-07-22 shape.
//
// So the machine gets a binding, and it is TRUST ON FIRST USE:
//
//   • no binding yet + the user is eligible  → BIND to them, and relay. This is what makes the
//     rollout zero-touch: every machine already running captures binds to whoever is signed in
//     there now (the owner) on its next page load. Nothing stops working mid-show.
//   • binding matches the signed-in user     → relay, as before.
//   • binding names someone ELSE             → WITHHOLD, loudly, with an explicit rebind offered.
//     The extension keeps its own token and shows a reconnect state: capture stops VISIBLY rather
//     than continuing under the wrong identity INVISIBLY.
//
// The binding lives in localStorage, which is per browser PROFILE — and a browser profile is
// exactly the unit the hazard lives at. It is not per machine (two profiles on one PC are two
// bindings, correctly) and not per user account.
//
// ─── WHAT THIS DOES NOT DO ───────────────────────────────────────────────────────────────────
// It stops ACCIDENTS, not a determined person, and the difference is worth being precise about:
//
//   1. Anyone who can sign in on the profile can press Rebind. The banner tells them whose machine
//      it is first, so taking it over is a deliberate act with a warning attached — but it is one
//      click, not a permission.
//   2. Clearing site data unbinds the profile, and the next eligible sign-in silently becomes the
//      new binding. There is no mismatch to warn about when there is no binding. A fresh bind is
//      therefore surfaced passively (see BIND_NOTICE_MS) rather than silently.
//   3. If localStorage is unavailable (private window, site data blocked, a thrown accessor), this
//      cannot function at all. It then falls back to eligibility alone — i.e. exactly today's
//      behaviour — rather than withholding, because introducing a new way for capture to die
//      mid-show is worse than leaving an already-existing hazard unchanged in a rare case. It logs
//      loudly. This is also a bypass for anyone who wants one.
//   4. It is client-side. A modified client can do as it likes.
//
// The version with no such holes puts the binding inside the EXTENSION, so the web app cannot lie
// to it about who it is talking to. That needs an extension/ change and its own deploy; this is
// the web-only half, and it closes every accidental path.
//
// Pure and import-free (storage is injected) so it is unit-testable without a DOM.

/** localStorage key. Versioned so a future shape change cannot be misread as a valid binding. */
export const BINDING_KEY = 'lensed.capture.binding.v1';

/** How long a freshly-created binding is announced in the UI. Passive: it never blocks. */
export const BIND_NOTICE_MS = 20_000;

export interface Binding {
  userId: string;
  /** ms epoch. Only used to decide whether a bind is fresh enough to still announce. */
  boundAt: number;
}

/** The minimum of localStorage this module needs. Every method may throw; callers must assume it. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type BindingRead =
  | { state: 'bound'; binding: Binding }
  | { state: 'unbound' }
  /** Storage threw or is absent — NOT the same as unbound; we cannot bind either. */
  | { state: 'unavailable' };

export function readBinding(storage: StorageLike | null | undefined): BindingRead {
  if (!storage) return { state: 'unavailable' };
  let raw: string | null;
  try {
    raw = storage.getItem(BINDING_KEY);
  } catch {
    return { state: 'unavailable' };
  }
  if (!raw) return { state: 'unbound' };
  try {
    const parsed = JSON.parse(raw) as Partial<Binding> | null;
    const userId = typeof parsed?.userId === 'string' ? parsed.userId.trim() : '';
    if (!userId) return { state: 'unbound' }; // malformed → treat as never bound, and rebind
    const boundAt = typeof parsed?.boundAt === 'number' && Number.isFinite(parsed.boundAt) ? parsed.boundAt : 0;
    return { state: 'bound', binding: { userId, boundAt } };
  } catch {
    return { state: 'unbound' };
  }
}

/** Returns the binding it wrote, or null if storage refused it. Never throws. */
export function writeBinding(storage: StorageLike | null | undefined, userId: string, nowMs: number): Binding | null {
  if (!storage) return null;
  const binding: Binding = { userId, boundAt: nowMs };
  try {
    storage.setItem(BINDING_KEY, JSON.stringify(binding));
    return binding;
  } catch {
    return null;
  }
}

export function clearBinding(storage: StorageLike | null | undefined): void {
  if (!storage) return;
  try {
    storage.removeItem(BINDING_KEY);
  } catch {
    /* nothing to clear if we cannot reach storage */
  }
}

export type RelayDecision =
  /** Hand over the token. `bound` is the binding in force (freshly written when `justBound`). */
  | { action: 'relay'; justBound: boolean; boundUserId: string | null }
  /** Do not hand over a token. */
  | { action: 'withhold'; reason: WithholdReason; boundUserId: string | null };

export type WithholdReason =
  /** Not a store owner — the eligibility gate, unchanged. */
  | 'not-eligible'
  /** This profile captures as someone else. The one this module exists for. */
  | 'bound-to-other';

/**
 * The whole decision, in one pure function.
 *
 * `eligible` is the answer from the server-side owner check; this never second-guesses it, because
 * a non-owner must not be able to bind a machine to themselves merely by being first.
 */
export function decideRelay(args: {
  eligible: boolean;
  signedInUserId: string;
  read: BindingRead;
  nowMs: number;
  storage: StorageLike | null | undefined;
}): RelayDecision {
  const { eligible, signedInUserId, read, nowMs, storage } = args;

  // Eligibility first, always. An ineligible session neither relays nor binds — otherwise a
  // non-owner could claim an unbound machine simply by signing in on it before anyone else.
  if (!eligible) return { action: 'withhold', reason: 'not-eligible', boundUserId: null };

  if (read.state === 'unavailable') {
    // Cannot read, so cannot bind. Fall back to eligibility alone — today's behaviour — rather
    // than inventing a new way for capture to stop. See limit 3 in the header.
    return { action: 'relay', justBound: false, boundUserId: null };
  }

  if (read.state === 'bound') {
    if (read.binding.userId === signedInUserId) {
      return { action: 'relay', justBound: false, boundUserId: read.binding.userId };
    }
    return { action: 'withhold', reason: 'bound-to-other', boundUserId: read.binding.userId };
  }

  // Unbound + eligible → trust on first use.
  const written = writeBinding(storage, signedInUserId, nowMs);
  return { action: 'relay', justBound: written !== null, boundUserId: written?.userId ?? null };
}

/** Was this binding created just now (so the UI should say so)? */
export function isFreshBind(binding: Binding | null, nowMs: number): boolean {
  return !!binding && nowMs - binding.boundAt < BIND_NOTICE_MS;
}
