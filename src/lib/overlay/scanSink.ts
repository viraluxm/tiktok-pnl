// When the scanner-driven overlay should pull focus back to its hidden scan input.
//
// THE GAP. PackStationOverlay re-asserts focus only when [screen, box, pickerModalOpen] change.
// Tapping an in-overlay control changes none of them, so focus stays on that button — and the
// scanner's Enter suffix then re-fires it instead of loading a box. On "Grab one" that silently
// double-counts a pick; on "New label" it opens the abandon-confirm prompt mid-box.
//
// This applies to BOTH mounts (the station page and the dashboard Shipping tab) and is entirely
// independent of whether the background behind the overlay is contained — keep it that way.
//
// Import-free on purpose so the predicate is unit-testable without a DOM.

/**
 * Should the reconciler re-focus the hidden scan input right now?
 *
 * Deliberately FALSE while a modal owns focus. The picker gate additionally `disabled`s the input,
 * and focus() on a disabled input is a silent no-op — but relying on that would mean firing a
 * useless call on every keystroke inside the modal, and would steal focus from the picker combobox
 * the instant the input became enabled. The suspension is explicit, not incidental.
 *
 * Also FALSE when the document itself is not focused (tab switched, devtools opened, screen
 * locked): re-focusing then fights the browser and can produce a focus-steal loop.
 */
export function shouldRefocusScanSink(state: {
  documentHasFocus: boolean;
  pickerModalOpen: boolean;
  abandonOpen: boolean;
  activeElementIsSink: boolean;
}): boolean {
  if (!state.documentHasFocus) return false;
  if (state.pickerModalOpen) return false;
  if (state.abandonOpen) return false;
  return !state.activeElementIsSink;
}
