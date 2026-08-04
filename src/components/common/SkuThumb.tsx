'use client';

import { useState } from 'react';

// Small fixed-size SKU thumbnail with a clean empty/placeholder state.
//
// Extracted verbatim (size + fallback treatment) from the Inventory table's old inline `Thumb`
// so the Inventory rows, pack/pick stations, and the bind editor all share ONE pattern. The box
// is a fixed 36×36 (w-9 h-9) that renders whether or not there's an image, so row heights never
// shift between rows with and without photos.
//
// Two behaviours layered on top of the original:
//   1. `failed` is React state (not a DOM `display:none` mutation) so callers can know whether an
//      image actually loaded — we never open a lightbox on a broken or missing image.
//   2. When `onEnlarge` is supplied AND a real image is showing, the thumb becomes a real
//      <button> (cursor-zoom-in) that calls `onEnlarge(url, label)`. The click is stopped from
//      propagating/defaulting so it can never trigger a parent row's select handler. Omit
//      `onEnlarge` (the default) and the thumb is a plain, non-interactive box — exactly today's
//      Inventory behaviour.
export default function SkuThumb({
  url,
  onEnlarge,
  enlargeLabel,
}: {
  url: string | null;
  onEnlarge?: (url: string, label?: string) => void;
  enlargeLabel?: string;
}) {
  const [failed, setFailed] = useState(false);
  const box =
    'w-9 h-9 shrink-0 rounded-md border border-tt-border bg-tt-input-bg overflow-hidden flex items-center justify-center';
  const showImage = !!url && !failed;
  const inner = showImage ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={url!}
      alt=""
      loading="lazy"
      className="w-full h-full object-cover"
      onError={() => setFailed(true)}
    />
  ) : (
    <span className="text-tt-muted text-[10px]">—</span>
  );

  // Only interactive when a real image is showing AND a handler was given. Missing/broken photos
  // stay plain boxes: no button, no zoom cursor, no focus ring.
  if (showImage && onEnlarge) {
    return (
      <button
        type="button"
        onClick={(e) => {
          // Never let a thumb click bubble to the row's select/bind handler.
          e.preventDefault();
          e.stopPropagation();
          onEnlarge(url!, enlargeLabel);
        }}
        aria-label={enlargeLabel ? `Enlarge photo for ${enlargeLabel}` : 'Enlarge photo'}
        tabIndex={-1}
        className={`${box} p-0 cursor-zoom-in`}
      >
        {inner}
      </button>
    );
  }

  return <div className={box}>{inner}</div>;
}
