import PracticeModeLauncher from '@/components/training/PracticeModeLauncher';

// Practice Mode launchpad. Admin-gated automatically via (app)/admin/layout.tsx.
// Each created session is a unique UUID that scopes its own host screen,
// controller, Realtime channel and LiveKit room — so multiple practice lives can
// run at the same time without any crossover.
export default function PracticeModePage() {
  return (
    <div className="min-h-[100dvh] bg-tt-bg px-4 py-8 text-tt-text">
      <div className="mx-auto w-full max-w-2xl">
        <h1 className="text-2xl font-bold">Practice Mode</h1>
        <p className="mt-2 text-tt-muted">
          Train live auction hosts with mock comments, bids, and auction timing. Create a session
          to open a host screen (for the company iPhone) and its matching controller.
        </p>

        <PracticeModeLauncher />

        <p className="mt-8 text-[12px] text-tt-muted">Admin only · Internal training tool</p>
      </div>
    </div>
  );
}
