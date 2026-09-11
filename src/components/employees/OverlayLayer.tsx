'use client';

import { createPortal } from 'react-dom';

// A BODY-LEVEL OVERLAY LAYER, so a second overlay opened from inside a first one is actually
// visible.
//
// THE BUG THIS EXISTS TO FIX. Pay Details portals itself to document.body at z-50. The shift
// editor it opens was rendered inline in PayView's subtree, also at z-50. Two `position: fixed`
// elements with the SAME z-index are painted in DOM order, and the portalled panel is the last
// child of <body> while the editor sits deep inside body's first child — so the editor mounted,
// prefilled correctly, and was painted entirely underneath the panel that opened it. Clicking Edit
// looked like it did nothing.
//
// Raising the editor's z-index alone would not have been enough: it lives under the dashboard's
// `backdrop-blur-xl` wrappers, and a filtered ancestor creates a stacking context that traps any
// z-index inside it. The layer has to leave that subtree entirely, which is what the portal does;
// `level` then orders it against the other body-level overlays.
export default function OverlayLayer({
  children,
  level = 60,
}: {
  children: React.ReactNode;
  /** Stacking order among body-level overlays. Pay Details sits at 50; anything it opens is 60. */
  level?: number;
}) {
  // No mount guard needed: callers render this only in response to a click, which cannot happen
  // before hydration, so the portal is never created during SSR.
  if (typeof document === 'undefined') return null;

  return createPortal(
    <div className="relative" style={{ zIndex: level }}>
      {children}
    </div>,
    document.body,
  );
}
