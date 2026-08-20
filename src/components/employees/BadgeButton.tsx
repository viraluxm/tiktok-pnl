'use client';

import { useState } from 'react';
import type { ActiveBadge } from '@/hooks/useBadges';

// Open the server-built badge sheet (data-URI headshots + Code 128 + monogram fallback) in a print
// window — the same sheet BadgeAdmin uses.
export async function openBadgePrintSheet(): Promise<boolean> {
  const res = await fetch('/api/admin/badges/print-sheet', { method: 'POST' });
  if (!res.ok) return false;
  const html = await res.text();
  const w = window.open('', '_blank');
  if (!w) return false;
  w.document.write(html);
  w.document.close();
  w.focus();
  w.print();
  return true;
}

// Roster ACTIONS button, matching ScheduleLinkButton. No active badge → "Issue badge"; active badge
// → "Reissue badge" (confirms the printed card stops working immediately, then offers the sheet).
export function BadgeButton({
  employeeId,
  badge,
  onIssue,
  onReissue,
}: {
  employeeId: string;
  badge: ActiveBadge | null;
  onIssue: (employeeId: string) => Promise<void>;
  onReissue: (employeeId: string, badgeId: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function handleClick() {
    if (busy) return;
    setFailed(false);

    if (badge) {
      if (
        !window.confirm(
          'Reissue this badge?\n\nThe existing printed card STOPS WORKING immediately and cannot be used again — you must reprint the card with the new code.',
        )
      ) {
        return;
      }
      setBusy(true);
      try {
        await onReissue(employeeId, badge.id);
      } catch {
        setFailed(true);
        setBusy(false);
        return;
      }
    } else {
      setBusy(true);
      try {
        await onIssue(employeeId);
      } catch {
        setFailed(true);
        setBusy(false);
        return;
      }
    }

    setBusy(false);
    if (window.confirm('Badge ready. Print the badge sheet now?')) {
      await openBadgePrintSheet();
    }
  }

  const label = failed ? 'Failed' : busy ? (badge ? 'Reissuing…' : 'Issuing…') : badge ? 'Reissue badge' : 'Issue badge';
  return (
    <button
      onClick={handleClick}
      disabled={busy}
      className={`px-3 py-1.5 rounded-lg text-[11px] font-semibold transition-colors disabled:opacity-50 ${
        failed ? 'bg-tt-red/15 text-tt-red' : 'bg-white/5 text-tt-text hover:bg-white/10'
      }`}
    >
      {label}
    </button>
  );
}
