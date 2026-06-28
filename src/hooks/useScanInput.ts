'use client';

import { useCallback, useEffect, useRef } from 'react';

/**
 * Keyboard-wedge scanner input for /pick and /pack.
 *
 * Ring/PDA scanners act as an HID keyboard: they "type" the barcode characters
 * fast, then send Enter. This hook:
 *  - keeps a hidden, always-focused input alive (re-acquires focus on blur and
 *    after every commit, plus a slow safety re-focus interval),
 *  - buffers characters and commits on Enter,
 *  - uses an inter-char timing threshold so a stray human keystroke can't
 *    accumulate into a fake scan (a real scan burst arrives within `interCharMs`).
 *
 * Returns props to spread onto a visually-minimal <input>, plus focus() to call
 * after rendering a result.
 */
export interface UseScanInputOptions {
  minLength?: number;     // ignore commits shorter than this (default 3)
  interCharMs?: number;   // gap above which we treat input as human typing and reset (default 80ms)
  refocusMs?: number;     // safety re-focus interval (default 1500ms)
  enabled?: boolean;      // pause scanning (e.g. while a modal is open)
}

export function useScanInput(onScan: (code: string) => void, opts: UseScanInputOptions = {}) {
  const { minLength = 3, interCharMs = 80, refocusMs = 1500, enabled = true } = opts;
  const inputRef = useRef<HTMLInputElement | null>(null);
  const buf = useRef('');
  const lastTs = useRef(0);
  const onScanRef = useRef(onScan);
  onScanRef.current = onScan;

  const focus = useCallback(() => {
    if (enabled) inputRef.current?.focus();
  }, [enabled]);

  // Keep focus: re-acquire on a slow interval (covers focus stolen by re-render).
  useEffect(() => {
    if (!enabled) return;
    focus();
    const id = setInterval(focus, refocusMs);
    return () => clearInterval(id);
  }, [enabled, focus, refocusMs]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (!enabled) return;
      const now = Date.now();
      if (e.key === 'Enter') {
        e.preventDefault();
        const code = buf.current.trim();
        buf.current = '';
        if (code.length >= minLength) onScanRef.current(code);
        return;
      }
      if (e.key.length === 1) {
        // A slow gap means a human pressed a key — start fresh so stray keystrokes
        // don't bleed into the next scan burst.
        if (now - lastTs.current > interCharMs) buf.current = '';
        buf.current += e.key;
        lastTs.current = now;
      }
    },
    [enabled, minLength, interCharMs],
  );

  // Props for a hidden/min input. autoFocus + onBlur refocus keep the scanner aimed.
  const inputProps = {
    ref: inputRef,
    onKeyDown,
    onBlur: () => setTimeout(focus, 0),
    autoFocus: true,
    inputMode: 'none' as const,
    'aria-hidden': true,
    tabIndex: -1,
    // visually minimal but still focusable (display:none can't hold focus)
    style: { position: 'absolute', opacity: 0, width: 1, height: 1, pointerEvents: 'none' as const },
  };

  return { inputRef, inputProps, focus };
}
