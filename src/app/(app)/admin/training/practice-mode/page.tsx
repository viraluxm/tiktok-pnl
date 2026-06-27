import Link from 'next/link';

// Practice Mode launchpad. Admin-gated automatically via (app)/admin/layout.tsx.
export default function PracticeModePage() {
  return (
    <div className="min-h-[100dvh] bg-tt-bg px-4 py-8 text-tt-text">
      <div className="mx-auto w-full max-w-2xl">
        <h1 className="text-2xl font-bold">Practice Mode</h1>
        <p className="mt-2 text-tt-muted">
          Train live auction hosts with mock comments, bids, and auction timing.
        </p>

        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          <LaunchCard
            title="Host Practice Live"
            description="Open this on the company iPhone before handing it to the trainee."
            href="/admin/training/live-simulator"
            cta="Open Host Screen"
          />
          <LaunchCard
            title="Trainer Controller"
            description="Use this on your laptop or iPad to send comments and bids."
            href="/admin/training/live-simulator/control"
            cta="Open Controller"
          />
        </div>

        <p className="mt-6 text-[12px] text-tt-muted">Admin only · Internal training tool</p>
      </div>
    </div>
  );
}

function LaunchCard({
  title,
  description,
  href,
  cta,
}: {
  title: string;
  description: string;
  href: string;
  cta: string;
}) {
  return (
    <div className="flex flex-col rounded-2xl border border-tt-border bg-tt-card p-5 backdrop-blur-xl">
      <div className="text-base font-semibold text-tt-text">{title}</div>
      <p className="mt-1 flex-1 text-[13px] leading-relaxed text-tt-muted">{description}</p>
      <Link
        href={href}
        className="mt-4 inline-flex min-h-[44px] items-center justify-center rounded-lg bg-gradient-to-r from-tt-cyan to-[#4db8c0] px-5 text-sm font-semibold text-black transition-opacity hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-tt-cyan/50"
      >
        {cta}
      </Link>
    </div>
  );
}
