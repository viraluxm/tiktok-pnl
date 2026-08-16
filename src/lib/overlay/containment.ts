// Background containment for the full-screen overlay — `inert` on everything behind it.
//
// ─── SCOPE: THIS IS DASHBOARD-ONLY DEFENCE ───
// It exists for the (app) Shipping-tab mount, where the overlay portals over live app chrome: a
// scanner Tab suffix walks focus into the dashboard tab buttons behind the overlay, and the next
// Enter fires setActiveView(), unmounting ShippingTab and taking the overlay with it mid-pick.
//
// It does NOT fix the station route. /fulfillment renders under a bare layout with no links, no
// nav and no tab bar — a grep for next/link, <a>, useRouter, router.*, location.href and
// window.open across the whole (station) tree plus this overlay returns nothing. There is simply
// nowhere for focus to escape TO, so inerting there protects against nothing. What actually takes
// an operator off that route is the browser itself (Android back gesture, tab discard, browser
// chrome left visible because fullscreen never engaged) — addressed separately by the fullscreen
// work, not here.
//
// So the caller opts in: ShippingTab passes containBackground, the station page does not. Keeping
// it off on /fulfillment also removes any chance of inerting that page's portalled mode chip.
//
// The pure selection rule is separated from the DOM writes so it is testable without jsdom.

/**
 * Marks a <body> child that must STAY interactive while the overlay is mounted, for callers that
 * DO opt into containment. Anything portalled to <body> as a sibling of the overlay — a mode chip,
 * a confirmation dialog — needs it, or it becomes unreachable with no visible cause.
 */
export const OVERLAY_EXEMPT_ATTR = 'data-overlay-exempt';

/** The minimum element surface these predicates need (keeps them testable without a DOM). */
export interface ElementLike {
  hasAttribute(name: string): boolean;
}

/**
 * Should this <body> child be made inert while the overlay is up?
 * Everything except the overlay's own container and anything explicitly exempted.
 */
export function shouldInert(el: ElementLike, container: ElementLike | null): boolean {
  if (container !== null && el === container) return false;
  return !el.hasAttribute(OVERLAY_EXEMPT_ATTR);
}

/** Which of these elements should be inerted. Pure, so the exempt carve-out is unit-testable. */
export function selectInertTargets<T extends ElementLike>(
  children: readonly T[],
  container: ElementLike | null,
): T[] {
  return children.filter((el) => shouldInert(el, container));
}

/**
 * Make every <body> child inert except `container` and anything carrying data-overlay-exempt.
 * Returns a restore function that puts each element back exactly as it was FOUND — including
 * elements that were already inert for their own reasons, which must stay inert on restore.
 *
 * Idempotent: calling the returned function twice is harmless, so the unmount cleanup and the
 * pagehide fallback can both run.
 */
export function applyBackgroundInert(container: HTMLElement): () => void {
  if (typeof document === 'undefined') return () => {};
  let record: Array<{ el: HTMLElement; wasInert: boolean }> | null = [];

  const htmlChildren = Array.from(document.body.children).filter(
    (c): c is HTMLElement => c instanceof HTMLElement,
  );
  for (const child of selectInertTargets(htmlChildren, container)) {
    record.push({ el: child, wasInert: child.hasAttribute('inert') });
    child.setAttribute('inert', '');
  }

  return () => {
    if (!record) return;
    for (const { el, wasInert } of record) {
      if (!wasInert) el.removeAttribute('inert');
    }
    record = null;
  };
}
