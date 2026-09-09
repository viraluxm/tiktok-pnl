import Link from 'next/link';
import PracticeModeLauncher from '@/components/training/PracticeModeLauncher';
import { PRACTICE_BACK_HREF, PRACTICE_BACK_LABEL } from '@/lib/training/session';

// Practice Mode launchpad. Admin-gated automatically via (app)/admin/layout.tsx.
// Each created session is a unique UUID that scopes its own host screen,
// controller, Realtime channel and LiveKit room — so multiple practice lives can
// run at the same time without any crossover.
export default function PracticeModePage() {
  return (
    <div className="min-h-[100dvh] bg-tt-bg px-4 py-8 text-tt-text">
      <div className="mx-auto w-full max-w-2xl">
        {/* Practice Mode is reached from the Shows tab, and until now the only way
            back was editing the URL. Returns to that exact tab, not a bare
            /dashboard, so the manager lands where they left. */}
        <Link
          href={PRACTICE_BACK_HREF}
          className="inline-block text-[13px] text-tt-cyan hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-tt-cyan/40"
        >
          {PRACTICE_BACK_LABEL}
        </Link>
        <h1 className="mt-3 text-2xl font-bold">Practice Mode</h1>
        <p className="mt-2 text-tt-muted">
          Train live auction hosts with mock comments, bids, and auction timing. Create a practice
          session, then have the host scan the QR code or open the host link.
        </p>

        <PracticeModeLauncher />

        <p className="mt-8 text-[12px] text-tt-muted">Admin only · Internal training tool</p>
      </div>
    </div>
  );
}
