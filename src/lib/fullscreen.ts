// Browser Fullscreen API helpers — the SAME mechanism the Shipping scan mode uses
// (src/components/shipping/ShippingTab.tsx): requestFullscreen() on documentElement with the
// webkit fallback, denial-tolerant. Extracted so the Time-Clock kiosk reuses the identical
// approach rather than inventing a separate one. UI-only; no attendance/Shift/Pay/RPC logic.
//
// requestFullscreen MUST be called from a real user gesture (a click), never from a delayed
// effect — the entry points below are invoked directly in click handlers.

type FsDocument = Document & {
  webkitExitFullscreen?: () => Promise<void> | void;
  webkitFullscreenElement?: Element | null;
};
type FsElement = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };

export function isFullscreen(): boolean {
  if (typeof document === 'undefined') return false;
  const d = document as FsDocument;
  return !!(d.fullscreenElement || d.webkitFullscreenElement);
}

// Enter fullscreen on the whole document. MUST be called from a user gesture. Returns a promise
// that resolves once the request SETTLES — whether granted or denied — so a caller can await it
// and then navigate regardless (denial is non-fatal; the caller keeps working windowed).
export function enterFullscreen(): Promise<void> {
  if (typeof document === 'undefined') return Promise.resolve();
  const el = document.documentElement as FsElement;
  const req = el.requestFullscreen ?? el.webkitRequestFullscreen;
  try {
    const p = req?.call(el);
    if (p && typeof (p as Promise<void>).then === 'function') {
      return (p as Promise<void>).catch(() => {}); // denial → resolve (non-fatal)
    }
  } catch {
    /* denied — continue windowed */
  }
  return Promise.resolve();
}

// Exit fullscreen if currently active (no-op otherwise). Matches ShippingTab.exitFullscreen.
export function exitFullscreen(): void {
  if (typeof document === 'undefined') return;
  const d = document as FsDocument;
  if (!(d.fullscreenElement || d.webkitFullscreenElement)) return;
  const ex = d.exitFullscreen ?? d.webkitExitFullscreen;
  try {
    const p = ex?.call(d);
    if (p && typeof (p as Promise<void>).catch === 'function') (p as Promise<void>).catch(() => {});
  } catch {
    /* ignore */
  }
}
