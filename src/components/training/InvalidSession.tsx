import Link from 'next/link';

// Shown by the host and controller pages when ?session= is missing or malformed.
// We fail closed here rather than joining a shared/default room, so two hosts can
// never collide. Server component (no client state needed).
export default function InvalidSession() {
  return (
    <div
      className="fixed inset-0 z-[200] flex flex-col items-center justify-center bg-tt-bg px-6 text-center"
      style={{
        paddingTop: 'env(safe-area-inset-top)',
        paddingBottom: 'env(safe-area-inset-bottom)',
      }}
    >
      <div className="flex max-w-xs flex-col items-center gap-4">
        <p className="text-[15px] font-semibold leading-relaxed text-tt-text">
          Invalid or missing practice session.
        </p>
        <p className="text-[13px] leading-relaxed text-tt-muted">
          Return to Practice Mode and create a new session.
        </p>
        <Link
          href="/admin/training/practice-mode"
          className="mt-2 inline-flex min-h-[48px] items-center justify-center rounded-full bg-[#FE2C55] px-7 text-[15px] font-semibold text-white shadow-lg shadow-[#FE2C55]/30 transition-[filter] duration-200 hover:brightness-110 active:brightness-95 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/80 focus-visible:ring-offset-2 focus-visible:ring-offset-black"
        >
          Go to Practice Mode
        </Link>
      </div>
    </div>
  );
}
