'use client';

import { createPortal } from 'react-dom';

// A hover tooltip rendered through a PORTAL to document.body.
//
// This is not incidental. A `position: fixed` element is positioned relative to the nearest
// ancestor with a filter/transform/backdrop-filter, NOT the viewport — and the Team panels use
// `backdrop-blur-xl`. Inside that ancestor the card was laid out against the panel box and drawn
// under the day cells, which is why it read as a faint smear behind the avatars. Portalling to
// body escapes every such ancestor, so `fixed` means fixed again.

export interface HoverPayload {
  x: number;      // viewport px — the centre of the element being hovered
  y: number;      // viewport px — its top edge; the card sits above this
  head: string;
  lines: string[];
}

// Keep the whole card on screen: it is centred on the anchor, so one at the left edge of the
// window would otherwise hang off it.
const HALF_W = 130;

export default function HoverCard({ hover }: { hover: HoverPayload | null }) {
  // No mount guard needed: `hover` is null on the server and on the first client render (it is
  // only ever set by a pointer/focus event, which cannot fire before hydration), so the portal is
  // never created during SSR and there is nothing to mismatch.
  if (!hover || typeof document === 'undefined') return null;

  const left = Math.min(Math.max(hover.x, HALF_W), window.innerWidth - HALF_W);
  // Flip below the anchor when there is no room above it.
  const above = hover.y > 90;

  return createPortal(
    <div
      className="pointer-events-none fixed z-[9999] max-w-[260px] rounded-lg border border-white/15 bg-[#141414] px-2.5 py-1.5 shadow-2xl"
      style={{
        left,
        top: above ? hover.y - 8 : hover.y + 34,
        transform: `translateX(-50%)${above ? ' translateY(-100%)' : ''}`,
      }}
      role="tooltip"
    >
      <div className="whitespace-nowrap text-[11px] font-semibold text-tt-text">{hover.head}</div>
      {hover.lines.map((line) => (
        <div key={line} className="whitespace-nowrap text-[10px] tabular-nums text-tt-muted">{line}</div>
      ))}
    </div>,
    document.body,
  );
}
