'use client';

import { useEffect, useState } from 'react';
import { useExtensionAuth } from '@/hooks/useExtensionAuth';
import { BIND_NOTICE_MS } from '@/lib/extension/captureBinding';

// Mounts the capture-extension relay, and shows the one thing that must not stay in a console:
// this browser profile is bound to capture as somebody else.
//
// WHY A COMPONENT. The relay used to be a bare useExtensionAuth() call inside (app)/layout.tsx,
// which meant only the (app) tree had it — and the (seller) group deliberately did not, because
// relaying a seller's session on a warehouse machine would silently take over capture. With the
// capture binding in place that is no longer the reason it must be absent: a machine belongs to
// one account, so a seller's own machine can hold its own binding and a warehouse machine refuses
// them. One component, mounted in both trees, so the gates and the banner can never diverge
// between them.
//
// Renders null in the normal case. It is not a layout element.
export default function CaptureRelay() {
  const { status, rebind } = useExtensionAuth();
  // Which bind has already had its say. Derived rather than reset: the effect below must not call
  // setState synchronously (cascading renders), so the ONLY setState here is inside the timer.
  const [expiredFor, setExpiredFor] = useState<string | null>(null);
  const bindKey = status.boundUserId ?? '';

  // A fresh bind is announced briefly, then stops nagging. It is information, not a problem.
  useEffect(() => {
    if (!status.justBound) return;
    const t = setTimeout(() => setExpiredFor(bindKey), BIND_NOTICE_MS);
    return () => clearTimeout(t);
  }, [status.justBound, bindKey]);

  const showBindNotice = status.justBound && expiredFor !== bindKey;

  // 'not-eligible' is deliberately NOT surfaced here: it is the normal state for every account
  // that is not a store owner, on every page they load. A banner for it would be noise on screens
  // that have nothing to do with capture. It is logged, and it withholds — that is enough.
  if (status.reason === 'bound-to-other') {
    return (
      <div
        role="alert"
        className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 max-w-xl w-[calc(100%-2rem)] rounded-xl border border-tt-red/40 bg-tt-card shadow-lg px-4 py-3"
      >
        <div className="text-[13px] font-semibold text-tt-red mb-1">
          Capture is paused on this computer
        </div>
        <p className="text-[12px] text-tt-muted leading-relaxed">
          This browser profile captures for a different account, so the extension has not been
          given this session — it will show as disconnected rather than record sales under the
          wrong account. If you are signed in as yourself on your own machine, rebind it.
        </p>
        <div className="mt-2 flex items-center gap-2 flex-wrap">
          <button
            onClick={rebind}
            className="px-3 py-1 rounded-lg text-[11px] font-semibold bg-tt-red/15 text-tt-red hover:bg-tt-red/25 transition-colors"
          >
            Rebind this computer to me
          </button>
          <span className="text-[10px] text-tt-muted">
            Captures for {status.boundUserId?.slice(0, 8) ?? 'another account'}… · signed in as{' '}
            {status.signedInUserId?.slice(0, 8) ?? '—'}…
          </span>
        </div>
      </div>
    );
  }

  if (showBindNotice) {
    return (
      <div
        role="status"
        className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 max-w-xl w-[calc(100%-2rem)] rounded-xl border border-tt-border bg-tt-card shadow-lg px-4 py-2.5"
      >
        <p className="text-[12px] text-tt-muted leading-relaxed">
          <span className="text-tt-text font-semibold">This computer now captures for you.</span>{' '}
          Only your account can hand a session to the capture extension here from now on. If that
          is wrong, sign in as the right account and rebind.
        </p>
      </div>
    );
  }

  return null;
}
