'use client';

import { useCallback, useEffect, useRef } from 'react';

/**
 * Keyboard-wedge scanner input for /pick and /pack.
 *
 * Ring/PDA scanners act as an HID keyboard: they "type" the barcode characters
 * fast, then send Enter. This hook:
 *  - keeps a hidden, always-focused input alive (re-acquires focus on blur and
 *    after every commit, plus a slow safety re-focus interval),
 *  - commits on Enter using the input's own .value as the SOURCE OF TRUTH — the
 *    browser accumulates the full burst regardless of inter-character timing
 *    jitter (BT/USB-HID latency), so a slow gap mid-burst can't truncate the read,
 *  - only resets on a LONG idle gap at the START of a burst (a stale partial from a
 *    no-Enter misfire), never mid-burst.
 *
 * (A previous version reset a hand-rolled buffer whenever any inter-char gap
 * exceeded ~80ms; a jittery scanner tripped that mid-burst and committed only the
 * post-gap tail — e.g. an 18-digit order id captured as its last 7 digits. Fixed
 * by trusting .value and dropping the mid-burst reset.)
 *
 * Returns props to spread onto a visually-minimal <input>, plus focus() to call
 * after rendering a result.
 */
export interface UseScanInputOptions {
  minLength?: number;     // ignore commits shorter than this (default 3)
  idleResetMs?: number;   // idle gap (start-of-burst only) after which a stale partial is cleared (default 500ms)
  refocusMs?: number;     // safety re-focus interval (default 1500ms)
  enabled?: boolean;      // pause scanning (e.g. while a modal is open)
}

export function useScanInput(onScan: (code: string) => void, opts: UseScanInputOptions = {}) {
  const { minLength = 3, idleResetMs = 500, refocusMs = 1500, enabled = true } = opts;
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
        // SOURCE OF TRUTH: the input's .value holds the full burst (the browser appends every
        // character we don't preventDefault). buf is only a fallback if .value is somehow empty.
        let code = (inputRef.current?.value || '').trim();
        if (!code) code = buf.current.trim();
        buf.current = '';
        if (inputRef.current) inputRef.current.value = '';
        lastTs.current = now;
        if (code.length >= minLength) onScanRef.current(code);
        return;
      }
      if (e.key.length === 1) {
        // Reset ONLY on a long idle gap at the START of a burst (a stale partial left by a
        // no-Enter misfire) — NEVER mid-burst. Mid-burst resets are what truncated jittery scans.
        if (now - lastTs.current > idleResetMs) {
          buf.current = '';
          if (inputRef.current) inputRef.current.value = ''; // cleared before the char's default insert
        }
        buf.current += e.key;
        lastTs.current = now;
      }
    },
    [enabled, minLength, idleResetMs],
  );

  // Props for a hidden/min input. autoFocus + onBlur refocus keep the scanner aimed.
  const inputProps = {
    ref: inputRef,
    onKeyDown,
    onBlur: () => { setTimeout(focus, 0); },
    autoFocus: true,
    inputMode: 'none' as const,
    'aria-hidden': true,
    tabIndex: -1,
    // visually minimal but still focusable (display:none can't hold focus)
    style: { position: 'absolute', opacity: 0, width: 1, height: 1, pointerEvents: 'none' } as React.CSSProperties,
  };

  return { inputRef, inputProps, focus };
}
